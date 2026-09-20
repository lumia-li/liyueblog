/**
 * 友链申请时的服务端链接检测（src/pages/api/friend-apply.ts 用）。
 *
 * 只做两件事，都不引第三方依赖：
 *   1) 可达性：对方的站点、头像能不能打开（拿状态码就够）
 *   2) 双向链接：对方填的友链页里，有没有指向本站的链接
 *
 * 设计原则：**检测结果只是给站长看的参考，不拦提交**。
 * 很多站会挡数据中心 IP（403）、CDN 抽风、Cloudflare 挑战，
 * 硬性拦截会误杀正常申请，所以这里一律「记录结论 + 前端温和提示」。
 */

import { promises as dns } from "node:dns";

/** 用浏览器 UA 请求，减少被当爬虫直接 403 的概率 */
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** 读 HTML 的上限：只为了找一条链接，没必要把整页拉下来 */
const MAX_HTML_BYTES = 512 * 1024;

export type UrlCheck = {
	/** 状态码 < 400 才算通过 */
	ok: boolean;
	status?: number;
	/** 跟随重定向之后的最终地址 */
	finalUrl?: string;
	/** 给申请人看的「人话」原因 */
	reason?: string;
	/** 技术细节（错误码 + 原始信息），便于排查 */
	error?: string;
	/** 响应的 Content-Type（判断"是不是图片"用，例如抓头像时排除软 404 的 HTML） */
	contentType?: string;
	/**
	 * true = 这类失败「说不准」：可能是防爬（403）、限流、超时、
	 * 对方服务器抽风。这种不要拿去吓唬申请人，只记给站长看。
	 */
	ambiguous?: boolean;
};

/** 一次失败的判定结果 */
type FailureInfo = { reason: string; detail: string; ambiguous: boolean };

function requestHeaders(): Record<string, string> {
	return {
		"User-Agent": BROWSER_UA,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
	};
}

/** 常见 HTTP 状态码 → 申请人能看懂的解释（并判断这个失败是不是"说不准"） */
function describeStatus(status: number): FailureInfo {
	const detail = `HTTP ${status}`;
	if (status === 401) {
		return { reason: "HTTP 401（站点需要登录才能访问）", detail, ambiguous: false };
	}
	if (status === 403) {
		return {
			reason: "HTTP 403（对方站点可能在挡爬虫）",
			detail,
			ambiguous: true,
		};
	}
	if (status === 404 || status === 410) {
		return { reason: `HTTP ${status}（页面不存在，检查一下地址有没有写错）`, detail, ambiguous: false };
	}
	if (status === 429) {
		return { reason: "HTTP 429（对方站点限流）", detail, ambiguous: true };
	}
	if (status >= 500) {
		return { reason: `HTTP ${status}（对方服务器报错，可能只是临时故障）`, detail, ambiguous: true };
	}
	return { reason: `HTTP ${status}`, detail, ambiguous: true };
}

/**
 *
 * 注意：undici（Node / Vercel 上的 fetch）会把真正的原因塞进 `error.cause`，
 * 外层只有一句没用的 "fetch failed"——必须往下挖一层才看得出是域名没解析、
 * 还是连接超时、还是证书有问题。
 */
function describeFailure(error: unknown): FailureInfo {
	const toRecord = (value: unknown) =>
		value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;

	const cause = error instanceof Error ? error.cause : undefined;
	const causeRecord = toRecord(cause);
	const errorRecord = toRecord(error);
	const code = String(causeRecord?.code || errorRecord?.code || "").toUpperCase();
	const causeMessage = cause instanceof Error ? cause.message : cause ? String(cause) : "";
	const message = error instanceof Error ? error.message : String(error);
	const detail = [code, causeMessage || message].filter(Boolean).join(" ").slice(0, 160);
	const probe = `${code} ${causeMessage} ${message}`;

	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(probe)) {
		return {
			reason: "域名解析失败（地址可能拼错了，或者域名已经失效）",
			detail,
			ambiguous: false,
		};
	}
	if (/ECONNREFUSED/i.test(probe)) {
		return { reason: "连接被拒绝（对方服务器没有接受这次连接）", detail, ambiguous: false };
	}
	if (/CERT_HAS_EXPIRED|UNABLE_TO_VERIFY|certificate|self.signed|SSL|TLS/i.test(probe)) {
		return { reason: "HTTPS 证书有问题（浏览器里应该也会报警）", detail, ambiguous: false };
	}
	if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timed? ?out|aborted|TimeoutError/i.test(probe)) {
		return {
			reason: "连接超时（站点太慢，或者拒绝了来自服务器的请求）",
			detail,
			ambiguous: true,
		};
	}
	if (/ECONNRESET|UND_ERR_SOCKET|socket hang up/i.test(probe)) {
		return { reason: "连接被中断（对方可能拒绝了这次请求）", detail, ambiguous: true };
	}
	return {
		reason: "请求失败（对方可能屏蔽了服务器请求，或者站点暂时不可用）",
		detail,
		ambiguous: true,
	};
}

/** 按上限读取响应体文本（读满即断，避免把大页面整个拉进来） */
async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let received = 0;
	let text = "";
	try {
		for (; ;) {
			const { done, value } = await reader.read();
			if (done) break;
			received += value.byteLength;
			text += decoder.decode(value, { stream: true });
			if (received >= maxBytes) break;
		}
		text += decoder.decode();
	} catch {
		// 读一半断了也拿去匹配：友链链接通常在前半页
	} finally {
		await reader.cancel().catch(() => { });
	}
	return text;
}

// ── SSRF 防护 ──────────────────────────────────────────────────
// 这个检测是「以服务器身份访问用户填的任意地址」，必须挡住内网/本机，
// 否则别人可以拿它探测内网服务或云元数据接口（169.254.169.254）。

const PRIVATE_V4 = [
	/^0\./,
	/^10\./,
	/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
	/^127\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^192\.(0\.0|168)\./,
	/^198\.(18|19)\./,
	/^255\.255\.255\.255$/,
];

function isPrivateAddress(address: string): boolean {
	const ip = address.trim().toLowerCase();
	if (ip.includes(":")) {
		if (ip === "::1" || ip === "::") return true;
		if (/^f[cd]/.test(ip)) return true; // 唯一本地地址 fc00::/7
		if (/^fe[89ab]/.test(ip)) return true; // 链路本地 fe80::/10
		const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		return mapped ? isPrivateAddress(mapped[1]) : false;
	}
	return PRIVATE_V4.some((pattern) => pattern.test(ip));
}

function isBlockedHostname(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return (
		host === "localhost" ||
		host.endsWith(".localhost") ||
		host.endsWith(".local") ||
		host.endsWith(".internal") ||
		host.endsWith(".home.arpa")
	);
}

type GuardResult = { ok: true; url: URL } | { ok: false; info: FailureInfo };

/** 只允许公网 http(s) 地址；本地开发跳过内网限制，方便用 localhost 调试 */
async function guardUrl(rawUrl: string): Promise<GuardResult> {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return {
			ok: false,
			info: { reason: "地址格式不正确", detail: "invalid url", ambiguous: false },
		};
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return {
			ok: false,
			info: { reason: "只支持 http / https 地址", detail: parsed.protocol, ambiguous: false },
		};
	}
	if (import.meta.env.DEV) return { ok: true, url: parsed };

	if (isBlockedHostname(parsed.hostname)) {
		return {
			ok: false,
			info: {
				reason: "这个地址指向本机或内网，已拒绝检测",
				detail: `blocked host ${parsed.hostname}`,
				ambiguous: false,
			},
		};
	}
	try {
		const { address } = await dns.lookup(parsed.hostname);
		if (isPrivateAddress(address)) {
			return {
				ok: false,
				info: {
					reason: "这个地址指向内网，已拒绝检测",
					detail: `blocked ip ${address}`,
					ambiguous: false,
				},
			};
		}
	} catch {
		// 解析不了就交给后面的 fetch 去报「域名解析失败」，这里不拦
	}
	return { ok: true, url: parsed };
}

/**
 * 访问一个地址，返回是否可达（可选带上页面内容）。
 *
 * @param url       要检测的地址
 * @param timeoutMs 超时（默认 8 秒）；多个检测并行跑，整体耗时取最慢的那个
 * @param wantBody  是否需要页面内容（只有双向链接检测才需要）
 */
export async function fetchUrl(
	url: string,
	options: { timeoutMs?: number; wantBody?: boolean } = {},
): Promise<UrlCheck & { body?: string }> {
	const { timeoutMs = 8000, wantBody = false } = options;

	// 先过安全闸：挡掉内网/本机地址
	const guard = await guardUrl(url);
	if (!guard.ok) {
		return { ok: false, reason: guard.info.reason, error: guard.info.detail, ambiguous: false };
	}

	try {
		const response = await fetch(url, {
			headers: requestHeaders(),
			redirect: "follow",
			signal: AbortSignal.timeout(timeoutMs),
		});

		const ok = response.status < 400;
		const info = ok ? null : describeStatus(response.status);
		const result: UrlCheck & { body?: string } = {
			ok,
			status: response.status,
			finalUrl: response.url || url,
			contentType: (response.headers.get("content-type") || "").toLowerCase(),
			...(info ? { reason: info.reason, error: info.detail, ambiguous: info.ambiguous } : {}),
		};

		if (ok && wantBody) {
			result.body = await readTextLimited(response, MAX_HTML_BYTES);
		} else {
			// 不需要正文就别把内容拉回来
			await response.body?.cancel().catch(() => { });
		}

		return result;
	} catch (error) {
		const failure = describeFailure(error);
		return {
			ok: false,
			error: failure.detail,
			reason: failure.reason,
			ambiguous: failure.ambiguous,
		};
	}
}

// ── 头像自动抓取 ───────────────────────────────────────────────
// 申请人没填头像时，从他站点首页里找一个能当头像的图。
// 优先「方形大图」：apple-touch-icon → 大尺寸 icon → og:image / twitter:image → 普通 icon，
// 最后兜底站点根目录的 favicon.ico。

export type AvatarCandidate = { url: string; source: string };

/** 从首页 HTML 里收集候选头像，按适合程度排序（相对地址按页面地址解析） */
export function collectAvatarCandidates(html: string, pageUrl: string): AvatarCandidate[] {
	if (!html) return [];

	const resolve = (raw: string): string => {
		const value = raw.trim();
		if (!value || value.startsWith("data:")) return "";
		try {
			const url = new URL(value, pageUrl);
			return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
		} catch {
			return "";
		}
	};

	const apple: AvatarCandidate[] = [];
	const bigIcons: AvatarCandidate[] = [];
	const smallIcons: AvatarCandidate[] = [];
	const social: AvatarCandidate[] = [];

	for (const tag of html.match(/<link\b[^>]*>/gi) || []) {
		const rel = (tag.match(/rel\s*=\s*["']?([^"'>]+)/i)?.[1] || "").toLowerCase();
		const href =
			tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1] ??
			tag.match(/href\s*=\s*([^\s"'>]+)/i)?.[1];
		const url = href ? resolve(href) : "";
		if (!url) continue;

		if (rel.includes("apple-touch-icon")) {
			apple.push({ url, source: "apple-touch-icon" });
			continue;
		}
		if (/\bicon\b/.test(rel)) {
			const size = Number(tag.match(/sizes\s*=\s*["']?(\d+)/i)?.[1] || 0);
			const candidate = { url, source: size ? `icon ${size}` : "icon" };
			(size >= 96 ? bigIcons : smallIcons).push(candidate);
		}
	}

	for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
		const key = (tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1] || "").toLowerCase();
		if (key !== "og:image" && key !== "twitter:image") continue;
		const content = tag.match(/content\s*=\s*["']([^"']+)["']/i)?.[1];
		const url = content ? resolve(content) : "";
		if (url) social.push({ url, source: key });
	}

	const seen = new Set<string>();
	const result: AvatarCandidate[] = [];
	for (const candidate of [...apple, ...bigIcons, ...social, ...smallIcons]) {
		if (seen.has(candidate.url)) continue;
		seen.add(candidate.url);
		result.push(candidate);
	}
	return result;
}

/** 兜底候选：站点根目录的 favicon.ico */
export function faviconCandidate(pageUrl: string): AvatarCandidate | null {
	try {
		return { url: new URL("/favicon.ico", pageUrl).toString(), source: "favicon.ico" };
	} catch {
		return null;
	}
}

/** 一个响应看起来是不是图片（排除返回 HTML 的软 404） */
function looksLikeImage(contentType?: string): boolean {
	if (!contentType) return true; // 对方没给 Content-Type，先当图片处理
	return (
		contentType.startsWith("image/") ||
		contentType.startsWith("application/octet-stream")
	);
}

/**
 * 并行验证前几个候选图，按优先级返回第一个「确实能打开且是图片」的。
 * 申请表单里用它，避免把一个打不开的图标自动填进去。
 */
export async function pickReachableAvatar(
	candidates: AvatarCandidate[],
	timeoutMs = 5000,
): Promise<AvatarCandidate | null> {
	const top = candidates.slice(0, 3);
	if (top.length === 0) return null;

	const results = await Promise.all(
		top.map((candidate) =>
			fetchUrl(candidate.url, { timeoutMs })
				.then((result) => result.ok && looksLikeImage(result.contentType))
				.catch(() => false),
		),
	);
	const index = results.findIndex(Boolean);
	return index >= 0 ? top[index] : null;
}

export type BacklinkResult = {
	/** 对方友链页里确实有指向本站的链接 */
	verified: boolean;
	/** 未通过时的原因 */
	reason?: string;
	/** 扫到的外链数量（调试用） */
	linkCount?: number;
};

/** 把站点地址拆成可接受的主机名集合（忽略 www. 与大小写） */
function acceptedHosts(siteUrl: string): Set<string> {
	const hosts = new Set<string>();
	try {
		const host = new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, "");
		if (host) {
			hosts.add(host);
			hosts.add(`www.${host}`);
		}
	} catch {
		// 站点地址本身不合法时返回空集合，调用方会当作「检测不出结论」
	}
	return hosts;
}

/**
 * 在对方友链页的 HTML 里找指向本站的链接。
 *
 * 判定标准：链接的主机名与本站一致（忽略 www.、http/https 差异），
 * 且路径是首页（空路径或 `/`）——指向某篇博文不算友链。
 */
export function verifyBacklink(
	html: string,
	pageUrl: string,
	siteUrl: string,
): BacklinkResult {
	if (!html) return { verified: false, reason: "对方友链页没有返回内容" };

	const hosts = acceptedHosts(siteUrl);
	if (hosts.size === 0) return { verified: false, reason: "本站地址配置异常，无法校验" };

	// 覆盖 href="..." / href='...' / href=... 三种写法
	const patterns = [
		/href\s*=\s*"([^"]+)"/gi,
		/href\s*=\s*'([^']+)'/gi,
		/href\s*=\s*([^\s"'>`]+)/gi,
	];

	let linkCount = 0;
	for (const pattern of patterns) {
		let match: RegExpExecArray | null = pattern.exec(html);
		while (match !== null) {
			const raw = (match[1] || "").trim();
			match = pattern.exec(html);

			if (!raw || raw.startsWith("#")) continue;

			let resolved: URL;
			try {
				// 相对链接按对方友链页地址解析
				resolved = new URL(raw, pageUrl);
			} catch {
				continue;
			}
			if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;

			linkCount += 1;

			const host = resolved.hostname.toLowerCase().replace(/^www\./, "");
			const path = resolved.pathname.replace(/\/+$/, "");
			if (hosts.has(host) && path === "") {
				return { verified: true, linkCount };
			}
		}
	}

	return {
		verified: false,
		linkCount,
		reason: `在页面里扫到 ${linkCount} 个链接，但没有找到指向本站首页的友链`,
	};
}
