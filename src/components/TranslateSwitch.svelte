<script lang="ts">
import { ENABLE_AUTO_DETECT } from "@i18n/translate/config";
import {
	type TranslateSwitchOption,
	buildSwitchOptions,
	getDefaultLanguage,
} from "@i18n/translate/languages";
import {
	type TranslateProviderOption,
	TRANSLATE_PROVIDER_OPTIONS,
	getTranslateProviderOption,
} from "@i18n/translate/providers";
import { clearTranslationCache, getCacheStats } from "@utils/translate/cache";
import { getTranslateEngine } from "@utils/translate/engine";
import { onMount } from "svelte";
import type { TranslateStatusDetail } from "@/types/translate";

const defaultLanguage = getDefaultLanguage();
const options: TranslateSwitchOption[] = buildSwitchOptions(defaultLanguage);

let status: TranslateStatusDetail = {
	language: defaultLanguage,
	defaultLanguage,
	loading: false,
	progress: 0,
	provider: null,
	error: null,
	stats: { translated: 0, cached: 0, skipped: 0, unchanged: 0 },
};

let open = false;
let rootEl: HTMLDivElement | null = null;
let triggerEl: HTMLButtonElement | null = null;
let portalHost: HTMLDivElement | null = null;
let optionEls: HTMLButtonElement[] = [];
let focusIndex = 0;
let cacheEntries = 0;
let feedback = "";
/** 服务端实际启用的翻译源 id；取不到时回退到内置列表 */
let enabledProviderIds: string[] | null = null;
let providersLoaded = false;

$: providers = enabledProviderIds
	? TRANSLATE_PROVIDER_OPTIONS.filter((option) =>
			enabledProviderIds?.includes(option.id),
		)
	: TRANSLATE_PROVIDER_OPTIONS;
$: activeProvider =
	getTranslateProviderOption(status.provider ?? "") ?? providers[0] ?? null;
$: currentOption =
	options.find((option) => option.code === status.language) ?? options[0];
$: progressPercent = Math.round(status.progress * 100);
$: hint = buildHint(status, feedback);
$: announcement = status.loading
	? "正在翻译页面内容"
	: status.error
		? `翻译失败：${status.error}`
		: `当前语言：${currentOption?.label ?? defaultLanguage}`;

function buildHint(engineStatus: TranslateStatusDetail, extra: string): string {
	if (engineStatus.error) return engineStatus.error;
	if (engineStatus.loading) {
		return `正在翻译… ${Math.round(engineStatus.progress * 100)}%`;
	}
	if (extra) return extra;
	if (engineStatus.language === engineStatus.defaultLanguage) {
		return "当前显示原文";
	}
	const parts: string[] = [];
	if (engineStatus.stats.translated > 0) {
		parts.push(`已翻译 ${engineStatus.stats.translated} 处`);
	}
	if (engineStatus.stats.cached > 0) {
		parts.push(`命中缓存 ${engineStatus.stats.cached} 处`);
	}
	return parts.length > 0 ? parts.join(" · ") : "翻译完成";
}

function refreshCacheInfo() {
	try {
		cacheEntries = getCacheStats().entries;
	} catch {
		cacheEntries = 0;
	}
}

function showPanel() {
	open = true;
	feedback = "";
	refreshCacheInfo();
	void loadProviders();
}

/** 从服务端取一次「实际启用的翻译源」，只请求一次，失败就沿用内置列表 */
async function loadProviders() {
	if (providersLoaded) return;
	providersLoaded = true;
	try {
		const response = await fetch("/api/translate", {
			headers: { Accept: "application/json" },
			cache: "no-store",
		});
		const payload = (await response.json().catch(() => null)) as {
			ok?: boolean;
			providers?: Array<{ id?: unknown; configured?: unknown }>;
		} | null;
		if (!response.ok || payload?.ok !== true || !Array.isArray(payload.providers)) {
			return;
		}
		const ids = payload.providers
			.filter((item) => item?.configured !== false && typeof item?.id === "string")
			.map((item) => item.id as string);
		if (ids.length > 0) enabledProviderIds = ids;
	} catch {
		/* 取不到时保留内置列表 */
	}
}

function hidePanel(returnFocus = false) {
	open = false;
	if (returnFocus) triggerEl?.focus();
}

function togglePanel() {
	if (open) {
		hidePanel();
		return;
	}
	showPanel();
}

function selectLanguage(option: TranslateSwitchOption) {
	const engine = getTranslateEngine();
	feedback = option.isOriginal ? "已恢复原文" : `已切换到 ${option.label}`;
	engine.setLanguage(option.code, { manual: true });
	hidePanel(true);
}

function selectProvider(option: TranslateProviderOption) {
	if (option.id === status.provider) return;
	getTranslateEngine().setProvider(option.id);
	feedback = `翻译源已切换为 ${option.label}`;
	refreshCacheInfo();
}

function handleResetCache() {
	clearTranslationCache();
	refreshCacheInfo();
	feedback = "本地翻译缓存已清空";
}

function focusOption(index: number) {
	const total = options.length;
	if (total === 0) return;
	const next = ((index % total) + total) % total;
	focusIndex = next;
	optionEls[next]?.focus();
}

function handleTriggerKeydown(event: KeyboardEvent) {
	if (event.key === "ArrowDown" || event.key === "ArrowUp") {
		event.preventDefault();
		showPanel();
		focusOption(options.findIndex((option) => option.code === status.language));
		return;
	}
	if (event.key === "Enter" || event.key === " ") {
		event.preventDefault();
		togglePanel();
	}
}

function handleRootKeydown(event: KeyboardEvent) {
	if (!open) return;
	switch (event.key) {
		case "Escape":
			event.preventDefault();
			hidePanel(true);
			return;
		case "ArrowDown":
			event.preventDefault();
			focusOption(focusIndex + 1);
			return;
		case "ArrowUp":
			event.preventDefault();
			focusOption(focusIndex - 1);
			return;
		case "Home":
			event.preventDefault();
			focusOption(0);
			return;
		case "End":
			event.preventDefault();
			focusOption(options.length - 1);
			return;
		default:
			return;
	}
}

function isInsideRoot(target: EventTarget | null): boolean {
	return target instanceof Node && Boolean(rootEl?.contains(target));
}

function handleDocumentClick(event: MouseEvent) {
	if (!open) return;
	if (isInsideRoot(event.target)) return;
	hidePanel();
}

function handleDocumentFocus(event: FocusEvent) {
	if (!open) return;
	if (isInsideRoot(event.target)) return;
	hidePanel();
}

onMount(() => {
	const engine = getTranslateEngine();
	const unsubscribe = engine.subscribe((next) => {
		status = next;
	});

	// 进度条 / 无障碍播报放在 body 上，避免被导航栏的 contain 影响定位
	if (portalHost) document.body.appendChild(portalHost);

	// 自动识别浏览器语言、恢复上次选择、首次翻译都在 init 内完成
	engine.init();
	refreshCacheInfo();

	document.addEventListener("click", handleDocumentClick, true);
	document.addEventListener("focusin", handleDocumentFocus, true);

	return () => {
		unsubscribe();
		document.removeEventListener("click", handleDocumentClick, true);
		document.removeEventListener("focusin", handleDocumentFocus, true);
		if (portalHost?.parentNode) {
			portalHost.parentNode.removeChild(portalHost);
		}
	};
});
</script>

<!--
  根元素带 data-no-translate / translate="no" / .notranslate 三重标记，
  保证翻译引擎永远不会翻译语言切换器自身。
-->
<div
	bind:this={rootEl}
	id="translate-switch"
	class="notranslate relative z-50"
	role="group"
	data-no-translate
	translate="no"
	aria-label="语言切换"
	on:keydown={handleRootKeydown}
>
	<button
		bind:this={triggerEl}
		type="button"
		id="translate-switch-trigger"
		class="nav-icon-btn h-11 w-11 active:scale-90 md:w-auto md:px-3"
		class:text-[var(--primary)]={status.language !== status.defaultLanguage}
		aria-haspopup="true"
		aria-expanded={open}
		aria-controls="translate-switch-panel"
		aria-label={`语言切换，当前语言：${currentOption?.label ?? defaultLanguage}`}
		data-tooltip="翻译"
		on:click={togglePanel}
		on:keydown={handleTriggerKeydown}
	>
		{#if status.loading}
			<span class="translate-spinner" aria-hidden="true"></span>
		{:else}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				class="text-[1.25rem]"
				width="1em"
				height="1em"
				aria-hidden="true"
			>
				<path
					fill="currentColor"
					d="M12.87 15.07l-2.54-2.51l.03-.03c1.74-1.94 2.98-4.17 3.71-6.53H17V4h-7V2H8v2H1v1.99h11.17C11.5 7.92 10.44 9.75 9 11.35C8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.99 4.56l-5.09 5.02L4 19l5-5l3.11 3.11l.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"
				></path>
			</svg>
		{/if}
		<span class="hidden text-xs font-bold md:inline">
			{currentOption?.label ?? defaultLanguage}
		</span>
	</button>

	<div
		class="absolute top-11 -right-2 pt-5 transition"
		class:float-panel-closed={!open}
	>
		<div
			id="translate-switch-panel"
			class="card-base float-panel w-64 max-w-[calc(100vw-1.5rem)] p-2 backdrop-blur-md"
			role="menu"
			aria-label="选择语言"
		>
			<!-- 翻译源：决定用哪个翻译服务来翻译页面 -->
			<div class="mb-1 px-2 text-[0.68rem] font-bold text-black/45 dark:text-white/45">
				翻译源 / Engine
			</div>

			<div
				class="mb-2 flex gap-1 rounded-lg bg-black/5 p-0.5 dark:bg-white/10"
				role="group"
				aria-label="选择翻译源"
			>
				{#each providers as provider (provider.id)}
					<button
						type="button"
						role="menuitemradio"
						aria-checked={status.provider === provider.id}
						tabindex={open ? 0 : -1}
						title={provider.hint}
						class="btn-plain scale-animation flex h-7 flex-1 items-center justify-center rounded-md px-2 text-[0.68rem] font-medium whitespace-nowrap"
						class:current-theme-btn={status.provider === provider.id}
						on:click={() => selectProvider(provider)}
					>
						{provider.label}
					</button>
				{/each}
			</div>

			<div class="mb-1 px-2 text-[0.68rem] font-bold text-black/45 dark:text-white/45">
				原文 / Original
			</div>

			{#each options as option, i (option.code)}
				<button
					bind:this={optionEls[i]}
					type="button"
					role="menuitemradio"
					aria-checked={status.language === option.code}
					tabindex={open ? 0 : -1}
					class="btn-plain scale-animation mb-0.5 flex h-9 w-full items-center justify-between gap-2 rounded-lg px-3 text-left font-medium"
					class:current-theme-btn={status.language === option.code}
					on:click={() => selectLanguage(option)}
					on:focus={() => {
						focusIndex = i;
					}}
				>
					<span class="flex min-w-0 items-center gap-2">
						<span class="truncate" lang={option.code} dir={option.rtl ? "rtl" : "ltr"}>
							{option.label}
						</span>
						{#if option.isOriginal}
							<span class="shrink-0 rounded bg-black/10 px-1 text-[0.6rem] dark:bg-white/15">
								原文
							</span>
						{/if}
					</span>
					{#if status.language === option.code}
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							class="shrink-0 text-[1rem] text-[var(--primary)]"
							width="1em"
							height="1em"
							aria-hidden="true"
						>
							<path
								fill="currentColor"
								d="M9 16.17L4.83 12l-1.42 1.41L9 19L21 7l-1.41-1.41z"
							></path>
						</svg>
					{:else}
						<span class="shrink-0 truncate text-[0.65rem] text-black/35 dark:text-white/35">
							{option.englishName}
						</span>
					{/if}
				</button>
			{/each}

			<div
				class="mt-1 flex items-center justify-between gap-2 border-t border-black/10 px-2 pt-2 text-[0.66rem] text-black/50 dark:border-white/10 dark:text-white/50"
			>
				<span class="truncate" title={hint}>{hint}</span>
				<button
					type="button"
					class="btn-plain shrink-0 rounded-md px-2 py-1 text-[0.66rem]"
					aria-label={`清除本地翻译缓存，当前共 ${cacheEntries} 条`}
					on:click={handleResetCache}
				>
					清缓存{cacheEntries > 0 ? `(${cacheEntries})` : ""}
				</button>
			</div>

			{#if activeProvider}
				<div
					class="mt-1 px-2 text-[0.6rem] text-black/35 dark:text-white/35"
					title={activeProvider.hint}
				>
					翻译源：{activeProvider.label}{ENABLE_AUTO_DETECT ? " · 已开启浏览器语言自动识别" : ""}
				</div>
			{/if}
		</div>
	</div>
</div>

<div bind:this={portalHost}>
	{#if status.loading}
		<div
			class="translate-progress"
			role="progressbar"
			aria-label="翻译进度"
			aria-valuemin="0"
			aria-valuemax="100"
			aria-valuenow={progressPercent}
		>
			<span style={`width: ${Math.max(6, progressPercent)}%`}></span>
		</div>
	{/if}
	<span class="sr-only" aria-live="polite">{announcement}</span>
</div>

<style>
	/*
	 * 面板的高度上限与滚动必须写在 id 选择器上：
	 * src/styles/twikoo.css 里有一条不带 @layer 的全局 `.card-base { overflow: visible }`，
	 * 它的优先级高于 Tailwind 的 overflow-y-auto / 组件层的 overflow-hidden，
	 * 会让超出 max-height 的内容直接溢出面板，看起来就像「背景没盖住」。
	 * 用 id（优先级更高）来声明，同时把上限放到视口内，正常情况下完整显示、无需滚动。
	 */
	#translate-switch-panel {
		max-height: min(calc(100vh - 8rem), 42rem);
		overflow-y: auto;
		overscroll-behavior: contain;
		-webkit-overflow-scrolling: touch;
	}

	.translate-progress {
		position: fixed;
		top: 0;
		left: 0;
		right: 0;
		height: 2px;
		z-index: 9998;
		pointer-events: none;
	}

	.translate-progress span {
		display: block;
		height: 100%;
		background: var(--primary);
		box-shadow: 0 0 8px var(--primary);
		transition: width 260ms ease-out;
	}

	.translate-spinner {
		width: 1rem;
		height: 1rem;
		border-radius: 9999px;
		border: 2px solid currentColor;
		border-top-color: transparent;
		animation: translate-spin 720ms linear infinite;
	}

	@keyframes translate-spin {
		to {
			transform: rotate(360deg);
		}
	}

	/* 翻译过程中给正文一个轻量的过渡，避免文字突变 */
	:global(html[data-translate-loading="true"] #content-wrapper) {
		transition: opacity 220ms ease;
	}
</style>
