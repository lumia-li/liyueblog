import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { matchDevCredential } from "@utils/dev-auth-server";
import type { APIRoute } from "astro";

export const prerender = false;

const MAX_COVER_SIZE_BYTES = 12 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/avif",
]);

const POSTS_ROOT = "src/content/posts/";

function json(status: number, payload: Record<string, unknown>) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

function normalizeExtFromMime(mime: string): string {
	switch (mime) {
		case "image/png":
			return "png";
		case "image/jpeg":
			return "jpg";
		case "image/webp":
			return "webp";
		case "image/gif":
			return "gif";
		case "image/avif":
			return "avif";
		default:
			return "png";
	}
}

function normalizeSlugBase(raw: string): string {
	const base = raw
		.toLowerCase()
		.trim()
		.slice(0, 60)
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return base || "cover";
}

function buildCoverRepoPath(file: File, slugBase: string): string {
	const ext = normalizeExtFromMime(file.type);
	const base = normalizeSlugBase(slugBase);
	const random = Math.random().toString(36).slice(2, 10);
	return `${POSTS_ROOT}cover-${base}-${Date.now()}-${random}.${ext}`;
}

function getLocalRepoAbsolutePath(repoPath: string): string {
	return resolve(process.cwd(), repoPath);
}

async function writeLocalBinaryRepoFile(
	repoPath: string,
	content: Buffer,
): Promise<void> {
	if (!import.meta.env.DEV) return;
	const absolutePath = getLocalRepoAbsolutePath(repoPath);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, new Uint8Array(content));
}

function encodeGitHubPath(path: string): string {
	return path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

async function writeRepoBinaryFile(params: {
	githubBase: string;
	path: string;
	branch: string;
	headers: Record<string, string>;
	contentBase64: string;
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
				content: params.contentBase64,
				branch: params.branch,
			}),
		},
	);

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(
			`Failed to upload cover to GitHub: ${response.status} ${errText}`,
		);
	}

	const result = (await response.json()) as {
		commit?: { html_url?: string };
	};

	return result.commit?.html_url || "";
}

export const POST: APIRoute = async ({ request }) => {
	const expectedCode = import.meta.env.DEV_EDITOR_CODE;
	if (!expectedCode) {
		return json(500, { ok: false, message: "Server misconfigured: DEV_EDITOR_CODE not set" });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json(400, { ok: false, message: "Invalid form data" });
	}

	const devCodeHash = String(form.get("devCodeHash") || "");
	if (
		!matchDevCredential({
			devCode: "",
			devCodeHash,
			expectedCode,
		})
	) {
		return json(403, {
			ok: false,
			message: "Developer credential validation failed",
		});
	}

	const fileLike = form.get("file");
	if (!(fileLike instanceof File)) {
		return json(400, { ok: false, message: "File is required" });
	}

	if (!ALLOWED_IMAGE_MIME_TYPES.has(fileLike.type)) {
		return json(400, { ok: false, message: "Unsupported image type" });
	}

	if (fileLike.size <= 0 || fileLike.size > MAX_COVER_SIZE_BYTES) {
		return json(400, {
			ok: false,
			message: `Image size must be between 1 byte and ${MAX_COVER_SIZE_BYTES} bytes`,
		});
	}

	const slugBase = String(form.get("slugBase") || "cover");
	const repoPath = buildCoverRepoPath(fileLike, slugBase);
	const fileName = repoPath.slice(POSTS_ROOT.length);

	const githubToken = import.meta.env.GITHUB_TOKEN;
	const githubOwner = import.meta.env.GITHUB_OWNER;
	const githubRepo = import.meta.env.GITHUB_REPO;
	const githubBranch = import.meta.env.GITHUB_BRANCH || "main";

	try {
		const arrayBuffer = await fileLike.arrayBuffer();
		const binaryBuffer = Buffer.from(arrayBuffer);

		// 本地开发：先写本地仓库文件，发布文章时统一推送到 GitHub
		if (import.meta.env.DEV) {
			await writeLocalBinaryRepoFile(repoPath, binaryBuffer);
			return json(200, {
				ok: true,
				fileName,
				path: repoPath,
				localOnly: true,
			});
		}

		// 线上环境：直接上传到 GitHub 文章目录
		if (!githubToken || !githubOwner || !githubRepo) {
			return json(500, {
				ok: false,
				message:
					"Missing publish environment variables: GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO",
			});
		}

		const githubBase = `https://api.github.com/repos/${githubOwner}/${githubRepo}`;
		await writeRepoBinaryFile({
			githubBase,
			path: repoPath,
			branch: githubBranch,
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${githubToken}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
			contentBase64: binaryBuffer.toString("base64"),
			commitMessage: `chore(editor): upload cover ${repoPath}`,
		});

		return json(200, {
			ok: true,
			fileName,
			path: repoPath,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to upload cover";
		return json(500, { ok: false, message });
	}
};

export const GET: APIRoute = async () => {
	return json(200, {
		ok: true,
		message: "Use POST multipart/form-data with file to upload a post cover.",
	});
};
