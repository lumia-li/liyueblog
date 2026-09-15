import {
	BATCH_MAX_CHARS,
	BATCH_MAX_ITEMS,
	ENABLE_AUTO_DETECT,
	REQUEST_TIMEOUT_MS,
	RESCAN_DEBOUNCE_MS,
	SOURCE_LANGUAGE,
} from "@i18n/translate/config";
import {
	getDefaultLanguage,
	normalizeLanguageCode,
	resolveLanguageFromNavigator,
} from "@i18n/translate/languages";
import {
	DEFAULT_TRANSLATE_PROVIDER,
	isTranslateProviderId,
} from "@i18n/translate/providers";
import {
	clearTranslationCache,
	findOriginalByTranslated,
	getCachedTranslation,
	getStoredLanguage,
	getStoredProvider,
	isLanguageManuallyChosen,
	setCachedTranslation,
	setLanguageManuallyChosen,
	setStoredLanguage,
	setStoredProvider,
} from "@utils/translate/cache";
import type {
	TranslateResponsePayload,
	TranslateStats,
	TranslateStatusDetail,
} from "@/types/translate";

/**
 * 客户端 DOM 翻译引擎。
 *
 * 工作方式：
 * 1. TreeWalker 遍历 document.body 下的文本节点；
 * 2. 跳过 script/style/code/pre/输入控件/标记为不翻译的节点；
 * 3. 文本去重后按「可见优先」分批请求 /api/translate；
 * 4. 用 WeakMap 记录每个文本节点的原文，切回默认语言时逐字恢复；
 * 5. MutationObserver 监听动态新增节点并自动翻译，写回 DOM 时加锁防止循环触发。
 */

/** 完全不参与翻译的标签 */
const SKIP_TAGS = new Set([
	"SCRIPT",
	"STYLE",
	"NOSCRIPT",
	"CODE",
	"PRE",
	"TEXTAREA",
	"INPUT",
	"SELECT",
	"OPTION",
	"OPTGROUP",
	"SVG",
	"MATH",
	"CANVAS",
	"IFRAME",
	"TEMPLATE",
	"KBD",
	"SAMP",
	"VIDEO",
	"AUDIO",
]);

/** 完全不参与翻译的选择器 */
const SKIP_SELECTOR = [
	"[data-no-translate]",
	"[translate='no']",
	".notranslate",
	".katex",
	".katex-display",
	".expressive-code",
	"#translate-switch",
	"[aria-hidden='true']",
	"[contenteditable='true']",
	"[data-pagefind-ignore]",
].join(",");

/** 用于标记「该元素内的文本是引擎写回的译文」 */
const APPLIED_ATTR = "data-i18n-applied";

/** 文本节点 → 原文 */
const originals = new WeakMap<Text, string>();
/** 文本节点 → 已应用的目标语言 */
const appliedLanguages = new WeakMap<Text, string>();
/** 元素是否被跳过（含祖先判定结果缓存，每次遍历前重置） */
let skipCache = new WeakMap<Element, boolean>();

let hasLetterPattern: RegExp | null = null;

function getLetterPattern(): RegExp {
	if (hasLetterPattern) return hasLetterPattern;
	try {
		// 优先使用 Unicode 属性转义，可正确识别中文、日文、韩文等
		hasLetterPattern = new RegExp("[\\p{L}\\p{Nl}]", "u");
	} catch {
		hasLetterPattern =
			/[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u3040-\u30FF\u4E00-\u9FFF\uAC00-\uD7AF]/;
	}
	return hasLetterPattern;
}

const URL_PATTERN = /^(?:https?:\/\/|www\.)\S+$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const STATIC_ASSET_PATTERN =
	/^[\w./@-]+\.(?:html?|css|styl|scss|less|m?js|cjs|jsx?|tsx?|svelte|astro|vue|py|rb|go|rs|java|c|cpp|h|sh|ps1|bat|json|ya?ml|toml|lock|mdx?|txt|xml|png|jpe?g|gif|webp|avif|svg|ico|pdf|zip|tar|gz|rar|7z|docx?|xlsx?|pptx?|woff2?|ttf|eot|mp[34]|webm|wav|flac)$/i;
const TIME_LIKE_PATTERN = /^\d{1,4}(?:[-/:.]\d{1,2}){1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?$/;

/** 每次 DOM 遍历前重置跳过判定缓存，避免元素属性变化后判定过期 */
function resetSkipCache(): void {
	skipCache = new WeakMap<Element, boolean>();
}

/**
 * 判断「元素自身」是否被排除（只看自己的标签与属性）。
 * 注意：这里只缓存元素自身的判定结果，绝不能把子孙的结果写到祖先上，
 * 否则一个被跳过的子孙会把包含正常内容的祖先也标记为跳过（或反之）。
 */
function isSelfSkipped(element: Element): boolean {
	const cached = skipCache.get(element);
	if (cached !== undefined) return cached;

	const tag = element.tagName;
	const skipped =
		SKIP_TAGS.has(tag) ||
		element.hasAttribute("data-no-translate") ||
		element.getAttribute("translate") === "no" ||
		element.hasAttribute("contenteditable") ||
		element.getAttribute("aria-hidden") === "true" ||
		element.classList.contains("notranslate") ||
		(typeof element.matches === "function" && element.matches(SKIP_SELECTOR));

	skipCache.set(element, skipped);
	return skipped;
}

/** 判断文本节点的父元素是否处于「不翻译」的范围内（逐级向上检查自身状态） */
function isSkippedElement(element: Element | null): boolean {
	let node: Element | null = element;
	let depth = 0;
	while (node && node !== document.documentElement && depth < 64) {
		if (isSelfSkipped(node)) return true;
		node = node.parentElement;
		depth += 1;
	}
	return false;
}

/** 判断一段文本是否值得翻译（跳过纯数字/纯符号/URL/邮箱/文件名/日期等） */
export function shouldTranslateText(raw: string): boolean {
	const text = raw.trim();
	if (text.length < 1) return false;
	// 必须至少包含一个字母 / 汉字 / 假名等文字字符
	if (!getLetterPattern().test(text)) return false;
	if (URL_PATTERN.test(text)) return false;
	if (EMAIL_PATTERN.test(text)) return false;
	if (STATIC_ASSET_PATTERN.test(text)) return false;
	if (TIME_LIKE_PATTERN.test(text)) return false;
	return true;
}

interface TextGroup {
	original: string;
	nodes: Text[];
	visible: boolean;
	order: number;
}

interface Batch {
	groups: TextGroup[];
	visible: boolean;
}

type StatusListener = (status: TranslateStatusDetail) => void;

/**
 * 访客切换语言 / 翻译源导致的中断。
 * 它不是错误：既不展示给访客，也不打断「换配置后立刻重译」的流程。
 */
class TranslateCancelledError extends Error {
	constructor() {
		super("翻译已取消");
		this.name = "TranslateCancelledError";
	}
}

function isAbortError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

function idleYield(): Promise<void> {
	return new Promise((resolve) => {
		const requestIdle = (
			globalThis as unknown as {
				requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => void;
			}
		).requestIdleCallback;
		if (typeof requestIdle === "function") {
			requestIdle(() => resolve(), { timeout: 300 });
			return;
		}
		setTimeout(resolve, 16);
	});
}

export class TranslateEngine {
	private language: string;
	private readonly defaultLanguage: string;
	private originalHtmlLang = "";

	private loading = false;
	private progress = 0;
	private error: string | null = null;
	/** 当前翻译源（展示用），默认翻译源或访客手动选择 */
	private provider: string | null = null;
	/** 访客是否手动选过翻译源：没选过时请求里不带 provider，交给服务端默认值 */
	private providerChosen = false;
	private stats: TranslateStats = {
		translated: 0,
		cached: 0,
		skipped: 0,
		unchanged: 0,
	};

	/**
	 * 当前这一轮翻译的中断句柄。
	 * 访客切换语言 / 翻译源时立刻 abort，正在飞行的请求不会再等结果。
	 */
	private requestController: AbortController | null = null;
	private observer: MutationObserver | null = null;
	private rescanTimer: ReturnType<typeof setTimeout> | null = null;
	private running = false;
	private pendingRescan = false;
	private runToken = 0;
	private applying = false;
	private initialized = false;
	private readonly listeners = new Set<StatusListener>();

	constructor() {
		this.defaultLanguage = getDefaultLanguage();
		const stored = getStoredLanguage();
		const normalizedStored = stored ? normalizeLanguageCode(stored) : "";
		this.language = normalizedStored || this.defaultLanguage;

		const storedProvider = getStoredProvider();
		if (storedProvider && isTranslateProviderId(storedProvider)) {
			this.provider = storedProvider;
			this.providerChosen = true;
		} else {
			this.provider = DEFAULT_TRANSLATE_PROVIDER;
		}
	}

	// ---------------------------------------------------------------- 状态订阅

	getStatus(): TranslateStatusDetail {
		return {
			language: this.language,
			defaultLanguage: this.defaultLanguage,
			loading: this.loading,
			progress: this.progress,
			provider: this.provider,
			error: this.error,
			stats: { ...this.stats },
		};
	}

	subscribe(listener: StatusListener): () => void {
		this.listeners.add(listener);
		listener(this.getStatus());
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emitStatus(): void {
		if (this.listeners.size === 0) return;
		const status = this.getStatus();
		for (const listener of this.listeners) {
			try {
				listener(status);
			} catch {
				/* 单个监听器异常不影响引擎 */
			}
		}
	}

	private setLoading(value: boolean, progress = this.progress): void {
		this.loading = value;
		this.progress = value ? progress : 0;
		if (typeof document !== "undefined") {
			document.documentElement.dataset.translateLoading = value
				? "true"
				: "false";
		}
		this.emitStatus();
	}

	// ------------------------------------------------------------------ 初始化

	init(): void {
		if (typeof window === "undefined" || typeof document === "undefined") return;
		if (this.initialized) return;
		this.initialized = true;
		this.originalHtmlLang = document.documentElement.lang || "";

		// 自动识别：仅当访客从未手动选择过语言时才生效
		if (
			ENABLE_AUTO_DETECT &&
			!isLanguageManuallyChosen() &&
			!getStoredLanguage() &&
			typeof navigator !== "undefined" &&
			navigator.language
		) {
			const detected = resolveLanguageFromNavigator(navigator.language);
			if (detected && detected !== this.defaultLanguage) {
				this.language = detected;
			}
		}

		this.applyDocumentLanguage(this.language);
		this.installObserver();

		if (this.language !== this.defaultLanguage) {
			void this.translateCurrent();
		}
		this.emitStatus();
	}

	private installObserver(): void {
		if (this.observer || !document.body) return;
		this.observer = new MutationObserver((records) => {
			if (this.applying) return;
			if (this.language === this.defaultLanguage) return;
			const hasAddedContent = records.some(
				(record) =>
					record.type === "childList" &&
					(record.addedNodes.length > 0 || record.removedNodes.length > 0),
			);
			if (!hasAddedContent) return;
			this.scheduleRescan();
		});
		this.observer.observe(document.body, { childList: true, subtree: true });
	}

	private scheduleRescan(): void {
		if (this.rescanTimer) clearTimeout(this.rescanTimer);
		this.rescanTimer = setTimeout(() => {
			this.rescanTimer = null;
			if (this.language === this.defaultLanguage) return;
			void this.translateCurrent();
		}, RESCAN_DEBOUNCE_MS);
	}

	destroy(): void {
		this.cancelInFlight();
		if (this.rescanTimer) {
			clearTimeout(this.rescanTimer);
			this.rescanTimer = null;
		}
		this.observer?.disconnect();
		this.observer = null;
		this.initialized = false;
	}

	/**
	 * 立刻中断正在飞行的翻译请求。
	 * 只由「访客主动切换语言 / 翻译源」和 destroy 调用；
	 * 动态内容触发的补翻不打断，而是等当前这轮结束后补齐。
	 */
	private cancelInFlight(): void {
		const controller = this.requestController;
		this.requestController = null;
		controller?.abort();
	}

	// ---------------------------------------------------------------- 语言切换

	private applyDocumentLanguage(language: string): void {
		if (typeof document === "undefined") return;
		const root = document.documentElement;
		root.dataset.translateLanguage = language;
		// 翻译状态下把 <html lang> 切到目标语言，方便读屏与拼写检查；
		// 恢复原文时还原为页面自带的 lang，避免影响站点原有语义。
		if (language === this.defaultLanguage) {
			if (this.originalHtmlLang) root.lang = this.originalHtmlLang;
			return;
		}
		root.lang = language;
	}

	/**
	 * 切换语言。
	 * @param code 目标语言代码
	 * @param options.manual 是否由访客手动选择（决定是否写入偏好并被自动识别尊重）
	 */
	setLanguage(code: string, options: { manual?: boolean } = {}): void {
		const target = normalizeLanguageCode(code) || this.defaultLanguage;

		if (options.manual) {
			setStoredLanguage(target);
			setLanguageManuallyChosen(true);
		}

		if (target === this.language) {
			// 手动再次点选同一语言时允许强制重试
			if (!options.manual || target === this.defaultLanguage) {
				this.emitStatus();
				return;
			}
		}

		this.language = target;
		this.error = null;
		this.stats = { translated: 0, cached: 0, skipped: 0, unchanged: 0 };
		this.progress = 0;
		this.pendingRescan = false;
		this.applyDocumentLanguage(target);
		// 语言变了，旧语言的请求再等下去也没意义，直接掐断
		this.cancelInFlight();

		if (target === this.defaultLanguage) {
			this.runToken += 1; // 取消进行中的翻译
			this.restoreAll();
			this.loading = false;
			this.progress = 0;
			if (typeof document !== "undefined") {
				document.documentElement.dataset.translateLoading = "false";
			}
			this.emitStatus();
			return;
		}

		void this.translateCurrent();
	}

	/**
	 * 切换翻译源（翻译适配器）。
	 *
	 * 不同翻译源的译文不同，所以会先清空本地缓存、把页面恢复成原文，
	 * 再按新的翻译源整页重译。
	 */
	setProvider(id: string): void {
		if (!isTranslateProviderId(id)) {
			this.emitStatus();
			return;
		}

		const changed = id !== this.provider;
		this.provider = id;
		this.providerChosen = true;
		setStoredProvider(id);

		if (!changed) {
			this.emitStatus();
			return;
		}

		clearTranslationCache();
		this.error = null;
		this.stats = { translated: 0, cached: 0, skipped: 0, unchanged: 0 };
		this.progress = 0;
		this.runToken += 1; // 旧这一轮的 token 立即作废
		this.pendingRescan = false;
		// 旧翻译源的结果已经没用了，立刻掐断它的请求
		this.cancelInFlight();

		if (this.language === this.defaultLanguage) {
			this.emitStatus();
			return;
		}

		// 清掉「已应用」标记：collectGroups 会重新收集这些节点，
		// 页面先留着旧译文，等新翻译源的结果回来再整体替换，避免闪回原文
		this.clearAppliedMarks();
		this.emitStatus();
		void this.translateCurrent();
	}

	/** 恢复原文 */
	resetToDefault(options: { manual?: boolean } = {}): void {
		this.setLanguage(this.defaultLanguage, options);
	}

	/**
	 * 遍历当前 DOM，把所有由引擎写回的译文恢复为原文。
	 * 只需要再走一遍 TreeWalker，配合 WeakMap 里的原文即可，无需额外索引。
	 */
	restoreAll(): number {
		if (typeof document === "undefined" || !document.body) return 0;
		let restored = 0;
		this.applying = true;
		resetSkipCache();
		try {
			const walker = this.createWalker(document.body);
			let current = walker.nextNode();
			while (current) {
				const text = current as Text;
				const original = originals.get(text);
				if (original !== undefined) {
					if (text.data !== original) text.data = original;
					appliedLanguages.delete(text);
					text.parentElement?.removeAttribute(APPLIED_ATTR);
					restored += 1;
				}
				current = walker.nextNode();
			}
		} finally {
			this.applying = false;
		}
		return restored;
	}

	/**
	 * 只清掉「该节点已翻成某语言」的标记，不动 DOM 文本。
	 * 切换翻译源时用：旧译文继续显示，避免页面先闪回原文再变译文。
	 */
	private clearAppliedMarks(): void {
		if (typeof document === "undefined" || !document.body) return;
		resetSkipCache();
		const walker = this.createWalker(document.body);
		let current = walker.nextNode();
		while (current) {
			appliedLanguages.delete(current as Text);
			current = walker.nextNode();
		}
	}

	// ---------------------------------------------------------------- 翻译主流程

	async translateCurrent(): Promise<void> {
		if (typeof document === "undefined" || !document.body) return;
		if (this.running) {
			// 动态内容触发的补翻不打断当前这轮，等它跑完再增量补齐；
			// 访客主动切换语言 / 翻译源时已先 cancelInFlight()，这里负责排队重译。
			this.pendingRescan = true;
			return;
		}

		this.running = true;
		this.error = null;
		try {
			do {
				this.pendingRescan = false;
				const target = this.language;
				if (target === this.defaultLanguage) break;

				const controller = new AbortController();
				this.requestController = controller;
				this.setLoading(true, 0);
				try {
					await this.performTranslation(target, ++this.runToken, controller.signal);
				} catch (error) {
					// 被访客中断（切换语言 / 翻译源）：不当错误，
					// 交给 while 条件判断是否立刻用新配置重译
					if (!(error instanceof TranslateCancelledError)) throw error;
				} finally {
					if (this.requestController === controller) {
						this.requestController = null;
					}
				}
			} while (
				this.pendingRescan &&
				this.language !== this.defaultLanguage &&
				this.initialized
			);
		} catch (error) {
			this.error =
				error instanceof Error ? error.message : "翻译失败，请稍后重试";
		} finally {
			this.running = false;
			this.requestController = null;
			this.setLoading(false, 0);
		}
	}

	private async performTranslation(
		target: string,
		token: number,
		signal: AbortSignal,
	): Promise<void> {
		// 每次全量扫描前清空跳过判定缓存，避免动态属性变化后判定过期
		const groups = this.collectGroups(target);
		if (groups.length === 0) return;

		const batches = this.buildBatches(groups);
		let processed = 0;

		for (const batch of batches) {
			if (this.language !== target || token !== this.runToken) return;

			const needRemote: TextGroup[] = [];
			for (const group of batch.groups) {
				const cached = getCachedTranslation(target, group.original);
				if (cached !== undefined) {
					this.applyGroup(group, cached, target);
					this.stats.cached += 1;
				} else {
					needRemote.push(group);
				}
			}

			if (needRemote.length > 0) {
				const translations = await this.requestTranslation(
					needRemote.map((group) => group.original),
					target,
					signal,
				);
				if (this.language !== target || token !== this.runToken) return;
				for (let i = 0; i < needRemote.length; i += 1) {
					const group = needRemote[i];
					const returned = translations[i];
					const value =
						typeof returned === "string" && returned.trim().length > 0
							? returned
							: group.original;
					setCachedTranslation(target, group.original, value);
					this.applyGroup(group, value, target);
					if (value === group.original) this.stats.unchanged += 1;
					else this.stats.translated += 1;
				}
			}

			processed += batch.groups.length;
			this.progress = Math.min(1, processed / groups.length);
			this.emitStatus();

			// 不可见内容放到空闲时间再翻，避免阻塞首屏
			if (!batch.visible) await idleYield();
		}
	}

	private async requestTranslation(
		texts: string[],
		target: string,
		signal: AbortSignal,
	): Promise<string[]> {
		// controller 负责超时，signal 是引擎级的「切换语言 / 翻译源」中断
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, REQUEST_TIMEOUT_MS);
		const abortFromOutside = () => controller.abort();
		if (signal.aborted) {
			controller.abort();
		} else {
			signal.addEventListener("abort", abortFromOutside, { once: true });
		}

		try {
			const response = await fetch("/api/translate", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					texts,
					source: SOURCE_LANGUAGE,
					target,
					// 未手动选择过翻译源时不带 provider，使用服务端默认
					provider:
						this.providerChosen && this.provider ? this.provider : undefined,
				}),
				cache: "no-store",
				signal: controller.signal,
			});

			const payload = (await response
				.json()
				.catch(() => null)) as TranslateResponsePayload | null;

			if (
				!response.ok ||
				!payload ||
				payload.ok !== true ||
				!Array.isArray(payload.translations)
			) {
				const message =
					payload && payload.ok === false && payload.message
						? payload.message
						: `翻译服务返回异常（HTTP ${response.status}）`;
				throw new Error(message);
			}

			if (payload.translations.length !== texts.length) {
				throw new Error("翻译结果数量与请求不一致");
			}

			if (typeof payload.provider === "string" && payload.provider) {
				this.provider = payload.provider;
			}

			return payload.translations;
		} catch (error) {
			if (isAbortError(error)) {
				if (timedOut) throw new Error("翻译请求超时");
				// 被访客切换语言 / 翻译源掐断，交给上层静默处理
				throw new TranslateCancelledError();
			}
			throw error;
		} finally {
			clearTimeout(timer);
			signal.removeEventListener("abort", abortFromOutside);
		}
	}

	/** 把译文写入 DOM，并记录原文，防止 MutationObserver 循环触发 */
	private applyGroup(group: TextGroup, translated: string, target: string): void {
		this.applying = true;
		try {
			for (const node of group.nodes) {
				if (!node.isConnected) continue;
				if (originals.get(node) === undefined) {
					originals.set(node, group.original);
				}
				if (node.data !== translated) node.data = translated;
				appliedLanguages.set(node, target);
				node.parentElement?.setAttribute(APPLIED_ATTR, target);
			}
		} finally {
			this.applying = false;
		}
	}

	// ------------------------------------------------------------------ DOM 扫描

	private createWalker(root: Node): TreeWalker {
		return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (node: Node) => {
				const element = (node as Text).parentElement;
				if (!element) return NodeFilter.FILTER_REJECT;
				if (isSkippedElement(element)) {
					return NodeFilter.FILTER_REJECT;
				}
				return NodeFilter.FILTER_ACCEPT;
			},
		});
	}

	private collectGroups(target: string): TextGroup[] {
		const byOriginal = new Map<string, TextGroup>();
		resetSkipCache();
		const walker = this.createWalker(document.body);
		let order = 0;
		let skipped = 0;
		let current = walker.nextNode();

		while (current) {
			const text = current as Text;
			current = walker.nextNode();

			if (!text.isConnected) continue;
			const value = text.data;
			if (!value || !value.trim()) {
				continue;
			}

			// 该节点已经翻成了当前目标语言，无需重复处理
			if (appliedLanguages.get(text) === target) continue;

			let original = originals.get(text);
			if (original === undefined) {
				// 首次遇到：可能是原文，也可能是页面缓存带回来的译文
				const reversed = findOriginalByTranslated(target, value);
				if (reversed !== undefined && reversed !== value) {
					original = reversed;
					originals.set(text, reversed);
				} else if (hasAppliedMarker(text.parentElement, target)) {
					// 已翻译但查不到原文（页面缓存场景），保守跳过，避免二次翻译
					skipped += 1;
					continue;
				} else {
					original = value;
				}
			}

			if (!shouldTranslateText(original)) {
				if (original === value) skipped += 1;
				continue;
			}

			const existing = byOriginal.get(original);
			if (existing) {
				existing.nodes.push(text);
				continue;
			}
			byOriginal.set(original, {
				original,
				nodes: [text],
				visible: false,
				order: order,
			});
			order += 1;
		}

		this.stats.skipped = skipped;

		const groups = [...byOriginal.values()];
		// 可见区域优先：先读完全部布局信息再排序，避免读写交错引发反复重排
		for (const group of groups) {
			group.visible = isNodeVisible(group.nodes[0]);
		}
		groups.sort((a, b) => {
			if (a.visible !== b.visible) return a.visible ? -1 : 1;
			return a.order - b.order;
		});
		return groups;
	}

	private buildBatches(groups: TextGroup[]): Batch[] {
		const batches: Batch[] = [];
		let current: TextGroup[] = [];
		let chars = 0;

		const flush = () => {
			if (current.length === 0) return;
			batches.push({
				groups: current,
				visible: current.some((group) => group.visible),
			});
			current = [];
			chars = 0;
		};

		for (const group of groups) {
			const size = group.original.length;
			if (
				current.length > 0 &&
				(current.length >= BATCH_MAX_ITEMS || chars + size > BATCH_MAX_CHARS)
			) {
				flush();
			}
			current.push(group);
			chars += size;
		}
		flush();

		// 可见批次优先执行，保证首屏尽快显示译文
		return batches.sort((a, b) => Number(b.visible) - Number(a.visible));
	}
}

function hasAppliedMarker(element: Element | null, target: string): boolean {
	let node: Element | null = element;
	let depth = 0;
	while (node && depth < 4) {
		if (node.getAttribute(APPLIED_ATTR) === target) return true;
		node = node.parentElement;
		depth += 1;
	}
	return false;
}

function isNodeVisible(node: Text): boolean {
	if (typeof window === "undefined") return false;
	const element = node.parentElement;
	if (!element) return false;
	const rect = element.getBoundingClientRect();
	if (rect.width === 0 && rect.height === 0) return false;
	const viewportHeight =
		window.innerHeight || document.documentElement.clientHeight || 0;
	const margin = 240;
	return rect.bottom > -margin && rect.top < viewportHeight + margin;
}

let engineInstance: TranslateEngine | null = null;

/** 获取全局单例引擎（只在客户端调用） */
export function getTranslateEngine(): TranslateEngine {
	if (!engineInstance) engineInstance = new TranslateEngine();
	return engineInstance;
}
