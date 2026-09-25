// 节日效果开关
// - 全站生效的开关值存在仓库里的 src/data/festival.json（构建时打包进静态页）
// - 站内开发者控制台 /dev 保存后会提交该文件并触发重新部署
// - 保存的同时会写一份本机预览，让自己立刻看到效果，等部署完成后自动清理
export type FestivalFlags = {
	midAutumn: boolean;
	newYear: boolean;
	nationalDay: boolean;
};

export type FestivalMode = "mid-autumn" | "new-year" | "national-day" | "none";

/** 仓库里节日配置文件的路径（构建期读取 + 控制台写入都用它） */
export const FESTIVAL_CONFIG_REPO_PATH = "src/data/festival.json";

/** 本机即时预览用的 localStorage 键 */
export const FESTIVAL_PREVIEW_STORAGE_KEY = "festivalLocalPreview";

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
	};
	if (typeof raw.midAutumn !== "boolean" || typeof raw.newYear !== "boolean") {
		return null;
	}
	// 国庆是后加的字段：老配置里没有时按关闭处理
	return {
		midAutumn: raw.midAutumn,
		newYear: raw.newYear,
		nationalDay: raw.nationalDay === true,
	};
}

export function readFestivalPreview(): FestivalFlags | null {
	if (!canUseStorage()) return null;
	try {
		const raw = localStorage.getItem(FESTIVAL_PREVIEW_STORAGE_KEY);
		if (!raw) return null;
		return normalizeFestivalFlags(JSON.parse(raw));
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
}

/**
 * 本机预览优先于构建期配置；两者一旦一致（说明部署已生效）就顺手清掉预览
 */
export function resolveFestivalFlags(buildFlags: FestivalFlags): FestivalFlags {
	const preview = readFestivalPreview();
	if (!preview) return buildFlags;
	if (
		preview.midAutumn === buildFlags.midAutumn &&
		preview.newYear === buildFlags.newYear
	) {
		clearFestivalPreview();
		return buildFlags;
	}
	return preview;
}

export function emitFestivalSettingsChange(): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(FESTIVAL_SETTINGS_CHANGE_EVENT));
}
