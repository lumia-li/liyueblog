import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { matchDevCredential } from "@utils/dev-auth-server";
import type { APIRoute } from "astro";

export const prerender = false;

type TrashAction = "list" | "move" | "restore" | "delete";

type TrashRequest = {
	action?: TrashAction;
	postId?: string;
	postIds?: string[] | string;
	devCode?: string;
	devCodeHash?: string;
};

type GitHubFile = {
	sha: string;
	content: string;
};

type TrashedPost = {
	id: string;
	slug: string;
	title: string;
	published: string;
	trashedAt: string;
};

const POSTS_ROOT = "src/content/posts/";
const TRASH_LIST_READ_CONCURRENCY = 8;
const TRASH_LIST_CACHE_TTL_MS = 30_000;

type TrashedPostsCacheEntry = {
	expiresAt: number;
	value?: TrashedPost[];
	inflight?: Promise<TrashedPost[]>;
};

const trashedPostsCache = new Map<string, TrashedPostsCacheEntry>();

function getTrashedPostsCacheKey(params: {
	githubBase: string;
	branch: string;
}): string {
	return `${params.githubBase}::${params.branch}`;
}

function cloneTrashedPosts(posts: TrashedPost[]): TrashedPost[] {
	return posts.map((post) => ({ ...post }));
}

function getCachedTrashedPosts(key: string): TrashedPost[] | null {
	const entry = trashedPostsCache.get(key);
	if (!entry?.value) return null;
	if (entry.expiresAt <= Date.now()) {
		trashedPostsCache.delete(key);
		return null;
	}
	return cloneTrashedPosts(entry.value);
}

function setCachedTrashedPosts(key: string, posts: TrashedPost[]): void {
	trashedPostsCache.set(key, {
		expiresAt: Date.now() + TRASH_LIST_CACHE_TTL_MS,
		value: cloneTrashedPosts(posts),
	});
}

function clearCachedTrashedPosts(params: {
	githubBase: string;
	branch: string;
}): void {
	trashedPostsCache.delete(getTrashedPostsCacheKey(params));
}

async function mapWithConcurrency<T, R>(
	items: T[],
	concurrency: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length < 1) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	async function worker() {
		for (;;) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) {
				return;
			}
			results[currentIndex] = await mapper(items[currentIndex], currentIndex);
		}
	}

	await Promise.all(Array.from({ length: limit }, () => worker()));
	return results;
}

function getLocalRepoAbsolutePath(repoPath: string): string {
	return resolve(process.cwd(), repoPath);
}

async function readLocalRepoFile(repoPath: string): Promise<string | null> {
	if (!import.meta.env.DEV) return null;
	try {
		return await readFile(getLocalRepoAbsolutePath(repoPath), "utf8");
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return null;
		}
		throw error;
	}
}

async function writeLocalRepoFile(
	repoPath: string,
	content: string,
): Promise<void> {
	if (!import.meta.env.DEV) return;
	const absolutePath = getLocalRepoAbsolutePath(repoPath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf8");
}

async function deleteLocalRepoFile(repoPath: string): Promise<void> {
	if (!import.meta.env.DEV) return;
	await rm(getLocalRepoAbsolutePath(repoPath), { force: true });
}

function encodeGitHubPath(path: string): string {
	return path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

function json(status: number, payload: Record<string, unknown>) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

async function parseTrashRequest(request: Request): Promise<TrashRequest> {
	const raw = await request.text();
	if (!raw) return {};
	try {
		return JSON.parse(raw) as TrashRequest;
	} catch {
		const params = new URLSearchParams(raw);
		return {
			action: (params.get("action") || "") as TrashAction,
			postId: params.get("postId") || "",
			devCode: params.get("devCode") || "",
			devCodeHash: params.get("devCodeHash") || "",
		};
	}
}

function toYamlString(input: string): string {
	return `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sanitizePostId(input: string | undefined): string {
	if (!input) return "";
	const normalized = input.trim().replace(/\\/g, "/").replace(/^\/+/, "");
	if (!normalized.endsWith(".md")) return "";
	if (normalized.includes("..")) return "";
	if (normalized.startsWith("src/content/posts/")) {
		return normalized.slice(POSTS_ROOT.length);
	}
	return normalized;
}

function sanitizePostIds(input: string[] | string | undefined): string[] {
	if (!input) return [];
	const rawValues = Array.isArray(input) ? input : input.split(",");
	return Array.from(
		new Set(rawValues.map((item) => sanitizePostId(item)).filter(Boolean)),
	);
}

function toRepoPath(postId: string): string {
	return `${POSTS_ROOT}${postId}`;
}

function decodeGithubBase64(content: string): string {
	return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
}

function encodeGithubBase64(content: string): string {
	return Buffer.from(content, "utf8").toString("base64");
}

function splitFrontmatter(markdown: string): {
	frontmatter: string;
	body: string;
} | null {
	const normalizedMarkdown = markdown.replace(/^\uFEFF/, "");
	const match = normalizedMarkdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return null;
	return {
		frontmatter: match[1] || "",
		body: normalizedMarkdown.slice(match[0].length),
	};
}

function upsertFrontmatterLine(
	lines: string[],
	key: string,
	value: string | null,
): string[] {
	const keyPattern = new RegExp(`^\\s*${key}\\s*:`);
	const nextLines: string[] = [];
	let found = false;

	for (const line of lines) {
		if (keyPattern.test(line)) {
			found = true;
			if (value !== null) {
				nextLines.push(`${key}: ${value}`);
			}
			continue;
		}
		nextLines.push(line);
	}

	if (!found && value !== null) {
		nextLines.push(`${key}: ${value}`);
	}

	while (
		nextLines.length > 0 &&
		nextLines[nextLines.length - 1]?.trim() === ""
	) {
		nextLines.pop();
	}

	return nextLines;
}

function applyTrashFlag(markdown: string, trashed: boolean): string {
	const parsed = splitFrontmatter(markdown);
	if (!parsed) {
		throw new Error("文章内容缺少 frontmatter");
	}

	let frontmatterLines = parsed.frontmatter.split(/\r?\n/);
	frontmatterLines = upsertFrontmatterLine(
		frontmatterLines,
		"trashed",
		trashed ? "true" : "false",
	);
	frontmatterLines = upsertFrontmatterLine(
		frontmatterLines,
		"trashedAt",
		trashed ? toYamlString(new Date().toISOString()) : null,
	);

	const normalizedBody = parsed.body.replace(/^\r?\n/, "");
	const rebuilt = `---\n${frontmatterLines.join("\n")}\n---\n\n${normalizedBody}`;
	return rebuilt.replace(/\n*$/, "\n");
}

function parseFrontmatterValue(frontmatter: string, key: string): string {
	const matched = frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
	if (!matched) return "";
	return matched[1]?.trim() || "";
}

function unquoteYamlValue(rawValue: string): string {
	const value = rawValue.trim();
	if (!value) return "";
	if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
		return value.slice(1, -1).replace(/''/g, "'");
	}
	return value;
}

function parseFrontmatterBool(frontmatter: string, key: string): boolean {
	const value = parseFrontmatterValue(frontmatter, key).toLowerCase();
	return value === "true";
}

function toSlugFromRepoPath(path: string): string {
	let slug = path
		.replace(new RegExp(`^${POSTS_ROOT}`), "")
		.replace(/\.md$/i, "");
	if (slug.endsWith("/index")) {
		slug = slug.slice(0, -"/index".length);
	}
	return slug;
}

function sortTrashedPosts(posts: TrashedPost[]): TrashedPost[] {
	return [...posts].sort((a, b) => {
		const timeA = a.trashedAt ? new Date(a.trashedAt).getTime() : 0;
		const timeB = b.trashedAt ? new Date(b.trashedAt).getTime() : 0;
		return timeB - timeA;
	});
}

async function listLocalPostPaths(relativeDir = POSTS_ROOT): Promise<string[]> {
	if (!import.meta.env.DEV) return [];
	try {
		const entries = await readdir(getLocalRepoAbsolutePath(relativeDir), {
			withFileTypes: true,
		});
		const nested = await Promise.all(
			entries.map(async (entry) => {
				const nextRelativePath = `${relativeDir}${entry.name}`;
				if (entry.isDirectory()) {
					return listLocalPostPaths(`${nextRelativePath}/`);
				}
				if (entry.isFile() && nextRelativePath.endsWith(".md")) {
					return [nextRelativePath];
				}
				return [];
			}),
		);
		return nested.flat();
	} catch (error) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			error.code === "ENOENT"
		) {
			return [];
		}
		throw error;
	}
}

async function readRepoFile(params: {
	githubBase: string;
	path: string;
	branch: string;
	headers: Record<string, string>;
}): Promise<GitHubFile | null> {
	const response = await fetch(
		`${params.githubBase}/contents/${encodeGitHubPath(params.path)}?ref=${encodeURIComponent(params.branch)}`,
		{
			headers: params.headers,
		},
	);

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`读取 GitHub 文件失败: ${response.status} ${errText}`);
	}

	const result = (await response.json()) as {
		sha?: string;
		content?: string;
	};

	if (!result.sha || !result.content) {
		throw new Error("GitHub 返回文件数据不完整");
	}

	return {
		sha: result.sha,
		content: decodeGithubBase64(result.content),
	};
}

async function writeRepoFile(params: {
	githubBase: string;
	path: string;
	branch: string;
	headers: Record<string, string>;
	sha: string;
	content: string;
	commitMessage: string;
}): Promise<string> {
	const response = await fetch(
		`${params.githubBase}/contents/${encodeGitHubPath(params.path)}`,
		{
			method: "PUT",
			headers: {
				...params.headers,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				message: params.commitMessage,
				content: encodeGithubBase64(params.content),
				branch: params.branch,
				sha: params.sha,
			}),
		},
	);

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`提交 GitHub 失败: ${response.status} ${errText}`);
	}

	const result = (await response.json()) as {
		commit?: { html_url?: string };
	};

	return result.commit?.html_url || "";
}

async function deleteRepoFile(params: {
	githubBase: string;
	path: string;
	branch: string;
	headers: Record<string, string>;
	sha: string;
	commitMessage: string;
}): Promise<string> {
	const response = await fetch(
		`${params.githubBase}/contents/${encodeGitHubPath(params.path)}`,
		{
			method: "DELETE",
			headers: {
				...params.headers,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				message: params.commitMessage,
				branch: params.branch,
				sha: params.sha,
			}),
		},
	);

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`删除 GitHub 文件失败: ${response.status} ${errText}`);
	}

	const result = (await response.json()) as {
		commit?: { html_url?: string };
	};

	return result.commit?.html_url || "";
}

function extractTrashedPost(
	path: string,
	markdown: string,
): TrashedPost | null {
	const parsed = splitFrontmatter(markdown);
	if (!parsed) return null;
	if (!parseFrontmatterBool(parsed.frontmatter, "trashed")) return null;

	const slug = toSlugFromRepoPath(path);
	const titleRaw = parseFrontmatterValue(parsed.frontmatter, "title");
	const title = unquoteYamlValue(titleRaw) || slug || "未命名文章";
	const publishedRaw = parseFrontmatterValue(parsed.frontmatter, "published");
	const trashedAtRaw = parseFrontmatterValue(parsed.frontmatter, "trashedAt");

	return {
		id: path.replace(new RegExp(`^${POSTS_ROOT}`), ""),
		slug,
		title,
		published: unquoteYamlValue(publishedRaw),
		trashedAt: unquoteYamlValue(trashedAtRaw),
	};
}

async function listTrashedPosts(params: {
	githubBase: string;
	branch: string;
	headers: Record<string, string>;
}): Promise<TrashedPost[]> {
	if (import.meta.env.DEV) {
		const localPostPaths = await listLocalPostPaths();
		const parsedPosts = await mapWithConcurrency(
			localPostPaths,
			TRASH_LIST_READ_CONCURRENCY,
			async (path) => {
				const file = await readLocalRepoFile(path);
				if (!file) return null;
				return extractTrashedPost(path, file);
			},
		);
		return sortTrashedPosts(
			parsedPosts.filter((item): item is TrashedPost => Boolean(item)),
		);
	}

	const cacheKey = getTrashedPostsCacheKey(params);
	const cachedPosts = getCachedTrashedPosts(cacheKey);
	if (cachedPosts) {
		return cachedPosts;
	}

	const existingEntry = trashedPostsCache.get(cacheKey);
	if (existingEntry?.inflight) {
		return cloneTrashedPosts(await existingEntry.inflight);
	}

	const inflight = (async () => {
		const treeResponse = await fetch(
			`${params.githubBase}/git/trees/${encodeURIComponent(params.branch)}?recursive=1`,
			{
				headers: params.headers,
			},
		);

		if (!treeResponse.ok) {
			const errText = await treeResponse.text();
			throw new Error(`读取仓库目录失败: ${treeResponse.status} ${errText}`);
		}

		const treePayload = (await treeResponse.json()) as {
			tree?: Array<{ path?: string; type?: string }>;
		};

		const postPaths = (treePayload.tree || [])
			.filter((item) => item.type === "blob" && typeof item.path === "string")
			.map((item) => item.path || "")
			.filter((path) => path.startsWith(POSTS_ROOT) && path.endsWith(".md"));

		const parsedPosts = await mapWithConcurrency(
			postPaths,
			TRASH_LIST_READ_CONCURRENCY,
			async (path) => {
				const file = await readRepoFile({
					githubBase: params.githubBase,
					path,
					branch: params.branch,
					headers: params.headers,
				});
				if (!file) return null;
				return extractTrashedPost(path, file.content);
			},
		);

		const trashedPosts = sortTrashedPosts(
			parsedPosts.filter((item): item is TrashedPost => Boolean(item)),
		);

		setCachedTrashedPosts(cacheKey, trashedPosts);
		return trashedPosts;
	})();

	trashedPostsCache.set(cacheKey, {
		expiresAt: 0,
		inflight,
	});

	try {
		return cloneTrashedPosts(await inflight);
	} catch (error) {
		trashedPostsCache.delete(cacheKey);
		throw error;
	}
}

async function triggerDeployHook(
	hookUrl: string | undefined,
): Promise<boolean> {
	if (!hookUrl) return false;
	try {
		const response = await fetch(hookUrl, { method: "POST" });
		return response.ok;
	} catch {
		return false;
	}
}

async function deleteSinglePost(params: {
	githubBase: string;
	branch: string;
	headers: Record<string, string>;
	postId: string;
}): Promise<{
	path: string;
	commitUrl: string;
}> {
	const path = toRepoPath(params.postId);
	const existingFile = await readRepoFile({
		githubBase: params.githubBase,
		path,
		branch: params.branch,
		headers: params.headers,
	});
	if (!existingFile) {
		const localOnlyFile = await readLocalRepoFile(path);
		if (localOnlyFile !== null && import.meta.env.DEV) {
			await deleteLocalRepoFile(path);
			clearCachedTrashedPosts({
				githubBase: params.githubBase,
				branch: params.branch,
			});
			return {
				path,
				commitUrl: "",
			};
		}
		throw new Error(`文章文件不存在: ${params.postId}`);
	}

	const commitUrl = await deleteRepoFile({
		githubBase: params.githubBase,
		path,
		branch: params.branch,
		headers: params.headers,
		sha: existingFile.sha,
		commitMessage: `chore(post): delete ${params.postId}`,
	});
	await deleteLocalRepoFile(path);
	clearCachedTrashedPosts({
		githubBase: params.githubBase,
		branch: params.branch,
	});

	return {
		path,
		commitUrl,
	};
}

async function updateSinglePostTrashState(params: {
	githubBase: string;
	branch: string;
	headers: Record<string, string>;
	postId: string;
	shouldTrash: boolean;
}): Promise<{
	path: string;
	commitUrl: string;
	skipped: boolean;
}> {
	const path = toRepoPath(params.postId);
	const existingFile = await readRepoFile({
		githubBase: params.githubBase,
		path,
		branch: params.branch,
		headers: params.headers,
	});
	if (!existingFile) {
		const localOnlyFile = await readLocalRepoFile(path);
		if (localOnlyFile !== null && import.meta.env.DEV) {
			const nextMarkdown = applyTrashFlag(localOnlyFile, params.shouldTrash);
			if (nextMarkdown === localOnlyFile) {
				return {
					path,
					commitUrl: "",
					skipped: true,
				};
			}
			await writeLocalRepoFile(path, nextMarkdown);
			clearCachedTrashedPosts({
				githubBase: params.githubBase,
				branch: params.branch,
			});
			return {
				path,
				commitUrl: "",
				skipped: false,
			};
		}
	}
	if (!existingFile) {
		throw new Error(`文章文件不存在: ${params.postId}`);
	}

	const nextMarkdown = applyTrashFlag(existingFile.content, params.shouldTrash);
	if (nextMarkdown === existingFile.content) {
		return {
			path,
			commitUrl: "",
			skipped: true,
		};
	}

	const commitUrl = await writeRepoFile({
		githubBase: params.githubBase,
		path,
		branch: params.branch,
		headers: params.headers,
		sha: existingFile.sha,
		content: nextMarkdown,
		commitMessage: `chore(post): ${params.shouldTrash ? "trash" : "restore"} ${params.postId}`,
	});
	await writeLocalRepoFile(path, nextMarkdown);
	clearCachedTrashedPosts({
		githubBase: params.githubBase,
		branch: params.branch,
	});

	return {
		path,
		commitUrl,
		skipped: false,
	};
}

export const POST: APIRoute = async ({ request }) => {
	const githubToken = import.meta.env.GITHUB_TOKEN;
	const githubOwner = import.meta.env.GITHUB_OWNER;
	const githubRepo = import.meta.env.GITHUB_REPO;
	const githubBranch = import.meta.env.GITHUB_BRANCH || "main";
	const vercelDeployHook = import.meta.env.VERCEL_DEPLOY_HOOK_URL;
	const expectedCode = import.meta.env.DEV_EDITOR_CODE;
	if (!expectedCode) {
		return json(500, { ok: false, message: "Server misconfigured: DEV_EDITOR_CODE not set" });
	}

	if (!githubToken || !githubOwner || !githubRepo) {
		return json(500, {
			ok: false,
			message: "缺少发布环境变量：GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO",
		});
	}

	let body: TrashRequest;
	try {
		body = await parseTrashRequest(request);
	} catch {
		return json(400, { ok: false, message: "请求体不是有效 JSON" });
	}

	if (
		!matchDevCredential({
			devCode: body.devCode,
			devCodeHash: body.devCodeHash,
			expectedCode,
		})
	) {
		return json(403, { ok: false, message: "开发者口令校验失败" });
	}

	const action = body.action || "list";
	if (!["list", "move", "restore", "delete"].includes(action)) {
		return json(400, { ok: false, message: "不支持的动作" });
	}

	const githubBase = `https://api.github.com/repos/${githubOwner}/${githubRepo}`;
	const commonHeaders = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${githubToken}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};

	try {
		if (action === "list") {
			const posts = await listTrashedPosts({
				githubBase,
				branch: githubBranch,
				headers: commonHeaders,
			});
			return json(200, { ok: true, posts });
		}

		const normalizedPostIds = Array.from(
			new Set([
				...sanitizePostIds(body.postIds),
				...(() => {
					const singlePostId = sanitizePostId(body.postId);
					return singlePostId ? [singlePostId] : [];
				})(),
			]),
		);
		const postId = normalizedPostIds[0];
		if (!["delete", "move"].includes(action) && normalizedPostIds.length > 1) {
			return json(400, {
				ok: false,
				message: "Only move and delete support multiple postIds",
			});
		}
		if (["delete", "move"].includes(action) && normalizedPostIds.length > 1) {
			const deletedPaths: string[] = [];
			const commitUrls: string[] = [];
			for (const currentPostId of normalizedPostIds) {
				if (action === "delete") {
					const result = await deleteSinglePost({
						githubBase,
						branch: githubBranch,
						headers: commonHeaders,
						postId: currentPostId,
					});
					deletedPaths.push(result.path);
					if (result.commitUrl) {
						commitUrls.push(result.commitUrl);
					}
					continue;
				}

				const result = await updateSinglePostTrashState({
					githubBase,
					branch: githubBranch,
					headers: commonHeaders,
					postId: currentPostId,
					shouldTrash: true,
				});
				deletedPaths.push(result.path);
				if (result.commitUrl) {
					commitUrls.push(result.commitUrl);
				}
			}

			const deployed = await triggerDeployHook(vercelDeployHook);
			return json(200, {
				ok: true,
				action,
				postIds: normalizedPostIds,
				paths: deletedPaths,
				commitUrls,
				count: deletedPaths.length,
				deployed,
			});
		}
		if (!postId) {
			return json(400, { ok: false, message: "postId 无效" });
		}

		const path = toRepoPath(postId);
		const existingFile = await readRepoFile({
			githubBase,
			path,
			branch: githubBranch,
			headers: commonHeaders,
		});
		if (!existingFile && !import.meta.env.DEV) {
			return json(404, { ok: false, message: "文章文件不存在" });
		}

		if (action === "delete") {
			const result = await deleteSinglePost({
				githubBase,
				branch: githubBranch,
				headers: commonHeaders,
				postId,
			});
			const deployed = await triggerDeployHook(vercelDeployHook);
			return json(200, {
				ok: true,
				action,
				path: result.path,
				postId,
				commitUrl: result.commitUrl,
				deployed,
			});
		}

		const shouldTrash = action === "move";
		const result = await updateSinglePostTrashState({
			githubBase,
			branch: githubBranch,
			headers: commonHeaders,
			postId,
			shouldTrash,
		});
		if (result.skipped) {
			return json(200, {
				ok: true,
				action,
				path,
				postId,
				commitUrl: "",
				deployed: false,
			});
		}

		const deployed = await triggerDeployHook(vercelDeployHook);

		return json(200, {
			ok: true,
			action,
			path,
			postId,
			commitUrl: result.commitUrl,
			deployed,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : "垃圾桶操作失败";
		return json(502, { ok: false, message });
	}
};

export const GET: APIRoute = async () => {
	return json(200, {
		ok: true,
		message:
			"Use POST with action=list|move|restore|delete and postId or postIds.",
	});
};
