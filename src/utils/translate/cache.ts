import {
	CACHE_MAX_ENTRIES,
	CACHE_TTL_DAYS,
} from "@i18n/translate/config";

/**
 * 客户端翻译缓存与语言偏好存储。
 *
 * - 翻译结果按 `目标语言 + 原文` 缓存，二次切换 / 刷新后可直接命中，不再请求服务端。
 * - 同时维护「译文 → 原文」反向索引，用于 Swup 之类的页面缓存场景：
 *   重新插入的 DOM 里可能已经是译文，借助反向索引仍能还原原文。
 * - 语言偏好与「是否手动选择过」分开存储，实现默认语言与访客选择的分离。
 */

const CACHE_STORAGE_KEY = "liyue.translate.cache.v1";
const LANGUAGE_STORAGE_KEY = "liyue.translate.language";
const LANGUAGE_MANUAL_STORAGE_KEY = "liyue.translate.language.manual";

const TTL_MS = CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;

/** [原文, 译文, 写入时间] */
type CacheEntry = [string, string, number];
type CacheStore = { v: 1; entries: Record<string, CacheEntry> };

let store: CacheStore | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 目标语言 → (译文 → 原文) */
const reverseIndex = new Map<string, Map<string, string>>();
let reverseReady = false;

function canUseStorage(): boolean {
	try {
		return (
			typeof window !== "undefined" && typeof window.localStorage !== "undefined"
		);
	} catch {
		return false;
	}
}

function hashText(text: string): string {
	let hash = 5381;
	for (let i = 0; i < text.length; i += 1) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
	}
	return hash.toString(36);
}

function entryKey(target: string, original: string): string {
	return `${target}::${hashText(original)}`;
}

function splitEntryKey(key: string): { target: string; hash: string } {
	const index = key.indexOf("::");
	if (index < 0) return { target: "", hash: key };
	return { target: key.slice(0, index), hash: key.slice(index + 2) };
}

function isEntry(value: unknown): value is CacheEntry {
	return (
		Array.isArray(value) &&
		value.length === 3 &&
		typeof value[0] === "string" &&
		typeof value[1] === "string" &&
		typeof value[2] === "number"
	);
}

function pruneExpired(target: CacheStore): void {
	const now = Date.now();
	const keys = Object.keys(target.entries);
	for (const key of keys) {
		const entry = target.entries[key];
		if (!isEntry(entry) || now - entry[2] > TTL_MS) {
			delete target.entries[key];
		}
	}

	const remaining = Object.keys(target.entries);
	if (remaining.length <= CACHE_MAX_ENTRIES) return;

	remaining.sort(
		(a, b) => (target.entries[a]?.[2] ?? 0) - (target.entries[b]?.[2] ?? 0),
	);
	const overflow = remaining.length - CACHE_MAX_ENTRIES;
	for (let i = 0; i < overflow; i += 1) {
		delete target.entries[remaining[i]];
	}
}

function loadStore(): CacheStore {
	if (store) return store;
	store = { v: 1, entries: {} };
	if (!canUseStorage()) return store;
	try {
		const raw = localStorage.getItem(CACHE_STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as CacheStore | null;
			if (
				parsed &&
				parsed.v === 1 &&
				parsed.entries &&
				typeof parsed.entries === "object"
			) {
				store = parsed;
			}
		}
	} catch {
		/* 解析失败时使用空缓存 */
	}
	pruneExpired(store);
	return store;
}

function scheduleSave(): void {
	if (!canUseStorage() || saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		try {
			localStorage.setItem(CACHE_STORAGE_KEY, JSON.stringify(loadStore()));
		} catch {
			/* 超出配额时静默失败，页面仍可正常翻译 */
		}
	}, SAVE_DEBOUNCE_MS);
}

/** 读取缓存译文；未命中或已过期返回 undefined */
export function getCachedTranslation(
	target: string,
	original: string,
): string | undefined {
	if (!target || !original) return undefined;
	const current = loadStore();
	const key = entryKey(target, original);
	const entry = current.entries[key];
	if (!isEntry(entry)) return undefined;
	if (entry[0] !== original) return undefined; // 哈希碰撞保护
	if (Date.now() - entry[2] > TTL_MS) {
		delete current.entries[key];
		scheduleSave();
		return undefined;
	}
	return entry[1];
}

/** 写入缓存译文 */
export function setCachedTranslation(
	target: string,
	original: string,
	translated: string,
): void {
	if (!target || !original || typeof translated !== "string") return;
	const current = loadStore();
	const key = entryKey(target, original);
	current.entries[key] = [original, translated, Date.now()];
	// 反向索引已建立时顺手同步，避免每次查询都要全量重建
	if (reverseReady) {
		let bucket = reverseIndex.get(target);
		if (!bucket) {
			bucket = new Map<string, string>();
			reverseIndex.set(target, bucket);
		}
		bucket.set(translated, original);
	}
	pruneExpired(current);
	scheduleSave();
}

function ensureReverseIndex(): void {
	if (reverseReady) return;
	reverseReady = true;
	const current = loadStore();
	for (const key of Object.keys(current.entries)) {
		const entry = current.entries[key];
		if (!isEntry(entry)) continue;
		const { target } = splitEntryKey(key);
		if (!target) continue;
		let bucket = reverseIndex.get(target);
		if (!bucket) {
			bucket = new Map<string, string>();
			reverseIndex.set(target, bucket);
		}
		bucket.set(entry[1], entry[0]);
	}
}

/**
 * 反向查询：已知某段译文，尝试找出它对应的原文。
 * 用于还原「被页面缓存带回来的已翻译 DOM」。
 */
export function findOriginalByTranslated(
	target: string,
	translated: string,
): string | undefined {
	if (!target || !translated) return undefined;
	ensureReverseIndex();
	return reverseIndex.get(target)?.get(translated);
}

/** 清空本地翻译缓存（不清理语言偏好） */
export function clearTranslationCache(): void {
	store = { v: 1, entries: {} };
	reverseIndex.clear();
	reverseReady = false;
	if (canUseStorage()) {
		try {
			localStorage.removeItem(CACHE_STORAGE_KEY);
		} catch {
			/* ignore */
		}
	}
}

/** 缓存统计（调试 / UI 展示用） */
export function getCacheStats(): { entries: number; languages: number } {
	const current = loadStore();
	const languages = new Set<string>();
	for (const key of Object.keys(current.entries)) {
		const { target } = splitEntryKey(key);
		if (target) languages.add(target);
	}
	return { entries: Object.keys(current.entries).length, languages: languages.size };
}

/** 读取访客上次选择的语言（未选择过则为 null） */
export function getStoredLanguage(): string | null {
	if (!canUseStorage()) return null;
	try {
		const value = localStorage.getItem(LANGUAGE_STORAGE_KEY);
		return value && value.trim() ? value.trim() : null;
	} catch {
		return null;
	}
}

/** 记住访客选择的语言 */
export function setStoredLanguage(code: string): void {
	if (!canUseStorage()) return;
	try {
		localStorage.setItem(LANGUAGE_STORAGE_KEY, code);
	} catch {
		/* ignore */
	}
}

/** 访客是否手动选择过语言（用于决定是否允许自动识别覆盖） */
export function isLanguageManuallyChosen(): boolean {
	if (!canUseStorage()) return false;
	try {
		return localStorage.getItem(LANGUAGE_MANUAL_STORAGE_KEY) === "true";
	} catch {
		return false;
	}
}

/** 标记 / 取消「手动选择过语言」 */
export function setLanguageManuallyChosen(value: boolean): void {
	if (!canUseStorage()) return;
	try {
		localStorage.setItem(LANGUAGE_MANUAL_STORAGE_KEY, value ? "true" : "false");
	} catch {
		/* ignore */
	}
}
