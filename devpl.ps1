param(
  [string]$HostName = "localhost",
  [int]$Port = 4321
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host "[dev] $Message" -ForegroundColor Cyan
}

function Find-ProjectRoot {
  param(
    [Parameter(Mandatory = $true)][string[]]$StartDirs
  )

  foreach ($start in $StartDirs) {
    if (-not (Test-Path -LiteralPath $start)) {
      continue
    }

    $current = (Resolve-Path -LiteralPath $start).Path
    while ($true) {
      if ((Test-Path -LiteralPath (Join-Path $current "package.json")) -and
          (Test-Path -LiteralPath (Join-Path $current "pnpm-lock.yaml"))) {
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
  throw "Cannot locate project root. Put this script inside the project and run again."
}

Set-Location -LiteralPath $projectRoot
Write-Step "Project root: $projectRoot"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js not found. Install Node.js first, then run this script again."
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw "pnpm not found. Install pnpm first, then run this script again."
}

$astroShim = Join-Path $projectRoot "node_modules\.bin\astro.ps1"
$astroPackage = Join-Path $projectRoot "node_modules\astro\package.json"
if (-not (Test-Path -LiteralPath $astroShim) -or -not (Test-Path -LiteralPath $astroPackage)) {
  Write-Host "[dev] Dependencies are missing or incomplete." -ForegroundColor Yellow
  Write-Host "[dev] Run this repair script first:" -ForegroundColor Yellow
  Write-Host "[dev]   powershell -ExecutionPolicy Bypass -File `"$projectRoot\repair-after-unzip.ps1`"" -ForegroundColor Yellow
  exit 2
}

$env:CHOKIDAR_USEPOLLING = "1"
$env:CHOKIDAR_INTERVAL = "300"

Write-Step "Starting Astro at http://${HostName}:${Port}/"
pnpm exec astro dev --host $HostName --port $Port
