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
	/** 技术错误原文（连接超时、域名解析失败等），便于排查 */
	error?: string;
};

function requestHeaders(): Record<string, string> {
	return {
		"User-Agent": BROWSER_UA,
		Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
		"Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
	};
}

/** 常见 HTTP 状态码 → 申请人能看懂的解释 */
function describeStatus(status: number): string {
	if (status === 401) return "HTTP 401（站点需要登录才能访问）";
	if (status === 403) return "HTTP 403（对方站点可能在挡爬虫，你可以在浏览器里确认一下能否打开）";
	if (status === 404) return "HTTP 404（页面不存在，检查一下地址有没有写错）";
	if (status === 429) return "HTTP 429（对方站点限流，稍后再试）";
	if (status >= 500) return `HTTP ${status}（对方服务器报错，可能是临时的）`;
	if (status >= 400) return `HTTP ${status}`;
	return `HTTP ${status}`;
}

/** 网络层错误 → 人话 */
function describeError(message: string): string {
	if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return "域名解析失败（地址可能拼错了）";
	if (/ECONNREFUSED/i.test(message)) return "连接被拒绝（对方没在这个端口提供服务）";
	if (/certificate|SSL|TLS|self-signed/i.test(message)) return "HTTPS 证书有问题";
	if (/timeout|timed out|aborted|TimeoutError/i.test(message)) return "请求超时（站点太慢或拒绝了请求）";
	return "请求失败";
}

/** 按上限读取响应体文本（读满即断，避免把大页面整个拉进来） */
async function readTextLimited(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let received = 0;
	let text = "";
	try {
		for (;;) {
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
		await reader.cancel().catch(() => {});
	}
	return text;
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

	try {
		const response = await fetch(url, {
			headers: requestHeaders(),
			redirect: "follow",
			signal: AbortSignal.timeout(timeoutMs),
		});

		const ok = response.status < 400;
		const result: UrlCheck & { body?: string } = {
			ok,
			status: response.status,
			finalUrl: response.url || url,
			...(ok ? {} : { reason: describeStatus(response.status) }),
		};

		if (ok && wantBody) {
			result.body = await readTextLimited(response, MAX_HTML_BYTES);
		} else {
			// 不需要正文就别把内容拉回来
			await response.body?.cancel().catch(() => {});
		}

		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message, reason: describeError(message) };
	}
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
