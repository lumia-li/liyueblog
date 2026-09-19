import { createStatusToken } from "@utils/friend-apply-token";
import {
	deleteFriendFile,
	isFriendDataConfigured,
	readFriendFile,
	slugFromUrl,
	writeFriendFile,
} from "@utils/friend-data";
import { fetchUrl, verifyBacklink } from "@utils/link-check";
import type { APIRoute } from "astro";
import { friendLinkConfig } from "../../data/friend-links";

/**
 * 友链申请接口（POST /api/friend-apply）
 *
 * 流程：友链页弹窗表单 → 这里做校验和自动检测 → 往「友链数据仓库」写一个 JSON 文件：
 *      data/applications/<站点域名>.json
 *
 * 审核：把该文件移到 data/friends/ 就是通过（移到 data/rejected/ 就是未通过），
 *      申请人凭提交时拿到的查询凭证在友链页看到结果。
 *      如果该站点**已经通过过**，这次提交只写 applications/（标记 update），
 *      friends/ 里的旧记录保持不动，状态条会显示「信息更新审核中」。
 *
 * 提交时会顺手做三项检测（结果只写进文件供站长参考，不拦提交）：
 *      站点可达 / 头像可达 / 对方友链页有没有回链本站
 *
 * 需要的环境变量（Vercel → Project → Settings → Environment Variables）：
 *   FRIEND_DATA_REPO   数据仓库，格式 owner/repo，例如 lumia-li/friends-data
 *   FRIEND_DATA_TOKEN  可选，读写该仓库的 token；不填则用 GITHUB_TOKEN
 *   FRIEND_APPLY_SECRET 查询凭证的签名密钥（见 utils/friend-apply-token.ts）
 *
 * 不建数据库：仓库里的 JSON 文件本身就是你的「收件箱」兼友链数据源。
 */
export const prerender = false;

const RATE_LIMIT_WINDOW_MS = 10 * 60_000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const MAX_BODY_BYTES = 8 * 1024;

const LIMITS = {
	name: 40,
	url: 200,
	avatar: 300,
	backlink: 200,
	contact: 60,
	description: 80,
} as const;

/** 检测超时：三项并行跑，整体耗时约等于最慢的那个（Vercel 函数默认 10 秒超时） */
const TIMEOUT = {
	site: 6000,
	avatar: 5000,
	backlink: 6000,
} as const;

/** 本站地址：拿 friend-links 里对外公布的那份，保证和别人加友链时填的一致 */
function getSiteUrl(): string {
	return String(friendLinkConfig.self.url || import.meta.env.SITE || "").trim();
}

type ApplicationDraft = {
	name: string;
	url: string;
	avatar: string;
	backlink: string;
	contact: string;
	description: string;
};

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
	return (
		request.headers.get("x-real-ip") ||
		request.headers.get("cf-connecting-ip") ||
		"unknown"
	);
}

function checkRateLimit(key: string): boolean {
	const now = Date.now();
	const bucket = rateBuckets.get(key);

	if (!bucket || now > bucket.resetAt) {
		rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		// 防止 Map 无限增长（Serverless 实例会被复用，需要自己清理）
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

/**
 * 单行化 + 去掉反引号：避免用户在字段里塞换行或 ``` 破坏数据文件的可读性
 */
function readText(value: unknown, maxLength: number): string {
	if (typeof value !== "string") return "";
	return value
		.replace(/[\r\n\t]+/g, " ")
		.replace(/`/g, "'")
		.trim()
		.slice(0, maxLength);
}

function isHttpUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return parsed.protocol === "http:" || parsed.protocol === "https:";
	} catch {
		return false;
	}
}

/** 取主机名（忽略 www. 与大小写），用于判断「是不是同一个站」 */
function hostOf(value: string): string {
	try {
		return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}

type ParseResult =
	| { ok: true; draft: ApplicationDraft; isSpam: boolean }
	| { ok: false; message: string };

function parseApplication(raw: unknown): ParseResult {
	if (!raw || typeof raw !== "object") {
		return { ok: false, message: "请求格式不正确" };
	}

	const body = raw as Record<string, unknown>;
	const empty: ApplicationDraft = {
		name: "",
		url: "",
		avatar: "",
		backlink: "",
		contact: "",
		description: "",
	};

	// 蜜罐字段：正常访客看不到、不会填；填了就当机器人静默丢弃
	if (readText(body.website, 100)) {
		return { ok: true, draft: empty, isSpam: true };
	}

	const draft: ApplicationDraft = {
		name: readText(body.name, LIMITS.name),
		url: readText(body.url, LIMITS.url),
		avatar: readText(body.avatar, LIMITS.avatar),
		backlink: readText(body.backlink, LIMITS.backlink),
		contact: readText(body.contact, LIMITS.contact),
		description: readText(body.description, LIMITS.description),
	};

	if (!draft.name) return { ok: false, message: "请填写站点名称" };
	if (!draft.url || !isHttpUrl(draft.url)) {
		return { ok: false, message: "站点地址要填完整地址，以 http:// 或 https:// 开头" };
	}
	if (draft.avatar && !isHttpUrl(draft.avatar)) {
		return { ok: false, message: "头像地址要填完整地址，以 http:// 或 https:// 开头" };
	}
	if (draft.backlink && !isHttpUrl(draft.backlink)) {
		return { ok: false, message: "友链页地址要填完整地址，以 http:// 或 https:// 开头" };
	}
	if (!draft.description) return { ok: false, message: "请填写一句话简介" };

	// 别把自己站提交给自己
	const siteHost = hostOf(getSiteUrl());
	if (siteHost && hostOf(draft.url) === siteHost) {
		return { ok: false, message: "这个站点地址就是本站呀，不用申请友链～" };
	}

	return { ok: true, draft, isSpam: false };
}

export const POST: APIRoute = async ({ request }) => {
	if (!checkRateLimit(getClientIp(request))) {
		return json(429, {
			ok: false,
			message: "提交太频繁了，请过一会儿再试～",
		});
	}

	const contentLength = Number.parseInt(
		request.headers.get("content-length") || "0",
		10,
	);
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		return json(413, { ok: false, message: "提交内容过大" });
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return json(400, { ok: false, message: "请求内容不是合法的 JSON" });
	}

	const parsed = parseApplication(raw);
	if (!parsed.ok) {
		return json(400, { ok: false, message: parsed.message });
	}
	if (parsed.isSpam) {
		// 对机器人返回成功，避免它反复试探
		return json(200, { ok: true });
	}

	const slug = slugFromUrl(parsed.draft.url);
	if (!slug) {
		return json(400, { ok: false, message: "站点地址解析失败，请检查后重试" });
	}

	if (!isFriendDataConfigured()) {
		return json(500, {
			ok: false,
			message:
				"服务端还没配置好：请在环境变量里补上 FRIEND_DATA_REPO（数据仓库，格式 owner/repo）",
		});
	}

	const { draft } = parsed;
	const siteUrl = getSiteUrl();

	// ── 是不是「已通过后的信息更新」 ────────────────────────────
	let approvedBefore = false;
	let rejectedBefore = false;
	try {
		const [friendFile, rejectedFile] = await Promise.all([
			readFriendFile("friends", slug),
			readFriendFile("rejected", slug),
		]);
		approvedBefore = friendFile.exists;
		rejectedBefore = rejectedFile.exists;
	} catch (error) {
		// 读失败就按「首次申请」处理，不影响提交本身
		console.error("[friend-apply] 读取既有记录失败", error);
	}

	// ── 三项检测并行跑（结果只作参考，不拦提交）──────────────────
	const [siteCheck, avatarCheck, backlinkCheck] = await Promise.all([
		fetchUrl(draft.url, { timeoutMs: TIMEOUT.site }),
		draft.avatar ? fetchUrl(draft.avatar, { timeoutMs: TIMEOUT.avatar }) : null,
		draft.backlink
			? fetchUrl(draft.backlink, { timeoutMs: TIMEOUT.backlink, wantBody: true })
			: null,
	]);

	const backlinkResult = backlinkCheck
		? backlinkCheck.ok
			? verifyBacklink(
					backlinkCheck.body || "",
					backlinkCheck.finalUrl || draft.backlink,
					siteUrl,
				)
			: { verified: false, reason: backlinkCheck.reason || backlinkCheck.error }
		: null;

	// 回链地址和站点地址不在同一个域名 → 提示一下（很多人会把「友链页」填成别的站）
	const backlinkHostMismatch =
		Boolean(draft.backlink) &&
		Boolean(hostOf(draft.backlink)) &&
		hostOf(draft.backlink) !== hostOf(draft.url);

	const warnings: string[] = [];
	if (!siteCheck.ok) {
		warnings.push(
			`站点暂时没检测通过：${siteCheck.reason || siteCheck.error || "未知原因"}。如果是防爬导致（403 很常见）可以忽略，但建议自己打开浏览器确认一下。`,
		);
	}
	if (avatarCheck && !avatarCheck.ok) {
		warnings.push(
			`头像地址没检测通过：${avatarCheck.reason || avatarCheck.error || "未知原因"}。建议换一个能直接打开的图片直链，不然友链卡片上会显示默认小人图标。`,
		);
	}
	if (backlinkResult && draft.backlink) {
		if (backlinkResult.verified) {
			warnings.push("已在你填的友链页里找到指向本站的链接，双向友链确认 ✓");
		} else {
			warnings.push(
				`没在你填的友链页里找到指向本站首页的链接（${backlinkResult.reason || "未找到"}）。把本站加进你的友链再申请，通过会更快。`,
			);
		}
	}
	if (backlinkHostMismatch) {
		warnings.push(
			"你填的友链页域名和站点域名不一致，确认一下是不是填成了别人的站？",
		);
	}

	const checks = {
		siteReachable: siteCheck.ok,
		...(siteCheck.status ? { siteStatus: siteCheck.status } : {}),
		...(avatarCheck
			? {
					avatarReachable: avatarCheck.ok,
					...(avatarCheck.status ? { avatarStatus: avatarCheck.status } : {}),
				}
			: {}),
		...(backlinkResult ? { backlinkVerified: backlinkResult.verified } : {}),
	};

	try {
		const result = await writeFriendFile(
			"applications",
			slug,
			{
				name: draft.name,
				description: draft.description,
				avatar: draft.avatar,
				url: draft.url,
				...(draft.backlink ? { backlink: draft.backlink } : {}),
				...(draft.contact ? { contact: draft.contact } : {}),
				...(approvedBefore ? { update: true } : {}),
				status: approvedBefore ? "update" : "pending",
				submittedAt: new Date().toISOString(),
				checks,
			},
			approvedBefore
				? `chore(friends): 更新 ${draft.name} (${slug})`
				: `chore(friends): 申请 ${draft.name} (${slug})`,
		);

		if (!result.ok) {
			console.error("[friend-apply] 写入数据仓库失败", result.error);
			return json(502, { ok: false, message: `提交失败：${result.error}` });
		}
	} catch (error) {
		console.error("[friend-apply] 请求 GitHub 失败", error);
		return json(502, {
			ok: false,
			message: "提交失败，请稍后再试，或者直接通过页面上的联系方式找我",
		});
	}

	// 之前被拒过的站重新申请：清掉旧的 rejected 记录，状态回到「审核中」
	if (rejectedBefore && !approvedBefore) {
		try {
			await deleteFriendFile("rejected", slug);
		} catch (error) {
			console.error("[friend-apply] 清理 rejected 记录失败", error);
		}
	}

	// 查询凭证：申请人凭它查看自己的申请状态（详见 utils/friend-apply-token.ts）
	return json(200, {
		ok: true,
		statusToken: createStatusToken(slug),
		state: approvedBefore ? "update" : "pending",
		warnings,
		checks,
	});
};
