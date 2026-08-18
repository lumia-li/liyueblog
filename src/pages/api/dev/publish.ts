import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { matchDevCredential } from "@utils/dev-auth-server";
import type { APIRoute } from "astro";

export const prerender = false;

type PublishRequest = {
	type?: "post" | "thought";
	title?: string;
	slug?: string;
	originalSlug?: string;
	description?: string;
	tags?: string[] | string;
	category?: string;
	image?: string;
	draft?: boolean;
	content?: string;
	published?: string;
	devCode?: string;
	devCodeHash?: string;
};

type GitHubFile = {
	sha: string;
	content: string;
};

const POSTS_ROOT = "src/content/posts/";
const THOUGHTS_ROOT = "src/content/thoughts/";

function getLocalRepoAbsolutePath(repoPath: string): string {
	return resolve(process.cwd(), repoPath);
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

function json(status: number, payload: Record<string, unknown>) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

async function parsePublishRequest(request: Request): Promise<PublishRequest> {
	const raw = await request.text();
	if (!raw) return {};
	try {
		return JSON.parse(raw) as PublishRequest;
	} catch {
		const params = new URLSearchParams(raw);
		return {
			type: params.get("type") === "thought" ? "thought" : "post",
			title: params.get("title") || "",
			slug: params.get("slug") || "",
			originalSlug: params.get("originalSlug") || "",
			description: params.get("description") || "",
			tags: params.get("tags") || "",
			category: params.get("category") || "",
			image: params.get("image") || "",
			draft: params.get("draft") === "true",
			content: params.get("content") || "",
			published: params.get("published") || "",
			devCode: params.get("devCode") || "",
			devCodeHash: params.get("devCodeHash") || "",
		};
	}
}

function encodeGitHubPath(path: string): string {
	return path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}

function toYamlString(input: string): string {
	return `"${input.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseTags(input: string[] | string | undefined): string[] {
	if (!input) return [];
	if (Array.isArray(input)) {
		return input.map((item) => item.trim()).filter(Boolean);
	}
	return input
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}

function normalizeImage(input: string): string {
	const value = input.trim();
	if (!value) return "";
	if (
		value.startsWith("http://") ||
		value.startsWith("https://") ||
		value.startsWith("/") ||
		value.startsWith("data:")
	) {
		return value;
	}
	// Allow relative local image paths such as cover.png / folder/cover.webp
	if (/\.(png|jpe?g|webp|gif|svg|avif)$/i.test(value)) {
		return value;
	}
	// Invalid image input should not break the build.
	return "";
}

function normalizeEditorUploadRepoPathFromUrl(rawUrl: string): string | null {
	const trimmed = rawUrl.trim();
	if (!trimmed) return null;

	let pathname = trimmed;
	if (/^https?:\/\//i.test(trimmed)) {
		try {
			pathname = new URL(trimmed).pathname;
		} catch {
			return null;
		}
	}

	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// Keep raw pathname when decode fails.
	}

	if (!pathname.startsWith("/uploads/editor/")) {
		return null;
	}
	if (pathname.includes("..")) {
		return null;
	}

	return `public${pathname}`;
}

function collectEditorUploadRepoPaths(input: {
	content: string;
	image: string;
}): string[] {
	const repoPaths = new Set<string>();

	const collectFromUrl = (url: string) => {
		const repoPath = normalizeEditorUploadRepoPathFromUrl(url);
		if (repoPath) {
			repoPaths.add(repoPath);
		}
	};

	collectFromUrl(input.image);

	const markdownImagePattern =
		/!\[[^\]]*\]\(\s*(?:<)?([^)>\s]+)(?:>)?(?:\s+["'][^"']*["'])?\s*\)/gi;
	for (const match of input.content.matchAll(markdownImagePattern)) {
		collectFromUrl(match[1] || "");
	}

	const htmlImagePattern = /<img\b[^>]*\bsrc=(["'])(.*?)\1[^>]*>/gi;
	for (const match of input.content.matchAll(htmlImagePattern)) {
		collectFromUrl(match[2] || "");
	}

	return Array.from(repoPaths);
}

function toRepoPath(slug: string, type: string): string {
	const root = type === "thought" ? THOUGHTS_ROOT : POSTS_ROOT;
	return `${root}${slug}.md`;
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
	const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return null;
	return {
		frontmatter: match[1] || "",
		body: markdown.slice(match[0].length),
	};
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

function normalizePublished(input: string | undefined): string {
	const value = (input || "").trim();
	if (!value) return "";
	return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}

function readPublishedFromMarkdown(markdown: string): string {
	const parsed = splitFrontmatter(markdown);
	if (!parsed) return "";
	return normalizePublished(
		unquoteYamlValue(parseFrontmatterValue(parsed.frontmatter, "published")),
	);
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
		throw new Error(
			`Failed to read GitHub file: ${response.status} ${errText}`,
		);
	}

	const result = (await response.json()) as {
		sha?: string;
		content?: string;
	};

	if (!result.sha || !result.content) {
		throw new Error("GitHub file response is incomplete");
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
	content: string;
	commitMessage: string;
	sha?: string;
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
				...(params.sha ? { sha: params.sha } : {}),
			}),
		},
	);

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(
			`Failed to publish to GitHub: ${response.status} ${errText}`,
		);
	}

	const result = (await response.json()) as {
		commit?: { html_url?: string };
	};

	return result.commit?.html_url || "";
}

async function readRepoFileSha(params: {
	githubBase: string;
	path: string;
	branch: string;
	headers: Record<string, string>;
}): Promise<string | null> {
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
		throw new Error(
			`Failed to read GitHub file sha: ${response.status} ${errText}`,
		);
	}

	const result = (await response.json()) as {
		sha?: string;
	};

	return result.sha || null;
}

async function writeRepoBinaryFile(params: {
	githubBase: string;
	path: string;
	branch: string;
	headers: Record<string, string>;
	contentBase64: string;
	commitMessage: string;
	sha?: string;
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
				content: params.contentBase64,
				branch: params.branch,
				...(params.sha ? { sha: params.sha } : {}),
			}),
		},
	);

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(
			`Failed to publish image to GitHub: ${response.status} ${errText}`,
		);
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
}): Promise<void> {
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
		throw new Error(
			`Failed to delete GitHub file: ${response.status} ${errText}`,
		);
	}
}

function buildMarkdown(payload: {
	type?: string;
	title: string;
	published: string;
	description: string;
	image: string;
	tags: string[];
	category: string;
	draft: boolean;
	content: string;
}): string {
	const published = payload.published || new Date().toISOString().slice(0, 10);

	// 随笔模式：frontmatter 只保留 thoughts collection 支持的字段
	if (payload.type === "thought") {
		return `---
title: ${toYamlString(payload.title)}
published: ${published}
description: ${toYamlString(payload.description)}
---

${payload.content.trim()}\n`;
	}

	const tagLines = payload.tags.length
		? payload.tags.map((tag) => `  - ${toYamlString(tag)}`).join("\n")
		: '  - ""';

	return `---
title: ${toYamlString(payload.title)}
published: ${published}
description: ${toYamlString(payload.description)}
image: ${toYamlString(payload.image)}
tags:
${tagLines}
category: ${toYamlString(payload.category)}
draft: ${payload.draft ? "true" : "false"}
---

${payload.content.trim()}\n`;
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

	let body: PublishRequest;
	try {
		body = await parsePublishRequest(request);
	} catch {
		return json(400, { ok: false, message: "Request body is not valid JSON" });
	}

	if (
		!matchDevCredential({
			devCode: body.devCode,
			devCodeHash: body.devCodeHash,
			expectedCode,
		})
	) {
		return json(403, {
			ok: false,
			message: "Developer credential validation failed",
		});
	}

	const type = body.type === "thought" ? "thought" : "post";
	const title = (body.title || "").trim();
	const content = (body.content || "").trim();
	// 随笔允许省略标题（随笔标题可选，frontmatter 中 title 可留空）
	if (!title && type !== "thought") {
		return json(400, { ok: false, message: "Title is required" });
	}
	if (!content) {
		return json(400, { ok: false, message: "Content is required" });
	}

	const slugBase = (body.slug || "").trim() || title;
	let slug = slugify(slugBase);
	if (!slug) {
		slug = type === "thought" ? `thought-${Date.now()}` : `post-${Date.now()}`;
	}

	const rawOriginalSlug = (body.originalSlug || "").trim();
	const originalSlug = rawOriginalSlug ? slugify(rawOriginalSlug) : "";
	if (rawOriginalSlug && !originalSlug) {
		return json(400, { ok: false, message: "Original slug is invalid" });
	}

	const path = toRepoPath(slug, type);
	const sourcePath = originalSlug ? toRepoPath(originalSlug, type) : path;
	const githubBase = `https://api.github.com/repos/${githubOwner}/${githubRepo}`;
	const commonHeaders = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${githubToken}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};

	let existingSourceFile: GitHubFile | null = null;
	let existingTargetFile: GitHubFile | null = null;

	try {
		if (originalSlug) {
			existingSourceFile = await readRepoFile({
				githubBase,
				path: sourcePath,
				branch: githubBranch,
				headers: commonHeaders,
			});
			if (!existingSourceFile) {
				return json(404, {
					ok: false,
					message: `Original post not found: ${originalSlug}`,
				});
			}
		}

		existingTargetFile =
			sourcePath === path
				? existingSourceFile
				: await readRepoFile({
						githubBase,
						path,
						branch: githubBranch,
						headers: commonHeaders,
					});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to read GitHub file";
		return json(502, { ok: false, message });
	}

	if (!originalSlug && existingTargetFile) {
		return json(409, {
			ok: false,
			message: `Slug "${slug}" already exists. Create flow will not overwrite an existing post. Change the slug or use edit flow.`,
		});
	}

	if (originalSlug && sourcePath !== path && existingTargetFile) {
		return json(409, {
			ok: false,
			message: `Target slug "${slug}" already exists. Cannot rename "${originalSlug}" to an existing post.`,
		});
	}

	const published =
		readPublishedFromMarkdown(existingSourceFile?.content || "") ||
		normalizePublished(body.published) ||
		new Date().toISOString().slice(0, 10);

	const markdown = buildMarkdown({
		type,
		title,
		published,
		description: (body.description || "").trim(),
		image: normalizeImage(body.image || ""),
		tags: parseTags(body.tags),
		category: (body.category || "").trim(),
		draft: Boolean(body.draft),
		content,
	});

	const editorUploadRepoPaths = collectEditorUploadRepoPaths({
		content,
		image: normalizeImage(body.image || ""),
	});
	for (const repoPath of editorUploadRepoPaths) {
		let existingSha: string | null = null;
		try {
			existingSha = await readRepoFileSha({
				githubBase,
				path: repoPath,
				branch: githubBranch,
				headers: commonHeaders,
			});
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: `Failed to resolve image sha: ${repoPath}`;
			return json(502, { ok: false, message });
		}

		let binary: Buffer | null = null;
		try {
			binary = await readFile(getLocalRepoAbsolutePath(repoPath));
		} catch {
			if (existingSha) {
				continue;
			}
			return json(400, {
				ok: false,
				message: `本地图片不存在，无法发布：${repoPath}`,
			});
		}

		try {
			await writeRepoBinaryFile({
				githubBase,
				path: repoPath,
				branch: githubBranch,
				headers: commonHeaders,
				contentBase64: binary.toString("base64"),
				commitMessage: `chore(editor): upload image ${repoPath}`,
				sha: existingSha || undefined,
			});
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: `Failed to publish image: ${repoPath}`;
			return json(502, { ok: false, message });
		}
	}

	const kind = type === "thought" ? "thought" : "post";
	const commitMessage = originalSlug
		? sourcePath === path
			? `chore(${kind}): update ${slug}`
			: `chore(${kind}): rename ${originalSlug} -> ${slug}`
		: `feat(${kind}): publish ${slug}`;

	let commitUrl = "";
	try {
		commitUrl = await writeRepoFile({
			githubBase,
			path,
			branch: githubBranch,
			headers: commonHeaders,
			content: markdown,
			commitMessage,
			sha: existingTargetFile?.sha,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to publish to GitHub";
		return json(502, { ok: false, message });
	}

	if (originalSlug && sourcePath !== path && existingSourceFile?.sha) {
		try {
			await deleteRepoFile({
				githubBase,
				path: sourcePath,
				branch: githubBranch,
				headers: commonHeaders,
				sha: existingSourceFile.sha,
				commitMessage: `chore(post): remove old slug ${originalSlug}`,
			});
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to delete old slug";
			return json(502, {
				ok: false,
				message: `${message}. The new file is already written to ${path}. Please delete the old file ${sourcePath} manually.`,
				path,
				slug,
				commitUrl,
			});
		}
	}

	try {
		await writeLocalRepoFile(path, markdown);
		if (originalSlug && sourcePath !== path) {
			await deleteLocalRepoFile(sourcePath);
		}
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to sync local workspace";
		return json(500, {
			ok: false,
			message: `${message}. GitHub is already updated at ${path}.`,
			path,
			slug,
			commitUrl,
		});
	}

	let deployed = false;
	if (vercelDeployHook) {
		const deployResponse = await fetch(vercelDeployHook, { method: "POST" });
		deployed = deployResponse.ok;
	}

	return json(200, {
		ok: true,
		path,
		slug,
		published,
		commitUrl,
		deployed,
	});
};

export const GET: APIRoute = async () => {
	return json(200, {
		ok: true,
		message: "Use POST to publish markdown content.",
	});
};
