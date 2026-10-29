// 自建访问统计（不蒜子替代）
// - POST：计一次访问并返回 6 项指标（站点 PV/UV、今日 PV/UV、本页 PV/UV）
// - GET ：只读取当前值，不计数（便于导入后校验）
// 存储用 Upstash Redis 的 REST 接口，Vercel Marketplace 集成后自动注入环境变量：
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（也兼容 KV_REST_API_URL / KV_REST_API_TOKEN）
// 每次 POST 只发一条 EVAL，去重、自增、读取全部在 Redis 端原子完成。
import { createHash } from "node:crypto";
import type { APIRoute } from "astro";

export const prerender = false;

type CountSnapshot = {
	site_pv: number;
	site_uv: number;
	today_pv: number;
	today_uv: number;
	page_pv: number;
	page_uv: number;
};

type RedisEnv = {
	url: string;
	token: string;
};

// KEYS: 1 站点PV 2 站点UV 3 今日PV 4 今日UV 5 本页PV 6 本页UV 7 去重锁
// ARGV: 1 访客哈希 2 去重锁秒数
// 注意：用 EXISTS 判断锁，而不是 SET NX 的返回值——
// Upstash 的 EVAL 里 SET NX 成功返回的是 table 而不是 "OK"，字符串比较永远不成立
const COUNT_SCRIPT = `
if redis.call('EXISTS', KEYS[7]) == 0 then
  redis.call('SET', KEYS[7], '1', 'EX', ARGV[2])
  redis.call('INCR', KEYS[1])
  redis.call('SADD', KEYS[2], ARGV[1])
  redis.call('INCR', KEYS[3])
  redis.call('SADD', KEYS[4], ARGV[1])
  redis.call('INCR', KEYS[5])
  redis.call('SADD', KEYS[6], ARGV[1])
  redis.call('EXPIRE', KEYS[3], 172800)
  redis.call('EXPIRE', KEYS[4], 172800)
end
return {
  tonumber(redis.call('GET', KEYS[1]) or '0'),
  redis.call('SCARD', KEYS[2]),
  tonumber(redis.call('GET', KEYS[3]) or '0'),
  redis.call('SCARD', KEYS[4]),
  tonumber(redis.call('GET', KEYS[5]) or '0'),
  redis.call('SCARD', KEYS[6])
}
`;

function json(status: number, payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "未知错误";
}

function getRedisEnv(): RedisEnv | null {
	const url =
		import.meta.env.UPSTASH_REDIS_REST_URL ||
		import.meta.env.KV_REST_API_URL ||
		import.meta.env.COUNT_REDIS_URL ||
		"";
	const token =
		import.meta.env.UPSTASH_REDIS_REST_TOKEN ||
		import.meta.env.KV_REST_API_TOKEN ||
		import.meta.env.COUNT_REDIS_TOKEN ||
		"";
	if (!url || !token) return null;
	return { url: url.replace(/\/+$/, ""), token };
}

/** 把任意输入规范成统一的页面路径：不带查询串、统一尾斜杠、过滤异常字符 */
function normalizePath(raw: string | null | undefined): string {
	let path = String(raw || "/");
	try {
		path = new URL(path, "https://liyueovo.top").pathname;
	} catch {
		// 保底：不是合法路径就当成根路径
		path = "/";
	}
	path = path.split("?")[0].split("#")[0];
	path = path.replace(/\/{2,}/g, "/");
	if (!path.startsWith("/")) path = `/${path}`;
	if (path.length > 1 && !path.endsWith("/")) path = `${path}/`;
	// 只保留字母、数字、中文与 URL 安全字符，避免奇怪的 Redis key
	path = path.replace(/[^\p{L}\p{N}\-_/.~%]/gu, "");
	if (!path) path = "/";
	return path.slice(0, 200);
}

/** 按北京时间切分「今日」，避免 Vercel 默认 UTC 导致跨天统计错位 */
function shanghaiDate(): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Shanghai",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
}

function visitorHash(request: Request, path: string): string {
	const ip =
		request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
		request.headers.get("x-real-ip") ||
		"0.0.0.0";
	const ua = request.headers.get("user-agent") || "unknown";
	const salt = import.meta.env.COUNT_SALT || "liyueovo-top-count";
	// 只落哈希，原始 IP/UA 不存储
	const digest = createHash("sha256").update(`${salt}:${ip}:${ua}`).digest("hex");
	return `${digest.slice(0, 32)}:${path}`.slice(0, 64);
}

async function redisCall(env: RedisEnv, command: unknown[]): Promise<unknown> {
	const response = await fetch(env.url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(command),
	});
	if (!response.ok) {
		throw new Error(`Redis 请求失败（${response.status}）`);
	}
	const payload = (await response.json()) as { result?: unknown; error?: string };
	if (payload.error) throw new Error(payload.error);
	return payload.result;
}

async function redisPipeline(
	env: RedisEnv,
	commands: unknown[][],
): Promise<unknown[]> {
	const response = await fetch(`${env.url}/pipeline`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(commands),
	});
	if (!response.ok) {
		throw new Error(`Redis 请求失败（${response.status}）`);
	}
	const payload = (await response.json()) as Array<{
		result?: unknown;
		error?: string;
	}>;
	return payload.map((item) => {
		if (item.error) throw new Error(item.error);
		return item.result ?? null;
	});
}

function toNumber(value: unknown): number {
	const num = Number(value);
	return Number.isFinite(num) ? num : 0;
}

function toSnapshot(values: unknown[]): CountSnapshot {
	return {
		site_pv: toNumber(values[0]),
		site_uv: toNumber(values[1]),
		today_pv: toNumber(values[2]),
		today_uv: toNumber(values[3]),
		page_pv: toNumber(values[4]),
		page_uv: toNumber(values[5]),
	};
}

// 只读：不做任何自增
export const GET: APIRoute = async ({ url }) => {
	const env = getRedisEnv();
	if (!env) {
		return json(503, {
			ok: false,
			message:
				"未配置计数存储：请在 Vercel 集成 Upstash Redis（需要 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）",
		});
	}

	const path = normalizePath(url.searchParams.get("path"));
	const date = shanghaiDate();

	try {
		const values = await redisPipeline(env, [
			["GET", "site:pv"],
			["SCARD", "site:uv"],
			["GET", `day:${date}:pv`],
			["SCARD", `day:${date}:uv`],
			["GET", `page:${path}:pv`],
			["SCARD", `page:${path}:uv`],
		]);
		return json(200, { ok: true, path, ...toSnapshot(values) });
	} catch (error) {
		return json(502, { ok: false, message: errorMessage(error) });
	}
};

export const POST: APIRoute = async ({ request }) => {
	const env = getRedisEnv();
	if (!env) {
		return json(503, {
			ok: false,
			message:
				"未配置计数存储：请在 Vercel 集成 Upstash Redis（需要 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN）",
		});
	}

	let path = "/";
	try {
		const body = (await request.json()) as { path?: string };
		path = normalizePath(body?.path);
	} catch {
		// 没有 body 就按首页统计
	}

	const date = shanghaiDate();
	const visitor = visitorHash(request, path);

	try {
		const result = await redisCall(env, [
			"EVAL",
			COUNT_SCRIPT,
			7,
			"site:pv",
			"site:uv",
			`day:${date}:pv`,
			`day:${date}:uv`,
			`page:${path}:pv`,
			`page:${path}:uv`,
			`rl:${visitor}`,
			visitor,
			10,
		]);
		const values = Array.isArray(result) ? result : [];
		return json(200, { ok: true, path, ...toSnapshot(values) });
	} catch (error) {
		return json(502, { ok: false, message: errorMessage(error) });
	}
};
