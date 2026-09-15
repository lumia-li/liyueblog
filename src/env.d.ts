/// <reference types="astro/client" />
/// <reference path="../.astro/types.d.ts" />

/**
 * 服务端环境变量类型声明。
 * 注意：这些变量都不带 PUBLIC_ 前缀，只会在服务端可用，不会被打包进浏览器产物。
 * 翻译相关变量全部可选：不配置任何一项即可正常翻译（访客可在面板里切换翻译源）。
 */
interface ImportMetaEnv {
	/** 默认翻译源（translatejs / edge）；留空即使用内置默认值 edge */
	readonly TRANSLATE_PROVIDER?: string;
	/** 覆盖 translate.service 地址（自建同名接口时可用） */
	readonly TRANSLATE_API_URL?: string;
	/** 覆盖微软 Edge 翻译接口地址（反向代理时可用） */
	readonly EDGE_TRANSLATE_API_URL?: string;
	/** 追加术语表（JSON 字符串） */
	readonly TRANSLATE_GLOSSARY?: string;
	/** 追加忽略词（逗号分隔） */
	readonly TRANSLATE_IGNORE_WORDS?: string;
}
