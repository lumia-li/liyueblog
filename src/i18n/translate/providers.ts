import type { TranslateProviderId } from "@/types/translate";

/**
 * 翻译源（服务端适配器）的前端目录。
 *
 * - `id` 必须与服务端注册表（src/server/translate/providers/index.ts）中的 id 一致；
 * - `label` 只用于面板里的短标签，服务端自带更完整的 label / detail 用于诊断接口；
 * - 想看某个翻译源当前是否可用，可以请求 GET /api/translate 的 `providers` 字段。
 */
export interface TranslateProviderOption {
	id: TranslateProviderId;
	/** 面板里的短标签 */
	label: string;
	/** 悬浮提示，说明这个翻译源的特点 */
	hint: string;
}

export const TRANSLATE_PROVIDER_OPTIONS: TranslateProviderOption[] = [
	{
		id: "edge",
		label: "微软翻译",
		hint: "微软 Edge 翻译接口，无需密钥，响应快、质量好，支持自动识别源语言",
	},
	{
		id: "translatejs",
		label: "translate.js",
		hint: "translate.service 公共免费通道，无需密钥、自带缓存；有频率限制，速度较慢",
	},
];

/** 默认翻译源：访客未手动选择时使用（服务端未配置 TRANSLATE_PROVIDER 时也用它） */
export const DEFAULT_TRANSLATE_PROVIDER: TranslateProviderId = "edge";

/** 判断字符串是否为已知的翻译源 id */
export function isTranslateProviderId(
	value: unknown,
): value is TranslateProviderId {
	return (
		typeof value === "string" &&
		TRANSLATE_PROVIDER_OPTIONS.some((option) => option.id === value)
	);
}

/** 取翻译源的展示信息，未知 id 返回 undefined */
export function getTranslateProviderOption(
	id: string,
): TranslateProviderOption | undefined {
	return TRANSLATE_PROVIDER_OPTIONS.find((option) => option.id === id);
}
