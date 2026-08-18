param(
  [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[repair] $Message" -ForegroundColor Cyan
}

function Remove-PathWithHeartbeat {
  param(
    [Parameter(Mandatory = $true)][string]$TargetPath
  )

  $job = Start-Job -ScriptBlock {
    param($p)
    Remove-Item -LiteralPath $p -Recurse -Force
  } -ArgumentList $TargetPath

  $startedAt = Get-Date
  while ($job.State -eq "Running") {
    $elapsed = [int]((Get-Date) - $startedAt).TotalSeconds
    Write-Host "[repair] Deleting... ${elapsed}s elapsed" -ForegroundColor DarkGray
    Start-Sleep -Seconds 3
    $job = Get-Job -Id $job.Id -ErrorAction SilentlyContinue
    if (-not $job) {
      break
    }
  }

  if ($job) {
    $jobResult = Receive-Job -Id $job.Id -ErrorAction Stop
    Remove-Job -Id $job.Id -Force
  }
}

function Test-PathPattern {
  param(
    [Parameter(Mandatory = $true)][string]$Pattern
  )

  $items = Get-ChildItem -Path $Pattern -ErrorAction SilentlyContinue
  return $null -ne $items
}

function Find-ProjectRoot {
  param(
    [Parameter(Mandatory = $true)][string[]]$StartDirs
  )

  foreach ($start in $StartDirs) {
    if (-not (Test-Path $start)) {
      continue
    }

    $current = Resolve-Path $start
    while ($true) {
      if (Test-Path (Join-Path $current "pnpm-lock.yaml")) {
        return $current
      }

      $parent = Split-Path -Parent $current
      if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {
        break
      }
      $current = $parent
    }
  }

  return $null
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Find-ProjectRoot -StartDirs @($scriptDir, (Get-Location).Path)
if (-not $projectRoot) {
  throw "Cannot locate project root (missing pnpm-lock.yaml). Put this script inside the project and run again."
}
Set-Location $projectRoot

Write-Step "Project root: $projectRoot"

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm not found. Install pnpm first, then run this script again."
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not found. Install Node.js first, then run this script again."
}

if (-not (Test-Path "pnpm-lock.yaml")) {
  throw "pnpm-lock.yaml not found. Please run this script from inside the project."
}

$requiredPaths = @(
  @{
    Name = "pnpm virtual store"
    Pattern = "node_modules\.pnpm"
  },
  @{
    Name = "astro package"
    Pattern = "node_modules\astro\package.json"
  },
  @{
    Name = "astro CLI entry"
    Pattern = "node_modules\astro\dist\cli\index.js"
  },
  @{
    Name = "astro Windows command shim"
    Pattern = "node_modules\.bin\astro.ps1"
  }
)

if ($VerifyOnly) {
  Write-Step "Verify-only mode. Checking critical modules..."
  $allOk = $true
  foreach ($item in $requiredPaths) {
    if (-not (Test-PathPattern -Pattern $item.Pattern)) {
      Write-Host "[repair] Missing or broken: $($item.Name)" -ForegroundColor Yellow
      $allOk = $false
    } else {
      Write-Host "[repair] OK: $($item.Name)" -ForegroundColor Green
    }
  }

  if (-not $allOk) {
    Write-Host "[repair] Verification failed. Run without -VerifyOnly to repair." -ForegroundColor Yellow
    exit 2
  }

  Write-Host "[repair] Verification passed." -ForegroundColor Green
  exit 0
}

Write-Step "Removing potentially broken node_modules..."
if (Test-Path "node_modules") {
  $trashName = ".node_modules_delete_" + (Get-Date -Format "yyyyMMdd_HHmmss")
  $trashPath = Join-Path (Get-Location) $trashName
  try {
    # Rename first so the project is immediately "clean", then delete in the background with heartbeat logs.
    Rename-Item -LiteralPath "node_modules" -NewName $trashName -ErrorAction Stop
    Write-Step "node_modules renamed to $trashName"
    Remove-PathWithHeartbeat -TargetPath $trashPath
    Write-Step "Deleted $trashName"
  } catch {
    Write-Host "[repair] Rename/delete fast path failed, trying direct delete..." -ForegroundColor Yellow
    Remove-PathWithHeartbeat -TargetPath (Join-Path (Get-Location) "node_modules")
    Write-Step "Deleted node_modules"
  }
}

Write-Step "Clearing pnpm cache..."
pnpm store path | Out-Null

Write-Step "Installing dependencies with lockfile..."
$installOk = $false
try {
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -eq 0) {
    $installOk = $true
  }
} catch {
  Write-Host "[repair] Frozen install failed, retrying normal install..." -ForegroundColor Yellow
}

if (-not $installOk) {
  try {
    pnpm install
    if ($LASTEXITCODE -eq 0) {
      $installOk = $true
    }
  } catch {
    Write-Host "[repair] Normal install also failed." -ForegroundColor Red
  }
}

if (-not $installOk) {
  throw "Dependency installation failed."
}

Write-Step "Verifying critical modules..."
foreach ($item in $requiredPaths) {
  if (-not (Test-PathPattern -Pattern $item.Pattern)) {
    throw "File still missing after repair: $($item.Name)"
  }
  Write-Host "[repair] OK: $($item.Name)" -ForegroundColor Green
}

Write-Step "Done. You can now run: .\devpl.ps1"
