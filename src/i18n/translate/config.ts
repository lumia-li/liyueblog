/**
 * 智能多语言翻译：客户端配置。
 *
 * 这里只放「可以公开」的配置；术语表、忽略词、API Key 一律放在服务端
 * （见 src/server/translate/glossary.ts 与各翻译适配器），避免泄露逻辑与密钥。
 */

/**
 * 原文语言（站点正文的真实语言）。
 * 语言切换器里的「原文 / Original」项就是它，切回它即恢复原文。
 *
 * 注意：它与 `siteConfig.lang` 相互独立 —— `siteConfig.lang` 只用于 <html lang>，
 * 而这里描述的是「正文本身是什么语言」。若以后正文换成英文，改这里即可。
 */
export const DEFAULT_CONTENT_LANGUAGE = "zh";

/**
 * 发送给翻译服务的源语言。
 * `auto` 表示交给翻译服务自动检测，对多语言混排的正文最稳妥。
 */
export const SOURCE_LANGUAGE = "auto";

/**
 * 翻译服务相关逻辑全部在服务端（src/server/translate），密钥与术语表不会下发到浏览器。
 *
 * 翻译通道（providers/index.ts）已启用两个，访客可在语言面板顶部自行切换：
 * - translatejs —— translate.js 免费通道（translate.service，无需注册、无需密钥）
 *   项目地址 https://github.com/xnx3/translate
 * - edge —— 微软 Edge 翻译接口（edge.microsoft.com，同样无需密钥）
 *
 * 批大小设计依据：translate.service 单次可接受 50 条文本（实测），
 * 但官方有「2 秒内最多 2 次请求」的频率防护，所以服务端做了串行 + 最小间隔 + 重试。
 */

/** 是否在访客「从未手动选择过语言」时按浏览器语言自动切换 */
export const ENABLE_AUTO_DETECT = true;

/** 单次请求（单个批次）最多文本条数 */
export const BATCH_MAX_ITEMS = 40;

/** 单次请求（单个批次）最多字符总数 */
export const BATCH_MAX_CHARS = 4000;

/** 单个请求超时时间（毫秒） */
export const REQUEST_TIMEOUT_MS = 15000;

/** 本地缓存有效期（天） */
export const CACHE_TTL_DAYS = 30;

/** 本地缓存最大条目数，超出后淘汰最旧的记录 */
export const CACHE_MAX_ENTRIES = 2000;

/** MutationObserver 防抖间隔（毫秒），避免动态内容抖动导致频繁翻译 */
export const RESCAN_DEBOUNCE_MS = 260;
