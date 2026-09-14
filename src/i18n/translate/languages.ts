import { DEFAULT_CONTENT_LANGUAGE } from "@i18n/translate/config";
import type { TranslateLanguage } from "@/types/translate";

/**
 * 语言切换器可选语言列表。
 * 想增删语言：在这里增删条目即可，服务端适配器会自动映射语言代码。
 */
export const SUPPORTED_LANGUAGES: TranslateLanguage[] = [
	{ code: "zh", label: "简体中文", englishName: "Chinese (Simplified)" },
	{ code: "zh-TW", label: "繁體中文", englishName: "Chinese (Traditional)" },
	{ code: "en", label: "English", englishName: "English" },
	{ code: "ja", label: "日本語", englishName: "Japanese" },
	{ code: "ko", label: "한국어", englishName: "Korean" },
	{ code: "fr", label: "Français", englishName: "French" },
	{ code: "de", label: "Deutsch", englishName: "German" },
	{ code: "es", label: "Español", englishName: "Spanish" },
	{ code: "ru", label: "Русский", englishName: "Russian" },
	{ code: "pt", label: "Português", englishName: "Portuguese" },
	{ code: "it", label: "Italiano", englishName: "Italian" },
	{ code: "ar", label: "العربية", englishName: "Arabic", rtl: true },
];

/** 支持的语言代码集合（服务端校验用） */
export const SUPPORTED_LANGUAGE_CODES: string[] = SUPPORTED_LANGUAGES.map(
	(item) => item.code,
);

/** 语言代码通用格式（服务端兜底校验用） */
export const LANGUAGE_CODE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** 把任意语言标记规范化为 `zh` / `zh-TW` / `en` 这类形式 */
export function normalizeLanguageCode(input: string): string {
	const raw = String(input ?? "")
		.trim()
		.replace(/_/g, "-");
	if (!raw) return "";
	const parts = raw.split("-").filter(Boolean);
	if (parts.length === 0) return "";

	const lang = parts[0].toLowerCase();
	const rest = parts.slice(1).join("-").toLowerCase();

	if (lang === "zh") {
		// 繁体变体统一成 zh-TW，简体 / 未标注统一成 zh
		if (
			rest.includes("hant") ||
			rest.includes("tw") ||
			rest.includes("hk") ||
			rest.includes("mo")
		) {
			return "zh-TW";
		}
		return "zh";
	}

	const normalizedRest = parts.slice(1).map((part) => {
		if (part.length === 2) return part.toUpperCase();
		if (part.length === 4) {
			return part[0].toUpperCase() + part.slice(1).toLowerCase();
		}
		return part.toLowerCase();
	});

	return [lang, ...normalizedRest].join("-");
}

/** 原文语言（默认语言） */
export function getDefaultLanguage(): string {
	return normalizeLanguageCode(DEFAULT_CONTENT_LANGUAGE) || "en";
}

/** 是否为受支持的语言 */
export function isSupportedLanguage(code: string): boolean {
	return SUPPORTED_LANGUAGE_CODES.includes(normalizeLanguageCode(code));
}

/** 取语言展示信息，未知语言时回退到代码本身 */
export function getLanguageLabel(code: string): string {
	const normalized = normalizeLanguageCode(code);
	const found = SUPPORTED_LANGUAGES.find((item) => item.code === normalized);
	return found ? found.label : normalized || code;
}

/**
 * 根据 navigator.language 匹配站内支持的语言。
 * 匹配不到时返回 null，由调用方回退到默认语言。
 */
export function resolveLanguageFromNavigator(
	navigatorLanguage: string,
): string | null {
	const normalized = normalizeLanguageCode(navigatorLanguage);
	if (!normalized) return null;
	if (isSupportedLanguage(normalized)) return normalized;

	// zh-CN / zh-Hans-CN 之类先归一到 zh / zh-TW 再匹配
	const base = normalized.split("-")[0];
	const found = SUPPORTED_LANGUAGES.find(
		(item) => item.code.split("-")[0] === base,
	);
	return found ? found.code : null;
}

/** 语言切换器的选项：第一项为「原文」，其余为可翻译语言 */
export interface TranslateSwitchOption {
	code: string;
	label: string;
	englishName: string;
	/** 是否为「恢复原文」项 */
	isOriginal: boolean;
	rtl: boolean;
}

export function buildSwitchOptions(
	defaultLanguage: string,
): TranslateSwitchOption[] {
	const original =
		SUPPORTED_LANGUAGES.find((item) => item.code === defaultLanguage) ?? null;

	const options: TranslateSwitchOption[] = [
		{
			code: defaultLanguage,
			label: original ? original.label : getLanguageLabel(defaultLanguage),
			englishName: original
				? original.englishName
				: `Original (${defaultLanguage})`,
			isOriginal: true,
			rtl: false,
		},
	];

	for (const item of SUPPORTED_LANGUAGES) {
		if (item.code === defaultLanguage) continue;
		options.push({
			code: item.code,
			label: item.label,
			englishName: item.englishName,
			isOriginal: false,
			rtl: Boolean(item.rtl),
		});
	}

	return options;
}
