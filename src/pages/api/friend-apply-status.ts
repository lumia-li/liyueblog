import { verifyStatusToken } from "@utils/friend-apply-token";
import { isFriendDataConfigured, readFriendFile } from "@utils/friend-data";
import type { APIRoute } from "astro";

/**
 * 友链申请状态查询（GET /api/friend-apply-status?token=域名.签名）
 *
 * 判定规则（看数据仓库里的文件位置）：
 *   friends/ + applications/ 都有 → update    已通过，本次是信息更新，待审核
 *   data/friends/<域名>.json      → approved  已通过
 *   data/applications/<域名>.json → pending   审核中（重新申请也走这里）
 *   data/rejected/<域名>.json     → rejected  未通过
 *   三处都没有                     → unknown   查不到记录
 *
 * 顺序很关键：applications 优先于 rejected，这样「被拒后重新申请」会立刻
 * 回到审核中，不会一直卡在「未通过」；friends 优先于 applications，
 * 只有两者同时存在才代表这是对已通过友链的信息更新。
 *
 * 只返回状态，不返回任何申请内容，所以凭证泄露也只泄露一个进度。
 *
 * 需要的环境变量：FRIEND_DATA_REPO（+ FRIEND_DATA_TOKEN 或 GITHUB_TOKEN）
 */
export const prerender = false;

const CACHE_TTL_MS = 15_000;

// 同一个凭证 15 秒内只查一次，避免轮询把接口打爆；
// 前端点「刷新」时会带 refresh=1 强制绕过缓存。
const cache = new Map<string, { at: number; payload: Record<string, unknown> }>();

// 这个接口是公开的（没有登录态），每次查询都要读数据仓库，
// 所以必须限流。正常使用：打开页面 1 次 + 每分钟轮询 1 次。
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
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

export const GET: APIRoute = async ({ request }) => {
	if (!checkRateLimit(getClientIp(request))) {
		return json(429, { ok: false, message: "查询太频繁了，请过一会儿再试" });
	}

	const params = new URL(request.url).searchParams;
	const token = params.get("token") || "";
	const slug = verifyStatusToken(token);
	if (!slug) {
		return json(400, { ok: false, message: "查询凭证无效" });
	}

	if (!isFriendDataConfigured()) {
		return json(500, {
			ok: false,
			message: "服务端还没配置好：请在环境变量里补上 FRIEND_DATA_REPO",
		});
	}

	const respond = (payload: Record<string, unknown>) => {
		cache.set(token, { at: Date.now(), payload });
		return json(200, payload);
	};

	const cached = cache.get(token);
	if (
		params.get("refresh") !== "1" &&
		cached &&
		Date.now() - cached.at < CACHE_TTL_MS
	) {
		return json(200, cached.payload);
	}

	try {
		// 三个目录并行读，省一轮往返（顺序判断见文件头注释）
		const [application, friend, rejected] = await Promise.all([
			readFriendFile("applications", slug),
			readFriendFile("friends", slug),
			readFriendFile("rejected", slug),
		]);

		if (friend.exists) {
			// 已通过之后又提交了一次 → 信息更新待审核
			return respond({
				ok: true,
				state: application.exists ? "update" : "approved",
			});
		}
		if (application.exists) {
			return respond({ ok: true, state: "pending" });
		}
		if (rejected.exists) {
			return respond({ ok: true, state: "rejected" });
		}
		return respond({ ok: true, state: "unknown" });
	} catch (error) {
		console.error("[friend-apply-status] 查询失败", error);
		return json(502, { ok: false, message: "查询失败，请稍后再试" });
	}
};
