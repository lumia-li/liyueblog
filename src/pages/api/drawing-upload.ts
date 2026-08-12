import type { APIRoute } from "astro";

export const prerender = false;

const MAX_UPLOAD_SIZE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_MIME_TYPES = new Set(["image/png"]);

function json(status: number, payload: Record<string, unknown>) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
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

function buildDrawingRepoPath(): string {
	const now = new Date();
	const yyyy = String(now.getUTCFullYear());
	const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(now.getUTCDate()).padStart(2, "0");
	const random = Math.random().toString(36).slice(2, 10);
	const ts = Date.now();
	return `public/comments/drawings/${yyyy}/${mm}/${dd}/drawing-${ts}-${random}.png`;
}

export const POST: APIRoute = async ({ request }) => {
	let body: Record<string, unknown>;
	try {
		body = await request.json();
	} catch {
		return json(400, { ok: false, message: "Invalid JSON body" });
	}

	const image = String(body.image || "");
	if (!image) {
		return json(400, { ok: false, message: "Missing image field" });
	}

	const match = image.match(/^data:(image\/\w+);base64,(.+)$/);
	if (!match) {
		return json(400, { ok: false, message: "Invalid data URL" });
	}

	const mimeType = match[1];
	const base64Content = match[2];

	if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
		return json(400, { ok: false, message: "Only PNG drawings are allowed" });
	}

	if (base64Content.length > MAX_UPLOAD_SIZE_BYTES * 1.4) {
		return json(413, { ok: false, message: "Drawing is too large" });
	}

	let binaryBuffer: Buffer;
	try {
		binaryBuffer = Buffer.from(base64Content, "base64");
	} catch {
		return json(400, { ok: false, message: "Failed to decode image" });
	}

	if (binaryBuffer.byteLength <= 0 || binaryBuffer.byteLength > MAX_UPLOAD_SIZE_BYTES) {
		return json(413, { ok: false, message: "Drawing is too large" });
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

	const repoPath = buildDrawingRepoPath();
	const contentBase64 = binaryBuffer.toString("base64");
	const commitMessage = `chore(comment): upload drawing ${repoPath}`;

	try {
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
			url: buildGitHubRawFileUrl({
				owner: githubOwner,
				repo: githubRepo,
				branch: githubBranch,
				repoPath,
			}),
			path: repoPath,
			commitUrl,
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Failed to upload drawing";
		return json(502, { ok: false, message });
	}
};

export const GET: APIRoute = async () => {
	return json(200, {
		ok: true,
		message: "Use POST with JSON { image: 'data:image/png;base64,...' }",
	});
};
