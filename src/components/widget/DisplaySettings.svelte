<script lang="ts">
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import Icon from "@iconify/svelte";
import {
	BACKGROUND_OPTIONS,
	normalizeBackgroundIndex,
} from "@utils/background-utils";
import {
	clearStoredDevCredential,
	hashDevCodeClient,
	migrateLegacyDevCodeToCredential,
	storeDevCredential,
} from "@utils/dev-auth-client";
import {
	getBackgroundBlur,
	getBackgroundDisabled,
	getDefaultHue,
	getDeveloperModeEnabled,
	getHue,
	getNavbarAutoHide,
	getRainbowMode,
	getRainConfig,
	getRainMode,
	getStoredBackgroundIndex,
	type RainConfig,
	setBackgroundBlur,
	setBackgroundDisabled,
	setBackgroundIndex,
	setDeveloperModeEnabled,
	setHue,
	setNavbarAutoHide,
	setRainbowMode,
	setRainConfig,
	setRainMode,
} from "@utils/setting-utils";
import { onMount } from "svelte";
import { cubicOut } from "svelte/easing";
import { fade, fly, scale } from "svelte/transition";

let hue = getHue();
const defaultHue = getDefaultHue();
let backgroundDisabled = getBackgroundDisabled();
let rainbowMode = getRainbowMode();
let rainMode = getRainMode();
let rainConfig: RainConfig = getRainConfig();
let backgroundBlur = getBackgroundBlur();
let rainPanelOpen = false;
let portalHost: HTMLDivElement | null = null;
let countSlider: HTMLInputElement | null = null;
let widthSlider: HTMLInputElement | null = null;
let lengthSlider: HTMLInputElement | null = null;
let speedSlider: HTMLInputElement | null = null;
let angleSlider: HTMLInputElement | null = null;

// ========== 毛玻璃效果 ==========
let glassEnabled = true;
let glassNavbar = true;
let glassContent = false;
let glassBlurIntensity = 16;
let glassBlurSlider: HTMLInputElement;

// ========== 导航栏智能隐藏 ==========
let navbarAutoHide = getNavbarAutoHide();
function handleNavbarAutoHide() {
	navbarAutoHide = !navbarAutoHide;
	setNavbarAutoHide(navbarAutoHide);
}
// ========== 导航栏智能隐藏结束 ==========

// 毛玻璃 DOM 同步
function syncGlassToDOM() {
	if (typeof document === "undefined") return;
	document.documentElement.classList.toggle(
		"glass-navbar",
		glassEnabled && glassNavbar,
	);
	document.documentElement.classList.toggle(
		"glass-content",
		glassEnabled && glassContent,
	);
	document.documentElement.style.setProperty(
		"--glass-blur-intensity",
		`${glassBlurIntensity}px`,
	);
}

function saveGlass() {
	try {
		localStorage.setItem("glassEffectEnabled", String(glassEnabled));
		localStorage.setItem("glassNavbarEnabled", String(glassNavbar));
		localStorage.setItem("glassContentEnabled", String(glassContent));
		localStorage.setItem("glassBlurIntensity", String(glassBlurIntensity));
	} catch {
		/* ignore */
	}
}

function handleGlassToggle() {
	glassEnabled = !glassEnabled;
	syncGlassToDOM();
	saveGlass();
}
function handleGlassNavbar() {
	glassNavbar = !glassNavbar;
	syncGlassToDOM();
	saveGlass();
}
function handleGlassContent() {
	glassContent = !glassContent;
	syncGlassToDOM();
	saveGlass();
}
function handleGlassBlur(e: Event) {
	glassBlurIntensity = Number((e.currentTarget as HTMLInputElement).value);
	syncGlassToDOM();
	saveGlass();
}

// 响应式：同步滑块进度条
$: if (typeof glassBlurSlider !== "undefined" && glassBlurSlider) {
	const pct = ((glassBlurIntensity - 0) / (40 - 0)) * 100;
	glassBlurSlider.style.setProperty("--slider-value", `${pct}%`);
}
// ========== 毛玻璃效果结束 ==========

const backgroundCount = BACKGROUND_OPTIONS.length;
let backgroundIndex = getInitialBackgroundIndex();
let currentBackground = BACKGROUND_OPTIONS[backgroundIndex] ?? null;
let backgroundTypeLabel = "";
let backgroundSwitchTimestamp = 0;
const DEV_EDITOR_REDIRECT_PATH = "/editor";
const DEV_EDITOR_TOAST_DURATION_MS = 1800;
const DEV_EDITOR_REDIRECT_DELAY_MS = 500;
const DEV_EDITOR_LOCK_REDIRECT_DELAY_MS = 500;
// NOTE: This is a frontend-only "logout" trigger, NOT a security credential.
// It simply clears local state and redirects away from editor pages.
// All real authentication is enforced server-side via DEV_EDITOR_CODE env var.
const DEV_EDITOR_OFF_CODE = "liyueoff";
const DEV_EDITOR_LOCK_REDIRECT_PATH = "/";
const DEV_EDITOR_UNLOCKED_MESSAGES = [
	"解锁状态满格，口令键今天休息啦",
	"你已经在编辑区啦，别逗口令机啦",
	"门票已生效，直接写文冲冲冲",
	"口令守卫去喝奶茶了，你随便进",
	"这里不用二次开门，灵感优先",
	"已经放行成功，快把新点子写下来",
];
const DEV_EDITOR_CLOSED_MESSAGES = [
	"好啦，编辑器先打烊啦",
	"收到，创作通道已轻轻关上",
	"咔哒，编辑器今天先休息一下",
	"已退出编辑模式，下次再来写喵",
];
const DEV_EDITOR_EMPTY_CODE_MESSAGES = [
	"口令框空空的喵 先喂我点暗号",
	"什么都没输入 我只能装作听不懂",
	"小手回车太快啦 先把口令写上",
	"键盘敲得很自信 结果一个字都没留",
	"空白也想开门 你对我期待有点高",
	"回车按得挺果断 口令呢",
];
const DEV_EDITOR_WRONG_CODE_MESSAGES = [
	"暗号差一点点 再想想那个最顺手的",
	"再试一次吧 我先假装刚才没看见",
	"差一点就对了 这句话先记在错题本",
	"再给一条暗号吧 我感觉你快猜中了",
	"这口令像彩排版 正片再来一次",
	"门把手动了一下 又冷静回去了",
];
let developerModeEnabled = getDeveloperModeEnabled();
let developerCodeInput = "";
let unlockToastVisible = false;
let unlockToastMessage = "";
let unlockToastTimeout: ReturnType<typeof setTimeout> | null = null;
let lockRedirectTimeout: ReturnType<typeof setTimeout> | null = null;
let verifyingDeveloperCode = false;
let typingVerifyTimer: ReturnType<typeof setTimeout> | null = null;
let typingVerifyToken = 0;
let lastMatchedCode = "";
let lastUnlockedToastMessage = "";
let lastClosedToastMessage = "";
let lastEmptyCodeToastMessage = "";
let lastWrongCodeToastMessage = "";

function pickPlayfulMessage(
	messages: readonly string[],
	lastMessage: string,
): string {
	if (messages.length === 0) return "";
	if (messages.length === 1) return messages[0];
	let next = messages[Math.floor(Math.random() * messages.length)];
	if (next === lastMessage) {
		const sameIndex = messages.indexOf(next);
		next = messages[(sameIndex + 1) % messages.length] || next;
	}
	return next;
}

function showUnlockToast(message: string) {
	unlockToastMessage = message;
	unlockToastVisible = true;
	if (unlockToastTimeout) {
		clearTimeout(unlockToastTimeout);
	}
	unlockToastTimeout = setTimeout(() => {
		unlockToastVisible = false;
		unlockToastTimeout = null;
	}, DEV_EDITOR_TOAST_DURATION_MS);
}

function cancelTypingCodeVerify() {
	typingVerifyToken += 1;
	if (typingVerifyTimer) {
		clearTimeout(typingVerifyTimer);
		typingVerifyTimer = null;
	}
}

function cancelLockRedirect() {
	if (!lockRedirectTimeout) return;
	clearTimeout(lockRedirectTimeout);
	lockRedirectTimeout = null;
}

function redirectToDeveloperEditor() {
	if (typeof window === "undefined") return;
	const currentPath = window.location.pathname || "";
	if (currentPath.startsWith(DEV_EDITOR_REDIRECT_PATH)) return;
	window.location.href = DEV_EDITOR_REDIRECT_PATH;
}

function isProtectedDeveloperPage(pathname: string): boolean {
	return (
		pathname.startsWith(DEV_EDITOR_REDIRECT_PATH) ||
		pathname.startsWith("/drafts") ||
		pathname.startsWith("/trash")
	);
}

function redirectAfterDeveloperModeLocked() {
	if (typeof window === "undefined") return;
	cancelLockRedirect();
	const currentPath = window.location.pathname || "";
	const shouldLeaveProtectedPage = isProtectedDeveloperPage(currentPath);
	if (!shouldLeaveProtectedPage) {
		return;
	}
	lockRedirectTimeout = window.setTimeout(() => {
		lockRedirectTimeout = null;
		window.location.replace(DEV_EDITOR_LOCK_REDIRECT_PATH);
	}, DEV_EDITOR_LOCK_REDIRECT_DELAY_MS);
}

function scheduleTypingCodeVerify() {
	if (developerModeEnabled) return;
	if (verifyingDeveloperCode) return;
	cancelTypingCodeVerify();
	const code = developerCodeInput.trim();
	if (!code) {
		lastMatchedCode = "";
		return;
	}
	if (code.toLowerCase() === DEV_EDITOR_OFF_CODE) {
		lastMatchedCode = "";
		return;
	}
	typingVerifyTimer = setTimeout(() => {
		typingVerifyTimer = null;
		void verifyCodeWhileTyping(code);
	}, 260);
}

async function verifyCodeWhileTyping(code: string) {
	const token = ++typingVerifyToken;
	try {
		const devCodeHash = await hashDevCodeClient(code);
		const response = await fetch("/api/dev/verify", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			cache: "no-store",
			body: JSON.stringify({
				devCodeHash,
			}),
		});
		if (token !== typingVerifyToken) return;
		if (code !== developerCodeInput.trim()) return;
		if (response.ok) {
			if (lastMatchedCode !== code) {
				lastMatchedCode = code;
				showUnlockToast("暗号对啦，开写喵~");
			}
			return;
		}
		lastMatchedCode = "";
	} catch {
		// Ignore typing-stage verify errors to avoid noisy UI.
	}
}

async function submitDeveloperCode() {
	cancelTypingCodeVerify();
	cancelLockRedirect();
	const code = developerCodeInput.trim();
	const normalizedCode = code.toLowerCase();
	if (normalizedCode === DEV_EDITOR_OFF_CODE) {
		const currentPath =
			typeof window !== "undefined" ? window.location.pathname || "" : "";
		const shouldLeaveProtectedPage = isProtectedDeveloperPage(currentPath);
		setDeveloperModeEnabled(false, {
			emitEvent: !shouldLeaveProtectedPage,
		});
		clearStoredDevCredential();
		developerModeEnabled = false;
		developerCodeInput = "";
		lastMatchedCode = "";
		const closeMessage = pickPlayfulMessage(
			DEV_EDITOR_CLOSED_MESSAGES,
			lastClosedToastMessage,
		);
		lastClosedToastMessage = closeMessage;
		showUnlockToast(closeMessage);
		redirectAfterDeveloperModeLocked();
		return;
	}
	if (developerModeEnabled) {
		developerCodeInput = "";
		lastMatchedCode = "";
		const unlockedMessage = pickPlayfulMessage(
			DEV_EDITOR_UNLOCKED_MESSAGES,
			lastUnlockedToastMessage,
		);
		lastUnlockedToastMessage = unlockedMessage;
		showUnlockToast(unlockedMessage);
		return;
	}
	if (!code) {
		const emptyCodeMessage = pickPlayfulMessage(
			DEV_EDITOR_EMPTY_CODE_MESSAGES,
			lastEmptyCodeToastMessage,
		);
		lastEmptyCodeToastMessage = emptyCodeMessage;
		showUnlockToast(emptyCodeMessage);
		return;
	}
	if (verifyingDeveloperCode) return;
	verifyingDeveloperCode = true;
	try {
		const devCodeHash = await hashDevCodeClient(code);
		const response = await fetch("/api/dev/verify", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			cache: "no-store",
			body: JSON.stringify({
				devCodeHash,
			}),
		});
		const result = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			message?: string;
		};
		if (!response.ok || !result.ok) {
			if (response.status === 403) {
				throw new Error("DEV_WRONG_CODE");
			}
			if (response.status === 404) {
				throw new Error("校验接口未部署，请先重新部署");
			}
			throw new Error(`校验失败(${response.status})，请稍后再试`);
		}
		storeDevCredential(devCodeHash);
		developerModeEnabled = true;
		setDeveloperModeEnabled(true);
		developerCodeInput = "";
		lastMatchedCode = code;
		showUnlockToast("暗号对啦，开写喵~");
		window.setTimeout(() => {
			redirectToDeveloperEditor();
		}, DEV_EDITOR_REDIRECT_DELAY_MS);
	} catch (error) {
		clearStoredDevCredential();
		lastMatchedCode = "";
		if (error instanceof Error && error.message === "DEV_WRONG_CODE") {
			const wrongCodeMessage = pickPlayfulMessage(
				DEV_EDITOR_WRONG_CODE_MESSAGES,
				lastWrongCodeToastMessage,
			);
			lastWrongCodeToastMessage = wrongCodeMessage;
			showUnlockToast(wrongCodeMessage);
			return;
		}
		const message = error instanceof Error ? error.message : "口令不正确";
		showUnlockToast(message);
	} finally {
		verifyingDeveloperCode = false;
	}
}

function handleDeveloperCodeKeydown(event: KeyboardEvent) {
	if (event.key !== "Enter" && event.key !== "NumpadEnter") {
		return;
	}
	if (event.isComposing) {
		return;
	}
	event.preventDefault();
	void submitDeveloperCode();
}

function resetHue() {
	hue = getDefaultHue();
}

$: if (hue || hue === 0) {
	setHue(hue);
}

$: setBackgroundDisabled(backgroundDisabled);
$: setRainbowMode(rainbowMode);
$: setRainMode(rainMode);
$: setBackgroundBlur(backgroundBlur);
$: if (typeof document !== "undefined") {
	document.body.classList.toggle("rain-config-open", rainPanelOpen);
}

onMount(() => {
	// 毛玻璃：从 localStorage 恢复状态
	try {
		const v1 = localStorage.getItem("glassEffectEnabled");
		if (v1 !== null) glassEnabled = v1 === "true";
		const v2 = localStorage.getItem("glassNavbarEnabled");
		if (v2 !== null) glassNavbar = v2 === "true";
		const v3 = localStorage.getItem("glassContentEnabled");
		if (v3 !== null) glassContent = v3 === "true";
		const v4 = localStorage.getItem("glassBlurIntensity");
		if (v4 !== null) glassBlurIntensity = Number(v4) || 16;
	} catch {
		/* ignore */
	}
	syncGlassToDOM();

	if (portalHost && typeof document !== "undefined") {
		document.body.appendChild(portalHost);
	}

	if (typeof window === "undefined") {
		return () => {
			if (portalHost?.parentNode) {
				portalHost.parentNode.removeChild(portalHost);
			}
		};
	}
	void migrateLegacyDevCodeToCredential();

	const handleBackgroundChange = (event: Event) => {
		const detail = (event as CustomEvent<{ index?: number }>).detail;
		if (!detail || typeof detail.index !== "number") return;
		backgroundIndex = normalizeBackgroundIndex(detail.index);
	};
	const handleDeveloperModeChange = (event: Event) => {
		const enabled = (event as CustomEvent<boolean>).detail;
		developerModeEnabled = Boolean(enabled);
	};

	window.addEventListener(
		"background-selection-change",
		handleBackgroundChange as EventListener,
	);
	window.addEventListener(
		"developer-mode-change",
		handleDeveloperModeChange as EventListener,
	);
	return () => {
		if (typeof document !== "undefined") {
			document.body.classList.remove("rain-config-open");
		}
		if (unlockToastTimeout) {
			clearTimeout(unlockToastTimeout);
			unlockToastTimeout = null;
		}
		cancelLockRedirect();
		cancelTypingCodeVerify();
		if (portalHost?.parentNode) {
			portalHost.parentNode.removeChild(portalHost);
		}
		window.removeEventListener(
			"background-selection-change",
			handleBackgroundChange as EventListener,
		);
		window.removeEventListener(
			"developer-mode-change",
			handleDeveloperModeChange as EventListener,
		);
	};
});

function getInitialBackgroundIndex(): number {
	const stored = getStoredBackgroundIndex();
	if (typeof stored === "number") {
		return stored;
	}
	if (typeof window !== "undefined") {
		const win = window as Window & { __bgSelectionIndex?: number };
		if (typeof win.__bgSelectionIndex === "number") {
			return normalizeBackgroundIndex(win.__bgSelectionIndex);
		}
	}
	for (let idx = 0; idx < BACKGROUND_OPTIONS.length; idx += 1) {
		const candidate = BACKGROUND_OPTIONS[idx];
		if (!candidate || candidate.type !== "image") {
			continue;
		}
		if (
			typeof candidate.src === "string" &&
			candidate.src.startsWith("data:image/svg+xml")
		) {
			continue;
		}
		return idx;
	}
	return 0;
}

function applyBackgroundIndex(nextIndex: number) {
	if (!backgroundCount) return;
	const normalized = normalizeBackgroundIndex(nextIndex);
	backgroundIndex = normalized;
	setBackgroundIndex(normalized);
}

function handleBackgroundWheel(event: WheelEvent) {
	if (!backgroundCount) return;
	const now = Date.now();
	if (now - backgroundSwitchTimestamp < 140) return;
	backgroundSwitchTimestamp = now;
	if (event.deltaY === 0) return;
	const direction = event.deltaY > 0 ? 1 : -1;
	applyBackgroundIndex(backgroundIndex + direction);
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (event.key !== "Escape") return;
	if (!rainPanelOpen) return;
	rainPanelOpen = false;
}

function updateRainConfig(key: keyof RainConfig, event: Event) {
	const input = event.currentTarget as HTMLInputElement | null;
	if (!input) return;
	const value = input.valueAsNumber;
	if (Number.isNaN(value)) return;
	const nextValue = key === "count" ? Math.round(value) : value;
	rainConfig = { ...rainConfig, [key]: nextValue };
	setRainConfig(rainConfig);
	updateRangeFill(input, nextValue);
}

function formatRainValue(value: number, decimals: number): string {
	return Number(value.toFixed(decimals)).toString();
}

function updateRangeFill(
	input: HTMLInputElement | null,
	valueOverride?: number,
) {
	if (!input) return;
	const min = Number(input.min || "0");
	const max = Number(input.max || "100");
	const value =
		typeof valueOverride === "number" ? valueOverride : Number(input.value);
	const percent = ((value - min) / (max - min)) * 100;
	input.style.setProperty("--slider-value", `${percent}%`);
}

// Update background blur slider fill effect
let backgroundBlurSlider: HTMLInputElement;
$: if (backgroundBlurSlider) {
	// Calculate percentage value (0-20 range)
	const percentage = (backgroundBlur / 20) * 100;
	backgroundBlurSlider.style.setProperty("--slider-value", `${percentage}%`);
}

$: if (countSlider) updateRangeFill(countSlider, rainConfig.count);
$: if (widthSlider) updateRangeFill(widthSlider, rainConfig.width);
$: if (lengthSlider) updateRangeFill(lengthSlider, rainConfig.length);
$: if (speedSlider) updateRangeFill(speedSlider, rainConfig.speed);
$: if (angleSlider) updateRangeFill(angleSlider, rainConfig.angle);
$: currentBackground = BACKGROUND_OPTIONS[backgroundIndex] ?? null;
$: backgroundTypeLabel = currentBackground
	? currentBackground.label
		? currentBackground.label
		: currentBackground.type === "video"
			? "视频"
			: "图片"
	: "--";
</script>

<svelte:window on:keydown={handleWindowKeydown} />

<div id="display-setting" class="float-panel float-panel-closed absolute transition-all w-80 right-4 px-4 py-4">
    <!-- Theme Color -->
    <div class="mb-4" class:opacity-50={rainbowMode} class:pointer-events-none={rainbowMode}>
        <div class="flex flex-row gap-2 mb-3 items-center justify-between">
            <div class="flex gap-2 font-bold text-lg text-neutral-900 dark:text-neutral-100 transition relative ml-3
                before:w-1 before:h-4 before:rounded-md before:bg-[var(--primary)]
                before:absolute before:-left-3 before:top-[0.33rem]"
            >
                {i18n(I18nKey.themeColor)}
                <button aria-label="Reset to Default" class="btn-regular w-7 h-7 rounded-md  active:scale-90 will-change-transform"
                        class:opacity-0={hue === defaultHue} class:pointer-events-none={hue === defaultHue} on:click={resetHue}>
                    <div class="text-[var(--btn-content)]">
                        <Icon icon="fa6-solid:arrow-rotate-left" class="text-[0.875rem]"></Icon>
                    </div>
                </button>
            </div>
            <div class="flex gap-1">
                <div id="hueValue" class="transition bg-[var(--btn-regular-bg)] w-10 h-7 rounded-md flex justify-center
                font-bold text-sm items-center text-[var(--btn-content)]">
                    {rainbowMode ? '🌈' : hue}
                </div>
            </div>
        </div>
        <div class="w-full h-6 select-none">
            <input aria-label={i18n(I18nKey.themeColor)} type="range" min="0" max="360" bind:value={hue}
                   class="slider" id="colorSlider" step="5" style="width: 100%">
        </div>
    </div>

    <!-- Disable Background -->
    <div class="mb-4">
        <div class="flex flex-row gap-2 items-center justify-between mb-3">
            <div class="font-bold text-lg text-neutral-900 dark:text-neutral-100 transition relative ml-3
                before:w-1 before:h-4 before:rounded-md before:bg-[var(--primary)]
                before:absolute before:-left-3 before:top-[0.33rem]">
                禁用背景
            </div>
            <button class="relative inline-flex h-7 w-12 items-center rounded-full bg-[var(--btn-regular-bg)] transition-colors duration-200 ease-in-out"
                    class:bg-[var(--primary)]={backgroundDisabled}
                    on:click={() => backgroundDisabled = !backgroundDisabled}>
                <span class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out"
                      class:translate-x-5={backgroundDisabled}></span>
            </button>
        </div>
    </div>

    <!-- Rainbow Mode -->
    <div class="mb-4">
        <div class="flex flex-row gap-2 items-center justify-between mb-3">
            <div class="font-bold text-lg text-neutral-900 dark:text-neutral-100 transition relative ml-3
                before:w-1 before:h-4 before:rounded-md before:bg-[var(--primary)]
                before:absolute before:-left-3 before:top-[0.33rem]">
                彩虹模式
            </div>
            <button class="relative inline-flex h-7 w-12 items-center rounded-full bg-[var(--btn-regular-bg)] transition-colors duration-200 ease-in-out"
                    class:bg-[var(--primary)]={rainbowMode}
                    on:click={() => rainbowMode = !rainbowMode}>
                <span class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out"
                      class:translate-x-5={rainbowMode}></span>
            </button>
        </div>
    </div>

    <!-- Rain Effect -->
    <div class="mb-4">
        <div class="flex flex-row gap-2 items-center justify-between mb-3">
            <div class="font-bold text-lg text-neutral-900 dark:text-neutral-100 transition relative ml-3 flex items-center gap-2
                before:w-1 before:h-4 before:rounded-md before:bg-[var(--primary)]
                before:absolute before:-left-3 before:top-[0.33rem]">
                要下雨吗
                <button type="button" class="btn-plain w-6 h-6 rounded-md" aria-label="Rain Effect Settings" on:click={() => { rainPanelOpen = true; }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true" class="w-4 h-4">
                        <path fill="currentColor" d="M19.14,12.94c0.04-0.31,0.06-0.63,0.06-0.94s-0.02-0.63-0.06-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61l-1.92-3.32c-0.11-0.2-0.36-0.28-0.57-0.22l-2.39,0.96c-0.5-0.38-1.04-0.7-1.64-0.94l-0.36-2.54C14.34,2.38,14.12,2.2,13.87,2.2h-3.74c-0.25,0-0.47,0.18-0.5,0.42l-0.36,2.54c-0.6,0.24-1.14,0.56-1.64,0.94l-2.39-0.96c-0.22-0.06-0.46,0.02-0.57,0.22L2.75,8.68c-0.11,0.2-0.06,0.47,0.12,0.61l2.03,1.58C4.86,11.17,4.84,11.49,4.84,11.8s0.02,0.63,0.06,0.94l-2.03,1.58c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.11,0.2,0.36,0.28,0.57,0.22l2.39-0.96c0.5,0.38,1.04,0.7,1.64,0.94l0.36,2.54c0.03,0.24,0.25,0.42,0.5,0.42h3.74c0.25,0,0.47-0.18,0.5-0.42l0.36-2.54c0.6-0.24,1.14-0.56,1.64-0.94l2.39,0.96c0.22,0.06,0.46-0.02,0.57-0.22l1.92-3.32c0.11-0.2,0.06-0.47-0.12-0.61l-2.03-1.58ZM12,15.6c-1.99,0-3.6-1.61-3.6-3.6S10.01,8.4,12,8.4s3.6,1.61,3.6,3.6S13.99,15.6,12,15.6Z"/>
                    </svg>
                </button>
            </div>
            <button class="relative inline-flex h-7 w-12 items-center rounded-full bg-[var(--btn-regular-bg)] transition-colors duration-200 ease-in-out"
                    class:bg-[var(--primary)]={rainMode}
                    on:click={() => rainMode = !rainMode}>
                <span class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out"
                      class:translate-x-5={rainMode}></span>
            </button>
        </div>
    </div>

    <!-- Background Blur -->
    <div class="mb-4">
        <div class="flex flex-row gap-2 mb-3 items-center justify-between">
            <div class="font-bold text-lg text-neutral-900 dark:text-neutral-100 transition relative ml-3
                before:w-1 before:h-4 before:rounded-md before:bg-[var(--primary)]
                before:absolute before:-left-3 before:top-[0.33rem]">
                背景模糊
            </div>
            <div class="transition bg-[var(--btn-regular-bg)] w-12 h-7 rounded-md flex justify-center
            font-bold text-sm items-center text-[var(--btn-content)]">
                {backgroundBlur}px
            </div>
        </div>
        <div class="w-full h-6 select-none">
            <input type="range" min="0" max="20" bind:value={backgroundBlur}
                   class="slider" step="1" style="width: 100%"
                   bind:this={backgroundBlurSlider}>
        </div>
    </div>

    <!-- 毛玻璃效果 -->
    <div class="mb-4">
        <div class="flex flex-row gap-2 mb-3 items-center justify-between">
            <div class="font-bold text-lg text-neutral-900 dark:text-neutral-100 transition relative ml-3
                before:w-1 before:h-4 before:rounded-md before:bg-[var(--primary)]
                before:absolute before:-left-3 before:top-[0.33rem]">
                毛玻璃效果
            </div>
            <button class="relative inline-flex h-7 w-12 items-center rounded-full bg-[var(--btn-regular-bg)] transition-colors duration-200 ease-in-out"
                    class:bg-[var(--primary)]={glassEnabled}
                    on:click={handleGlassToggle}>
                <span class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out"
                      class:translate-x-5={glassEnabled}></span>
            </button>
        </div>
        {#if glassEnabled}
        <div class="flex flex-col gap-2 pl-3 mb-3 opacity-80 transition-opacity">
            <label class="flex items-center justify-between cursor-pointer">
                <span class="text-sm text-neutral-700 dark:text-neutral-300">导航栏</span>
                <button class="relative inline-flex h-6 w-10 items-center rounded-full bg-[var(--btn-regular-bg)] transition-colors duration-200"
                        class:bg-[var(--primary)]={glassNavbar}
                        on:click={handleGlassNavbar}>
                    <span class="inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200"
                          class:translate-x-4={glassNavbar}></span>
                </button>
            </label>
            <label class="flex items-center justify-between cursor-pointer">
                <span class="text-sm text-neutral-700 dark:text-neutral-300">内容区域</span>
                <button class="relative inline-flex h-6 w-10 items-center rounded-full bg-[var(--btn-regular-bg)] transition-colors duration-200"
                        class:bg-[var(--primary)]={glassContent}
                        on:click={handleGlassContent}>
                    <span class="inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200"
                          class:translate-x-4={glassContent}></span>
                </button>
            </label>
        </div>
        <div class="w-full select-none pl-3">
            <div class="flex justify-between mb-1">
                <span class="text-xs text-neutral-500">模糊强度</span>
                <span class="text-xs font-medium text-[var(--primary)]">{glassBlurIntensity}px</span>
            </div>
            <input type="range" min="0" max="40" step="1" value={glassBlurIntensity}
                   on:input={handleGlassBlur} bind:this={glassBlurSlider}
                   class="slider" style="width: 100%">
        </div>
        {/if}
    </div>

    <!-- 导航栏自然顶出 -->
    <div class="mb-4">
        <div class="flex flex-row gap-2 items-center justify-between mb-3">
            <div class="font-bold text-lg text-neutral-900 dark:text-neutral-100 transition relative ml-3
                before:w-1 before:h-4 before:rounded-md before:bg-[var(--primary)]
                before:absolute before:-left-3 before:top-[0.33rem]">
                导航栏自然顶出
            </div>
            <button class="relative inline-flex h-7 w-12 items-center rounded-full bg-[var(--btn-regular-bg)] transition-colors duration-200 ease-in-out"
                    class:bg-[var(--primary)]={navbarAutoHide}
                    on:click={handleNavbarAutoHide}>
                <span class="inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-200 ease-in-out"
                      class:translate-x-5={navbarAutoHide}></span>
            </button>
        </div>
    </div>

    <!-- Background Image -->
    <div class="mb-2">
        <div class="flex flex-row gap-2 mb-3 items-center justify-between">
            <div class="font-bold text-lg text-neutral-900 dark:text-neutral-100 transition relative ml-3
                before:w-1 before:h-4 before:rounded-md before:bg-[var(--primary)]
                before:absolute before:-left-3 before:top-[0.33rem]">
                背景图片
            </div>
            <div class="transition bg-[var(--btn-regular-bg)] w-14 h-7 rounded-md flex justify-center
            font-bold text-sm items-center text-[var(--btn-content)]">
                {backgroundCount ? `${backgroundIndex + 1}/${backgroundCount}` : "--"}
            </div>
        </div>
        <div class="w-full select-none flex items-center gap-2" on:wheel|preventDefault={handleBackgroundWheel}>
            <button class="btn-regular w-8 h-8 rounded-md active:scale-90 disabled:opacity-50 disabled:pointer-events-none"
                    aria-label="Previous background"
                    on:click={() => applyBackgroundIndex(backgroundIndex - 1)}
                    disabled={!backgroundCount}>
                <Icon icon="fa6-solid:chevron-left" class="text-[0.75rem]"></Icon>
            </button>
            <div class="flex-1 h-8 rounded-md bg-[var(--btn-regular-bg)] text-[var(--btn-content)] flex items-center justify-center gap-2 text-sm font-bold"
                 class:opacity-50={!backgroundCount}>
                <Icon icon={currentBackground?.type === "video" ? "fa6-solid:video" : "fa6-solid:image"} class="text-[0.75rem]"></Icon>
                <span>{backgroundTypeLabel}</span>
            </div>
            <button class="btn-regular w-8 h-8 rounded-md active:scale-90 disabled:opacity-50 disabled:pointer-events-none"
                    aria-label="Next background"
                    on:click={() => applyBackgroundIndex(backgroundIndex + 1)}
                    disabled={!backgroundCount}>
                <Icon icon="fa6-solid:chevron-right" class="text-[0.75rem]"></Icon>
            </button>
        </div>
    </div>

    <div class="mt-4">
        <div class="flex items-center gap-2 mb-2">
            <div class="font-bold text-sm text-neutral-900 dark:text-neutral-100 transition relative ml-3
                before:w-1 before:h-3 before:rounded-md before:bg-[var(--primary)]
                before:absolute before:-left-3 before:top-[0.2rem]">
                开发者模式            </div>
            <div class="text-[11px] text-neutral-400 dark:text-neutral-500 ml-auto">
                小口令对上，就给你一支会发光的笔
            </div>
        </div>
        <input
            type="password"
            class="w-full h-9 rounded-md bg-[var(--btn-regular-bg)] px-3 text-sm text-[var(--btn-content)] outline-none border border-transparent focus:border-[var(--primary)] transition"
            placeholder={developerModeEnabled ? "已解锁，可继续写作" : "输入开发口令，按回车解锁"}
            bind:value={developerCodeInput}
            on:input={scheduleTypingCodeVerify}
            on:keydown={handleDeveloperCodeKeydown}
        />
    </div>
</div>

<div bind:this={portalHost}>
    {#if unlockToastVisible}
        <div class="dev-toast" transition:fly={{ y: 18, duration: 220 }}>
            <div class="dev-toast-dot"></div>
            <span>{unlockToastMessage}</span>
        </div>
    {/if}
    {#if rainPanelOpen}
        <div class="rain-config-overlay" on:click={() => rainPanelOpen = false} transition:fade={{ duration: 180, easing: cubicOut }}>
            <div class="rain-config-panel card-base" role="dialog" aria-modal="true" aria-label="Rain Effect Settings" on:click|stopPropagation
                 transition:scale={{ duration: 200, easing: cubicOut, start: 0.96 }}>
                <div class="rain-config-header">
                    <h3>雨幕参数调节</h3>
                    <button type="button" class="rain-config-close" aria-label="Close" on:click={() => rainPanelOpen = false}>
                        ×
                    </button>
                </div>
                <div class="control-group">
                    <label>数量 (Count) <span class="value-display">{formatRainValue(rainConfig.count, 0)}</span></label>
                    <input type="range" min="10" max="1000" value={rainConfig.count} on:input={(event) => updateRainConfig("count", event)} bind:this={countSlider}>
                </div>
                <div class="control-group">
                    <label>雨丝粗细 (Width) <span class="value-display">{formatRainValue(rainConfig.width, 1)}</span></label>
                    <input type="range" min="0.5" max="5" step="0.1" value={rainConfig.width} on:input={(event) => updateRainConfig("width", event)} bind:this={widthSlider}>
                </div>
                <div class="control-group">
                    <label>雨丝长度 (Length) <span class="value-display">{formatRainValue(rainConfig.length, 0)}</span></label>
                    <input type="range" min="5" max="120" value={rainConfig.length} on:input={(event) => updateRainConfig("length", event)} bind:this={lengthSlider}>
                </div>
                <div class="control-group">
                    <label>下落速度 (Speed) <span class="value-display">{formatRainValue(rainConfig.speed, 0)}</span></label>
                    <input type="range" min="5" max="60" value={rainConfig.speed} on:input={(event) => updateRainConfig("speed", event)} bind:this={speedSlider}>
                </div>
                <div class="control-group">
                    <label>风向/倾斜 (Angle) <span class="value-display">{formatRainValue(rainConfig.angle, 2)}</span></label>
                    <input type="range" min="-0.8" max="0.8" step="0.01" value={rainConfig.angle} on:input={(event) => updateRainConfig("angle", event)} bind:this={angleSlider}>
                </div>
            </div>
        </div>
    {/if}
</div>


<style lang="stylus">
    #display-setting
      /* Theme color slider (fixed rainbow gradient with solid background) */
      input[type="range"][id="colorSlider"]
        -webkit-appearance none
        height 100%
        /* Remove default margin and padding */
        margin 0
        padding 0
        /* Use fixed rainbow gradient for slider background */
        background-image linear-gradient(to right, oklch(0.70 0.14 0), oklch(0.70 0.14 30), oklch(0.70 0.14 60), oklch(0.70 0.14 90), oklch(0.70 0.14 120), oklch(0.70 0.14 150), oklch(0.70 0.14 180), oklch(0.70 0.14 210), oklch(0.70 0.14 240), oklch(0.70 0.14 270), oklch(0.70 0.14 300), oklch(0.70 0.14 330), oklch(0.70 0.14 360))
        /* Add small rounded corners, matching the second image */
        border-radius 0.125rem
        /* Remove transition to prevent animation when hue changes */
        transition none
        /* Reset all border styles */
        border none
        outline none
        box-shadow none

      /* Background blur slider (theme color fill effect) */
      input[type="range"]:not([id="colorSlider"])
        -webkit-appearance none
        height 100%
        background-image linear-gradient(to right, var(--primary) var(--slider-value, 0%), #374151 var(--slider-value, 0%))
        /* Add small rounded corners, matching the second image */
        border-radius 0.125rem
        transition background-image 0.15s ease-in-out
        /* Reset all border styles */
        border none
        outline none
        box-shadow none

      /* Hide thumb for all sliders by default */
      input[type="range"]
        &::-webkit-slider-thumb
          -webkit-appearance none
          height 0
          width 0
          background transparent
          border none
          box-shadow none

        &::-moz-range-thumb
          -webkit-appearance none
          height 0
          width 0
          background transparent
          border none
          box-shadow none

        &::-ms-thumb
          -webkit-appearance none
          height 0
          width 0
          background transparent
          border none
          box-shadow none

      /* Only restore thumb for theme color slider */
      input[type="range"][id="colorSlider"]
        /* Adjust slider track height and appearance */
        &::-webkit-slider-runnable-track
          height 0.5rem
          border-radius 0.125rem
          background-image linear-gradient(to right, oklch(0.70 0.14 0), oklch(0.70 0.14 30), oklch(0.70 0.14 60), oklch(0.70 0.14 90), oklch(0.70 0.14 120), oklch(0.70 0.14 150), oklch(0.70 0.14 180), oklch(0.70 0.14 210), oklch(0.70 0.14 240), oklch(0.70 0.14 270), oklch(0.70 0.14 300), oklch(0.70 0.14 330), oklch(0.70 0.14 360))
        
        &::-moz-range-track
          height 0.5rem
          border-radius 0.125rem
          background-image linear-gradient(to right, oklch(0.70 0.14 0), oklch(0.70 0.14 30), oklch(0.70 0.14 60), oklch(0.70 0.14 90), oklch(0.70 0.14 120), oklch(0.70 0.14 150), oklch(0.70 0.14 180), oklch(0.70 0.14 210), oklch(0.70 0.14 240), oklch(0.70 0.14 270), oklch(0.70 0.14 300), oklch(0.70 0.14 330), oklch(0.70 0.14 360))
        
        &::-ms-track
          height 0.5rem
          border-radius 0.125rem
          background-image linear-gradient(to right, oklch(0.70 0.14 0), oklch(0.70 0.14 30), oklch(0.70 0.14 60), oklch(0.70 0.14 90), oklch(0.70 0.14 120), oklch(0.70 0.14 150), oklch(0.70 0.14 180), oklch(0.70 0.14 210), oklch(0.70 0.14 240), oklch(0.70 0.14 270), oklch(0.70 0.14 300), oklch(0.70 0.14 330), oklch(0.70 0.14 360))
          color transparent
        
        /* Theme color slider thumb */
        &::-webkit-slider-thumb
          -webkit-appearance none
          /* Adjust size to match the second image */
          height 1rem
          width 0.5rem
          /* Add small rounded corners matching the second image */
          border-radius 0.125rem
          background rgba(255, 255, 255, 0.7)
          box-shadow none
          /* Center thumb vertically on track */
          margin-top -0.25rem
          &:hover
            background rgba(255, 255, 255, 0.8)
          &:active
            background rgba(255, 255, 255, 0.6)

        &::-moz-range-thumb
          -webkit-appearance none
          height 1rem
          width 0.5rem
          border-radius 0.125rem
          border-width 0
          background rgba(255, 255, 255, 0.7)
          box-shadow none
          &:hover
            background rgba(255, 255, 255, 0.8)
          &:active
            background rgba(255, 255, 255, 0.6)

        &::-ms-thumb
          -webkit-appearance none
          height 1rem
          width 0.5rem
          border-radius 0.125rem
          background rgba(255, 255, 255, 0.7)
          box-shadow none
          /* Center thumb vertically on track for IE */
          margin-top 0
          &:hover
            background rgba(255, 255, 255, 0.8)
          &:active
            background rgba(255, 255, 255, 0.6)

      /* Background blur slider track styles */
      input[type="range"]:not([id="colorSlider"])
        /* Adjust slider track height and appearance */
        &::-webkit-slider-runnable-track
          height 0.5rem
          border-radius 0.125rem
          background-image linear-gradient(to right, var(--primary) var(--slider-value, 0%), #374151 var(--slider-value, 0%))
        
        &::-moz-range-track
          height 0.5rem
          border-radius 0.125rem
          background-image linear-gradient(to right, var(--primary) var(--slider-value, 0%), #374151 var(--slider-value, 0%))
        
        &::-ms-track
          height 0.5rem
          border-radius 0.125rem
          background-image linear-gradient(to right, var(--primary) var(--slider-value, 0%), #374151 var(--slider-value, 0%))
          color transparent

    :global(body.rain-config-open)
      overflow hidden
      touch-action none

    .rain-config-overlay
      position fixed
      top 0
      left 0
      right 0
      bottom 0
      display flex
      align-items center
      justify-content center
      padding 12px
      background rgba(2, 6, 23, 0.45)
      z-index 9999

    /* 移除导航栏绑定 */
    /* :global(.rain-config-open #navbar)
      transform none !important
      opacity 1 !important
    */

    .rain-config-panel
      --rain-accent var(--primary)
      --rain-accent-strong var(--primary)
      width 420px
      max-width min(92vw, 480px)
      max-height min(86vh, 780px)
      overflow-y auto
      -webkit-overflow-scrolling touch
      overscroll-behavior contain
      box-sizing border-box
      padding 22px
      background var(--float-panel-bg)
      border 2px solid var(--rain-accent)
      border-radius 18px
      color var(--btn-content)
      box-shadow 0 20px 60px rgba(0, 0, 0, 0.45)
      will-change transform, opacity

      .control-group
        margin-bottom 18px

      label
        display flex
        align-items center
        justify-content space-between
        font-size 15px
        margin-bottom 10px
        color var(--btn-content)

      input
        width 100%
        cursor pointer
        accent-color var(--rain-accent)
        touch-action pan-y

      .value-display
        color var(--rain-accent)
        font-weight 600

    .rain-config-header
      display flex
      align-items center
      justify-content space-between
      position sticky
      top 0
      z-index 2
      margin-bottom 12px
      padding-bottom 12px
      background transparent

      h3
        margin 0
        font-size 18px
        font-weight 700
        color var(--btn-content)

    .rain-config-close
      width 30px
      height 30px
      border-radius 8px
      border 0
      color var(--rain-accent)
      background var(--btn-regular-bg)
      display inline-flex
      align-items center
      justify-content center
      transition background 0.15s ease-out, color 0.15s ease-out

      &:hover
        background var(--btn-regular-bg-hover)
        color var(--btn-content)

    .rain-config-panel input[type="range"]
      -webkit-appearance none
      height 0.56rem
      border-radius 0.375rem
      background-image linear-gradient(to right, var(--rain-accent) var(--slider-value, 0%), var(--btn-regular-bg) var(--slider-value, 0%))
      border none
      outline none
      box-shadow none

      &::-webkit-slider-runnable-track
        height 0.56rem
        border-radius 0.375rem
        background-image linear-gradient(to right, var(--rain-accent) var(--slider-value, 0%), var(--btn-regular-bg) var(--slider-value, 0%))

      &::-moz-range-track
        height 0.56rem
        border-radius 0.375rem
        background-image linear-gradient(to right, var(--rain-accent) var(--slider-value, 0%), var(--btn-regular-bg) var(--slider-value, 0%))

      &::-ms-track
        height 0.56rem
        border-radius 0.375rem
        background-image linear-gradient(to right, var(--rain-accent) var(--slider-value, 0%), var(--btn-regular-bg) var(--slider-value, 0%))
        color transparent

      &::-webkit-slider-thumb
        -webkit-appearance none
        width 1.06rem
        height 1.06rem
        border-radius 0.375rem
        background var(--rain-accent-strong)
        margin-top -0.25rem
        box-shadow none

      &::-moz-range-thumb
        width 1.06rem
        height 1.06rem
        border-radius 0.375rem
        background var(--rain-accent-strong)
        border none

      &::-ms-thumb
        width 1.06rem
        height 1.06rem
        border-radius 0.375rem
        background var(--rain-accent-strong)

    .dev-toast
      position fixed
      right 1.25rem
      bottom 1.25rem
      z-index 10000
      display inline-flex
      align-items center
      gap 0.55rem
      max-width min(92vw, 26rem)
      padding 0.7rem 0.95rem
      border-radius 0.8rem
      border 1px solid var(--primary)
      background var(--float-panel-bg)
      color var(--btn-content)
      box-shadow 0 10px 32px rgba(0, 0, 0, 0.32)
      backdrop-filter blur(8px)

    .dev-toast-dot
      width 0.48rem
      height 0.48rem
      border-radius 999px
      background var(--primary)
      box-shadow 0 0 10px rgba(255, 255, 255, 0.35)

    @media (max-width: 640px), (hover: none) and (pointer: coarse)
      .rain-config-overlay
        align-items flex-start
        justify-content flex-end
        padding 5.25rem 0.5rem calc(env(safe-area-inset-bottom, 0px) + 0.5rem)
        background rgba(2, 6, 23, 0.2)
        backdrop-filter none

      .rain-config-panel
        width min(78vw, 320px)
        max-width 320px
        max-height min(54vh, 460px)
        border-radius 12px
        padding 10px
        box-shadow 0 10px 24px rgba(0, 0, 0, 0.4)

        .control-group
          margin-bottom 10px

        label
          font-size 12px
          margin-bottom 6px

        .value-display
          min-width 2rem
          text-align right

      .rain-config-header
        margin-bottom 6px
        padding-bottom 6px

        h3
          font-size 14px

</style>

