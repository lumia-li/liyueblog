import {
	collectAvatarCandidates,
	faviconCandidate,
	fetchUrl,
	pickReachableAvatar,
	verifyBacklink,
	type UrlCheck,
} from "@utils/link-check";
import type { APIRoute } from "astro";
import { friendLinkConfig } from "../../data/friend-links";

/**
 * 友链申请表单的「链接体检」接口（POST /api/friend-link-check）
 *
 * 用途：申请人在表单里填完链接、失焦或点提交时先查一次，
 *      把结论显示在对应输入框下面。**有 error 时前端不提交申请**，
 *      所以不会往数据仓库写文件（friend-apply.ts 里还有同样的兜底校验）。
 *
 * 请求：{ url?, avatar?, backlink? }
 * 响应：{ ok: true, fields: {...}, avatarSuggestion?: { url, source } }
 *      —— 请求里没带头像时，会从他站点首页抓一个能用的头像候选回来，
 *         前端自动填进「头像」输入框（抓不到、或抓来的图打不开就不填）
 *
 * 三个 level 的含义：
 *   pass  通过（可带一句正向说明，比如双向链接已确认）
 *   note  说不准（403 防爬、超时、对方 5xx）或"友链页没找到回链"——提示但不拦提交
 *   error 确定有问题（域名解析失败、404、连接被拒、内网地址）——拦提交
 *
 * 这个接口会以服务器身份访问用户填的地址，所以必须限流 + 挡内网（见 utils/link-check.ts）
 */
export const prerender = false;

export type FieldCheck = {
	level: "pass" | "note" | "error";
	message?: string;
};

const RATE_LIMIT_WINDOW_MS = 60_000;
// 失焦就会查一次，所以限流比提交接口宽松
const RATE_LIMIT_MAX_REQUESTS = 30;
const LIMITS = { url: 200, avatar: 300, backlink: 200 } as const;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function json(status: number, payload: Record<string, unknown>): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function getClientIp(request: Request): string {
	const forwarded = request.headers.get("x-forwarded-for") || "";
	const first = forwarded.split(",")[0]?.trim();
	if (first) return first;
	return request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip") || "unknown";
}

function checkRateLimit(key: string): boolean {
	const now = Date.now();
	const bucket = rateBuckets.get(key);
	if (!bucket || now > bucket.resetAt) {
		rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		if (rateBuckets.size > 2000) {
			for (const [bucketKey, value] of rateBuckets) {
				if (now > value.resetAt) rateBuckets.delete(bucketKey);
			}
		}
		return true;
	}
	bucket.count += 1;
	return bucket.count <= RATE_LIMIT_MAX_REQUESTS;
}

function readText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, maxLength);
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

function hostOf(value: string): string {
	try {
		return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}

/** 本站地址：用对外公布的那份，和「我的名片」保持一致 */
function getSiteUrl(): string {
	return String(friendLinkConfig.self.url || import.meta.env.SITE || "").trim();
}

/** 把检测失败翻译成输入框下方的提示（403 / 超时这类说不准的提示但不拦） */
function failureToCheck(result: UrlCheck, label: string): FieldCheck {
	const reason = result.reason || result.error || "未知原因";
	if (result.ambiguous) {
		return {
			level: "note",
			message: `${label}未检测通过：${reason}。可能是防爬或者临时故障，不影响提交。`,
		};
	}
	return { level: "error", message: `${label}未检测通过：${reason}` };
}

export const POST: APIRoute = async ({ request }) => {
	if (!checkRateLimit(getClientIp(request))) {
		return json(429, { ok: false, message: "检测太频繁了，请稍后再试" });
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json(400, { ok: false, message: "请求内容不是合法的 JSON" });
	}
	if (!raw || typeof raw !== "object") {
		return json(400, { ok: false, message: "请求格式不正确" });
	}

	const body = raw as Record<string, unknown>;
	const url = readText(body.url, LIMITS.url);
	const avatar = readText(body.avatar, LIMITS.avatar);
	const backlink = readText(body.backlink, LIMITS.backlink);

	const site = getSiteUrl();
	const siteHost = hostOf(site);
	const fields: Record<string, FieldCheck> = {};
	const tasks: Promise<void>[] = [];
	let avatarSuggestion: { url: string; source: string } | null = null;

	if (url) {
		if (!isHttpUrl(url)) {
			fields.url = { level: "error", message: "站点地址要以 http:// 或 https:// 开头" };
		} else if (siteHost && hostOf(url) === siteHost) {
			fields.url = { level: "error", message: "这个地址就是本站呀，不用申请友链～" };
		} else {
			tasks.push(
				(async () => {
					// 顺便要正文：申请人不填头像时，从首页里给他抓一个
					const result = await fetchUrl(url, { timeoutMs: 6000, wantBody: !avatar });
					if (!result.ok) {
						fields.url = failureToCheck(result, "站点");
						return;
					}
					// 正常时不给任何提示词，只有出问题才显示
					fields.url = { level: "pass" };

					if (avatar) return;
					const pageUrl = result.finalUrl || url;
					const candidates = collectAvatarCandidates(result.body || "", pageUrl);
					const fallback = faviconCandidate(pageUrl);
					if (fallback) candidates.push(fallback);
					const picked = await pickReachableAvatar(candidates);
					if (picked) avatarSuggestion = { url: picked.url, source: picked.source };
				})(),
			);
		}
	}

	if (avatar) {
		if (!isHttpUrl(avatar)) {
			fields.avatar = { level: "error", message: "头像地址要以 http:// 或 https:// 开头" };
		} else {
			tasks.push(
				(async () => {
					const result = await fetchUrl(avatar, { timeoutMs: 5000 });
					fields.avatar = result.ok ? { level: "pass" } : failureToCheck(result, "头像");
				})(),
			);
		}
	}

	if (backlink) {
		if (!isHttpUrl(backlink)) {
			fields.backlink = { level: "error", message: "友链页地址要以 http:// 或 https:// 开头" };
		} else {
			tasks.push(
				(async () => {
					const result = await fetchUrl(backlink, { timeoutMs: 6000, wantBody: true });
					if (!result.ok) {
						fields.backlink = failureToCheck(result, "友链页");
						return;
					}
					const verified = verifyBacklink(
						result.body || "",
						result.finalUrl || backlink,
						site,
					);
					fields.backlink = verified.verified
						? { level: "pass" }
						: {
								level: "note",
								message: `${verified.reason || "没找到指向本站首页的链接"}。把本站加进你的友链再申请，通过会更快（也可以先提交，审核时我看一眼）。`,
							};
				})(),
			);
		}
	}

	await Promise.all(tasks);
	return json(200, {
		ok: true,
		fields,
		...(avatarSuggestion ? { avatarSuggestion } : {}),
	});
};
