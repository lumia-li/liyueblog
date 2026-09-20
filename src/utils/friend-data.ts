/**
 * 友链数据仓库（每条记录一个 JSON 文件，参考 afoim/af_friends-data 的做法）。
 *
 * 目录约定：
 *   data/applications/<slug>.json   待审核
 *   data/friends/<slug>.json        已通过（友链页会读它来渲染列表）
 *   data/rejected/<slug>.json       未通过
 *
 * slug = 站点域名（如 example.com），同一站点重复提交会覆盖同一个文件，
 * 所以不会因为反复提交而堆出一堆垃圾文件。
 *
 * 需要的环境变量：
 *   FRIEND_DATA_REPO   数据仓库，格式 owner/repo，例如 lumia-li/friends-data
 *   FRIEND_DATA_TOKEN  可选，读写该仓库用的 token；不填则回退到 GITHUB_TOKEN
 *                      （token 需要对该仓库有 Contents: Read and write）
 */

export type FriendDataDir = "applications" | "friends" | "rejected";

export type FriendDataEntry = {
	name: string;
	description?: string;
	avatar?: string;
	url: string;
	/** 申请人自己的友链页地址，用来校验双向链接 */
	backlink?: string;
	/** 申请人的联系方式（邮箱 / QQ 等），只在申请文件里，不会渲染到页面上 */
	contact?: string;
	/** true = 该站点已通过审核，这次提交的是「信息更新」而不是首次申请 */
	update?: boolean;
	/** true = 头像不是申请人填的，而是从他站点首页自动抓的（供站长核对） */
	avatarAuto?: boolean;
	/** 提交时的自动检测结果，供站长审核参考（不作为通过/拒绝依据） */
	checks?: {
		siteReachable?: boolean;
		siteStatus?: number;
		/** 站点没通过时的原因（403 防爬、超时这类"说不准"的也会记在这里） */
		siteNote?: string;
		avatarReachable?: boolean;
		avatarStatus?: number;
		/** 头像没通过时的原因 */
		avatarNote?: string;
		backlinkVerified?: boolean;
	};
	/** 仅在 applications/ 里有意义：pending（首次申请）/ update（信息更新） */
	status?: string;
	submittedAt?: string;
};

const API = "https://api.github.com";
const MAX_FILES = 200;

export function getFriendDataRepo(): string {
	return String(import.meta.env.FRIEND_DATA_REPO || "").trim().replace(/^\/+|\/+$/g, "");
}

function getToken(): string {
	return String(
		import.meta.env.FRIEND_DATA_TOKEN || import.meta.env.GITHUB_TOKEN || "",
	).trim();
}

export function isFriendDataConfigured(): boolean {
	return Boolean(getFriendDataRepo() && getToken());
}

/** 从站点地址取出域名，作为文件名（slug） */
export function slugFromUrl(url: string): string {
	try {
		const host = new URL(url).hostname.toLowerCase();
		return host
			.replace(/^www\./, "")
			.replace(/[^a-z0-9.-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 80);
	} catch {
		return "";
	}
}

function headers(token: string): Record<string, string> {
	return {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${token}`,
		"X-GitHub-Api-Version": "2022-11-28",
		"Content-Type": "application/json",
	};
}

function filePath(dir: FriendDataDir, slug: string): string {
	return `data/${dir}/${slug}.json`;
}

type ReadResult = { exists: boolean; entry?: FriendDataEntry; sha?: string };

/** 读取单个数据文件 @param dir 目录名（applications/friends/rejected） */
export async function readFriendFile(
	dir: FriendDataDir,
	slug: string,
): Promise<ReadResult> {
	if (!isFriendDataConfigured() || !slug) return { exists: false };
	const repo = getFriendDataRepo();
	const token = getToken();

	const response = await fetch(`${API}/repos/${repo}/contents/${filePath(dir, slug)}`, {
		headers: headers(token),
		signal: AbortSignal.timeout(10_000),
	});

	// 404 = 文件不存在（也包含仓库不存在的情况）
	if (response.status === 404 || response.status === 410) return { exists: false };
	if (!response.ok) {
		throw new Error(`读取 ${dir}/${slug}.json 失败：GitHub ${response.status}`);
	}

	const payload = (await response.json()) as { content?: string; sha?: string };
	if (!payload.content) return { exists: false };

	const text = Buffer.from(payload.content, "base64").toString("utf8");
	try {
		return { exists: true, entry: JSON.parse(text) as FriendDataEntry, sha: payload.sha };
	} catch {
		// 文件内容坏掉时当作不存在，避免整页报错
		return { exists: false, sha: payload.sha };
	}
}

/** 写入（或覆盖）单个数据文件 */
export async function writeFriendFile(
	dir: FriendDataDir,
	slug: string,
	entry: FriendDataEntry,
	message: string,
): Promise<{ ok: boolean; error?: string }> {
	if (!isFriendDataConfigured()) return { ok: false, error: "未配置数据仓库" };
	const repo = getFriendDataRepo();
	const token = getToken();
	const path = filePath(dir, slug);

	// 已存在时需要带上 sha 才是"更新"
	let sha: string | undefined;
	try {
		const existing = await readFriendFile(dir, slug);
		sha = existing.sha;
	} catch {
		// 读失败就不带 sha，让 GitHub 决定（冲突会返回 409/422）
	}

	const response = await fetch(`${API}/repos/${repo}/contents/${path}`, {
		method: "PUT",
		headers: headers(token),
		body: JSON.stringify({
			message,
			content: Buffer.from(`${JSON.stringify(entry, null, 2)}\n`, "utf8").toString("base64"),
			...(sha ? { sha } : {}),
		}),
		signal: AbortSignal.timeout(15_000),
	});

	if (response.ok) return { ok: true };

	const detail = (await response.json().catch(() => null)) as { message?: string } | null;
	if (response.status === 401 || response.status === 403) {
		return {
			ok: false,
			error: "数据仓库没有写权限：请确认 token 已授权该仓库并且有 Contents: Read and write",
		};
	}
	if (response.status === 404) {
		return {
			ok: false,
			error: "找不到数据仓库：请检查 FRIEND_DATA_REPO（owner/repo）是否正确、仓库是否已创建",
		};
	}
	return { ok: false, error: `GitHub ${response.status} ${detail?.message || ""}`.trim() };
}

/**
 * 删除某个数据文件（重新申请时清掉旧的 rejected 记录）。
 * 文件本来就不存在时也算成功。
 */
export async function deleteFriendFile(
	dir: FriendDataDir,
	slug: string,
): Promise<{ ok: boolean; error?: string }> {
	if (!isFriendDataConfigured() || !slug) return { ok: false, error: "未配置数据仓库" };
	const repo = getFriendDataRepo();
	const token = getToken();

	let sha: string | undefined;
	try {
		sha = (await readFriendFile(dir, slug)).sha;
	} catch {
		sha = undefined;
	}
	if (!sha) return { ok: true };

	const response = await fetch(`${API}/repos/${repo}/contents/${filePath(dir, slug)}`, {
		method: "DELETE",
		headers: headers(token),
		body: JSON.stringify({ message: `chore(friends): 清理 ${dir}/${slug}.json`, sha }),
		signal: AbortSignal.timeout(15_000),
	});

	if (response.ok || response.status === 404) return { ok: true };
	return { ok: false, error: `GitHub ${response.status}` };
}

/** 列出某个目录下的所有条目（构建时用来渲染友链列表） */
const listCache = new Map<string, { at: number; entries: FriendDataEntry[] }>();
const LIST_CACHE_TTL_MS = 5 * 60_000;
// 并发上限：避免一次打太多请求触发 GitHub 的二级限流
const CONCURRENCY = 8;

export async function listFriendDir(dir: FriendDataDir): Promise<FriendDataEntry[]> {
	if (!isFriendDataConfigured()) return [];

	const cacheKey = `${getFriendDataRepo()}/${dir}`;
	const cached = listCache.get(cacheKey);
	if (cached && Date.now() - cached.at < LIST_CACHE_TTL_MS) {
		return cached.entries;
	}

	const repo = getFriendDataRepo();
	const token = getToken();

	const response = await fetch(`${API}/repos/${repo}/contents/data/${dir}`, {
		headers: headers(token),
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) return [];

	const files = (await response.json()) as { name?: string; type?: string }[];
	if (!Array.isArray(files)) return [];

	const names = files
		.filter((file) => file.type === "file" && String(file.name || "").endsWith(".json"))
		.map((file) => String(file.name).replace(/\.json$/, ""))
		.slice(0, MAX_FILES);

	const entries: FriendDataEntry[] = [];
	for (let i = 0; i < names.length; i += CONCURRENCY) {
		const chunk = names.slice(i, i + CONCURRENCY);
		const results = await Promise.all(
			chunk.map(async (slug) => {
				try {
					const result = await readFriendFile(dir, slug);
					return result.entry && result.entry.url ? result.entry : null;
				} catch {
					return null;
				}
			}),
		);
		for (const entry of results) {
			if (entry) entries.push(entry);
		}
	}

	listCache.set(cacheKey, { at: Date.now(), entries });
	return entries;
}
