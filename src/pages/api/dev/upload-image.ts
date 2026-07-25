import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { matchDevCredential } from "@utils/dev-auth-server";
import type { APIRoute } from "astro";

export const prerender = false;

const MAX_UPLOAD_SIZE_BYTES = 12 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"image/svg+xml",
	"image/avif",
]);

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
		case "image/svg+xml":
			return "svg";
		case "image/avif":
			return "avif";
		default:
			return "png";
	}
}

function normalizeFileBaseName(raw: string): string {
	const base = raw
		.toLowerCase()
		.trim()
		.replace(/\.[a-z0-9]+$/i, "")
		.replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return base || "image";
}

function buildUploadRepoPath(file: File): string {
	const now = new Date();
	const yyyy = String(now.getUTCFullYear());
	const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(now.getUTCDate()).padStart(2, "0");
	const ext = normalizeExtFromMime(file.type);
	const originalBase = normalizeFileBaseName(file.name || "image");
	const random = Math.random().toString(36).slice(2, 10);
	return `public/uploads/editor/${yyyy}/${mm}/${dd}/${originalBase}-${Date.now()}-${random}.${ext}`;
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

function buildGitHubRawFileUrl(params: {
	owner: string;
	repo: string;
	branch: string;
	repoPath: string;
}): string {
	const encodedRepoPath = params.repoPath
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	return `https://raw.githubusercontent.com/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/${encodeURIComponent(params.branch)}/${encodedRepoPath}`;
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
			`Failed to upload image to GitHub: ${response.status} ${errText}`,
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

	const devCode = String(form.get("devCode") || "");
	const devCodeHash = String(form.get("devCodeHash") || "");
	if (
		!matchDevCredential({
			devCode,
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

	if (fileLike.size <= 0 || fileLike.size > MAX_UPLOAD_SIZE_BYTES) {
		return json(400, {
			ok: false,
			message: `Image size must be between 1 byte and ${MAX_UPLOAD_SIZE_BYTES} bytes`,
		});
	}

	const repoPath = buildUploadRepoPath(fileLike);
	const publicUrl = `/${repoPath.replace(/^public\//, "")}`;

	try {
		const arrayBuffer = await fileLike.arrayBuffer();
		const binaryBuffer = Buffer.from(arrayBuffer);
		await writeLocalBinaryRepoFile(repoPath, binaryBuffer);

		// In local DEV editing flow, keep uploads local first.
		if (import.meta.env.DEV) {
			return json(200, {
				ok: true,
				path: repoPath,
				url: publicUrl,
				commitUrl: "",
				localOnly: true,
			});
		}
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to write local image";
		return json(500, { ok: false, message });
	}

	const githubToken = import.meta.env.GITHUB_TOKEN;
	const githubOwner = import.meta.env.GITHUB_OWNER;
	const githubRepo = import.meta.env.GITHUB_REPO;
	const githubBranch = import.meta.env.GITHUB_BRANCH || "main";

	if (!githubToken || !githubOwner || !githubRepo) {
		return json(500, {
			ok: false,
			message:
				"Missing publish environment variables: GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO",
		});
	}

	const githubBase = `https://api.github.com/repos/${githubOwner}/${githubRepo}`;
	const commonHeaders = {
		Accept: "application/vnd.github+json",
		Authorization: `Bearer ${githubToken}`,
		"X-GitHub-Api-Version": "2022-11-28",
	};

	try {
		const arrayBuffer = await fileLike.arrayBuffer();
		const binaryBuffer = Buffer.from(arrayBuffer);
		const contentBase64 = binaryBuffer.toString("base64");
		const commitMessage = `chore(editor): upload image ${repoPath}`;

		const commitUrl = await writeRepoBinaryFile({
			githubBase,
			path: repoPath,
			branch: githubBranch,
			headers: commonHeaders,
			contentBase64,
			commitMessage,
		});

		return json(200, {
			ok: true,
			path: repoPath,
			url: buildGitHubRawFileUrl({
				owner: githubOwner,
				repo: githubRepo,
				branch: githubBranch,
				repoPath,
			}),
			publicUrl,
			commitUrl,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to upload image";
		return json(502, { ok: false, message });
	}
};

export const GET: APIRoute = async () => {
	return json(200, {
		ok: true,
		message: "Use POST multipart/form-data with file to upload image.",
	});
};
