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

	/** 计数存储：Upstash Redis REST 地址（Vercel Marketplace 集成 Upstash 后自动注入） */
	readonly UPSTASH_REDIS_REST_URL?: string;
	/** 计数存储：Upstash Redis REST 令牌 */
	readonly UPSTASH_REDIS_REST_TOKEN?: string;
	/** 兼容 Vercel KV 注入的变量名 */
	readonly KV_REST_API_URL?: string;
	readonly KV_REST_API_TOKEN?: string;
	/** 兼容自定义命名 */
	readonly COUNT_REDIS_URL?: string;
	readonly COUNT_REDIS_TOKEN?: string;
	/** UV 哈希盐值；更换后所有访客会被当成新访客重新计入 UV */
	readonly COUNT_SALT?: string;
}
