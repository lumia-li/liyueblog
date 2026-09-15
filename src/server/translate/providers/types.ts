/**
 * 翻译服务适配器接口。
 *
 * 已实现：translate.js 免费通道（translatejs）与微软 Edge 接口（edge）。
 * 想再接入其它服务：实现该接口、在 providers/index.ts 注册，
 * 并在 i18n/translate/providers.ts 里补一条面板短标签即可；
 * 其余逻辑（术语表保护、批量、限流、错误处理）完全复用。
 */
export interface ProviderTranslateInput {
	/** 待翻译文本（已去重、已做术语表占位符保护） */
	texts: string[];
	/** 源语言，`auto` 表示自动检测 */
	source: string;
	/** 目标语言 */
	target: string;
}

export interface ProviderDescription {
	/** 机器可读的运行模式，例如 translate-service-free */
	mode: string;
	/** 人类可读的补充说明 */
	detail: string;
}

export interface TranslationProvider {
	/** 适配器唯一 ID，对应请求体里的 provider / 环境变量 TRANSLATE_PROVIDER */
	id: string;
	/** 展示名称 */
	label: string;
	/** 是否可用（缺少必要配置时返回 false） */
	isConfigured(): boolean;
	/** 描述当前运行模式（可选，用于诊断接口） */
	describe?(): ProviderDescription;
	/** 翻译；返回数组长度必须与入参一致，失败时抛出异常 */
	translate(input: ProviderTranslateInput): Promise<string[]>;
}
