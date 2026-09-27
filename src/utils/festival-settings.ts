// 节日效果开关
// - 全站生效的开关值存在仓库里的 src/data/festival.json（构建时打包进静态页）
// - 站内开发者控制台 /dev 保存后会提交该文件并触发重新部署
// - 保存的同时会写一份本机预览，让自己立刻看到效果，等部署完成后自动清理
export type FestivalFlags = {
	midAutumn: boolean;
	newYear: boolean;
	nationalDay: boolean;
	/** 进入网站就自动播放当前的节日效果（不用手动触发按钮） */
	autoPlay: boolean;
	/** 自动播放的页面范围：false = 只在主页，true = 任何页面进站都播 */
	autoPlayAllPages: boolean;
};

/** 三个互斥的节日开关（autoPlay / autoPlayAllPages 是独立开关，不参与互斥） */
export type FestivalKey = "midAutumn" | "newYear" | "nationalDay";

/** 全部配置字段：用于「按字段合并」与「整体比较」，新增字段时只改这一处 */
const FESTIVAL_FLAG_KEYS: readonly (keyof FestivalFlags)[] = [
	"midAutumn",
	"newYear",
	"nationalDay",
	"autoPlay",
	"autoPlayAllPages",
];

export type FestivalMode = "mid-autumn" | "new-year" | "national-day" | "none";

/** 仓库里节日配置文件的路径（构建期读取 + 控制台写入都用它） */
export const FESTIVAL_CONFIG_REPO_PATH = "src/data/festival.json";

/**
 * 本机即时预览用的 localStorage 键
 * 字段增删时换版本号：否则老预览里缺少的新开关会被解析成「关闭」，把构建配置也压掉
 */
export const FESTIVAL_PREVIEW_STORAGE_KEY = "festivalLocalPreviewV2";

/** 旧版本的预览键：读到新键时顺手清掉 */
const LEGACY_FESTIVAL_PREVIEW_KEYS = ["festivalLocalPreview"];

/** 控制台保存后广播这个事件，页面里的灯笼组件收到后立刻切换 */
export const FESTIVAL_SETTINGS_CHANGE_EVENT = "festival-settings-change";

export function resolveFestivalMode(flags: FestivalFlags): FestivalMode {
	if (flags.midAutumn) return "mid-autumn";
	if (flags.newYear) return "new-year";
	if (flags.nationalDay) return "national-day";
	return "none";
}

function canUseStorage(): boolean {
	try {
		return (
			typeof window !== "undefined" &&
			typeof window.localStorage !== "undefined"
		);
	} catch {
		return false;
	}
}

export function normalizeFestivalFlags(value: unknown): FestivalFlags | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as {
		midAutumn?: unknown;
		newYear?: unknown;
		nationalDay?: unknown;
		autoPlay?: unknown;
		autoPlayAllPages?: unknown;
	};
	if (typeof raw.midAutumn !== "boolean" || typeof raw.newYear !== "boolean") {
		return null;
	}
	// 国庆、自动播放、自动播放范围都是后加的字段：老配置里没有时按关闭处理
	return {
		midAutumn: raw.midAutumn,
		newYear: raw.newYear,
		nationalDay: raw.nationalDay === true,
		autoPlay: raw.autoPlay === true,
		autoPlayAllPages: raw.autoPlayAllPages === true,
	};
}

function clearLegacyFestivalPreview(): void {
	if (!canUseStorage()) return;
	try {
		for (const key of LEGACY_FESTIVAL_PREVIEW_KEYS) {
			localStorage.removeItem(key);
		}
	} catch {
		// 存储不可用时忽略
	}
}

/**
 * 只挑出实际存在的布尔字段：缺失的字段（老预览、以后新加的开关）保持 undefined，
 * 由构建期配置兜底，避免被解析成 false 把新开关压掉
 */
function parseFestivalPreviewFields(
	value: unknown,
): Partial<FestivalFlags> | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const fields: Partial<FestivalFlags> = {};
	for (const key of FESTIVAL_FLAG_KEYS) {
		const field = raw[key];
		if (typeof field === "boolean") {
			fields[key] = field;
		}
	}
	return Object.keys(fields).length > 0 ? fields : null;
}

export function readFestivalPreview(): Partial<FestivalFlags> | null {
	if (!canUseStorage()) return null;
	clearLegacyFestivalPreview();
	try {
		const raw = localStorage.getItem(FESTIVAL_PREVIEW_STORAGE_KEY);
		if (!raw) return null;
		return parseFestivalPreviewFields(JSON.parse(raw));
	} catch {
		return null;
	}
}

export function writeFestivalPreview(flags: FestivalFlags): void {
	if (!canUseStorage()) return;
	try {
		localStorage.setItem(FESTIVAL_PREVIEW_STORAGE_KEY, JSON.stringify(flags));
	} catch {
		// 存储不可用时忽略，不影响线上开关
	}
}

export function clearFestivalPreview(): void {
	if (!canUseStorage()) return;
	try {
		localStorage.removeItem(FESTIVAL_PREVIEW_STORAGE_KEY);
	} catch {
		// 存储不可用时忽略
	}
	clearLegacyFestivalPreview();
}

function isSameFestivalFlags(a: FestivalFlags, b: FestivalFlags): boolean {
	return FESTIVAL_FLAG_KEYS.every((key) => a[key] === b[key]);
}

/**
 * 本机预览优先于构建期配置，但预览里缺的字段沿用构建期配置；
 * 两者完全一致（说明部署已生效）时顺手清掉预览
 */
export function resolveFestivalFlags(buildFlags: FestivalFlags): FestivalFlags {
	const preview = readFestivalPreview();
	if (!preview) return buildFlags;
	const merged: FestivalFlags = { ...buildFlags, ...preview };
	if (isSameFestivalFlags(merged, buildFlags)) {
		clearFestivalPreview();
		return buildFlags;
	}
	return merged;
}

export function emitFestivalSettingsChange(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(FESTIVAL_SETTINGS_CHANGE_EVENT));
}
