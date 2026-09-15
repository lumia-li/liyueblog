/**
 * 智能多语言翻译：前后端共享类型定义。
 */

/** 已内置实现的翻译服务适配器 ID */
export type TranslateProviderId = "translatejs" | "edge";

/** 翻译源（适配器）的运行时信息，由 GET /api/translate 返回 */
export interface TranslateProviderInfo {
	/** 适配器 ID，对应请求体里的 provider */
	id: string;
	/** 展示名称 */
	label: string;
	/** 是否可用（缺少必要配置时为 false） */
	configured: boolean;
	/** 运行模式，例如 edge-translate-public */
	mode: string;
	/** 运行模式说明 */
	detail: string;
}

/** 语言选项 */
export interface TranslateLanguage {
	/** 规范化语言代码，例如 zh / zh-TW / en / ja */
	code: string;
	/** 原生语言名称，展示给访客 */
	label: string;
	/** 英文名称，用于 aria-label 与提示 */
	englishName: string;
	/** 是否从右到左书写 */
	rtl?: boolean;
}

/**
 * 术语表。
 * - `{ "璃月": "Liyue" }`：单一译法
 * - `{ "璃月": { en: "Liyue", ja: "リーユエ" } }`：按目标语言分别指定
 */
export type TranslateGlossaryValue = string | Record<string, string>;
export type TranslateGlossary = Record<string, TranslateGlossaryValue>;

/** 客户端 → /api/translate 的请求体 */
export interface TranslateRequestPayload {
	/** 待翻译文本列表（客户端已做去重与批量切分） */
	texts: string[];
	/** 源语言，默认 auto（自动检测） */
	source?: string;
	/** 目标语言 */
	target: string;
	/** 可选：指定翻译源（翻译适配器 id），留空则使用默认翻译源 */
	provider?: TranslateProviderId;
	/** 可选：额外术语表（服务端内置术语表优先级更高） */
	glossary?: TranslateGlossary;
	/** 可选：额外忽略词（服务端内置忽略词优先） */
	ignoreWords?: string[];
}

/** /api/translate 成功响应 */
export interface TranslateSuccessPayload {
	ok: true;
	provider: string;
	translations: string[];
	requested: number;
	translated: number;
	returned: number;
}

/** /api/translate 失败响应 */
export interface TranslateErrorPayload {
	ok: false;
	message: string;
	code?: string;
}

export type TranslateResponsePayload =
	| TranslateSuccessPayload
	| TranslateErrorPayload;

/** 引擎统计信息 */
export interface TranslateStats {
	/** 实际发生变化的文本节点数 */
	translated: number;
	/** 命中本地缓存的文本数 */
	cached: number;
	/** 因规则跳过（无需翻译）的文本数 */
	skipped: number;
	/** 服务端返回与原文一致（无法翻译）的文本数 */
	unchanged: number;
}

/** 引擎对外暴露的状态（用于 UI 订阅） */
export interface TranslateStatusDetail {
	/** 当前生效语言 */
	language: string;
	/** 原文语言（默认语言） */
	defaultLanguage: string;
	/** 是否正在翻译 */
	loading: boolean;
	/** 进度 0~1 */
	progress: number;
	/** 当前使用的翻译源 id（默认翻译源或访客手动选择） */
	provider: string | null;
	/** 最近一次错误信息 */
	error: string | null;
	/** 统计信息 */
	stats: TranslateStats;
}

/** GET /api/translate 返回的运行时信息（不含任何密钥） */
export interface TranslateServiceInfo {
	ok: true;
	provider: string;
	providerLabel: string;
	configured: boolean;
	/** 运行模式，例如 translate-service-free */
	mode: string;
	/** 运行模式说明 */
	detail: string;
	/** 全部已启用的翻译源（供面板切换使用） */
	providers: TranslateProviderInfo[];
	supportedLanguages: string[];
	maxTexts: number;
	maxTotalChars: number;
	glossarySize: number;
	ignoreWordsSize: number;
}
