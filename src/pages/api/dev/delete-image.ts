import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { matchDevCredential } from "@utils/dev-auth-server";
import type { APIRoute } from "astro";

export const prerender = false;

type DeleteImageRequest = {
	src?: string;
	path?: string;
	devCode?: string;
	devCodeHash?: string;
};

function json(status: number, payload: Record<string, unknown>) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

async function parseDeleteImageRequest(request: Request): Promise<DeleteImageRequest> {
	const raw = await request.text();
	if (!raw) return {};
	try {
		return JSON.parse(raw) as DeleteImageRequest;
	} catch {
		const params = new URLSearchParams(raw);
		return {
			src: params.get("src") || "",
			path: params.get("path") || "",
			devCode: params.get("devCode") || "",
			devCodeHash: params.get("devCodeHash") || "",
		};
	}
}

function normalizeEditorUploadRepoPathFromInput(input: string): string | null {
	const trimmed = (input || "").trim();
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
		// Keep raw value when decode fails.
	}

	if (pathname.includes("..")) {
		return null;
	}

	const embeddedPublicMarker = "/public/uploads/editor/";
	const embeddedPublicIndex = pathname.indexOf(embeddedPublicMarker);
	if (embeddedPublicIndex >= 0) {
		return pathname.slice(embeddedPublicIndex + 1);
	}

	if (pathname.startsWith("public/uploads/editor/")) {
		return pathname;
	}
	if (pathname.startsWith("/uploads/editor/")) {
		return `public${pathname}`;
	}
	return null;
}

function getLocalRepoAbsolutePath(repoPath: string): string {
	return resolve(process.cwd(), repoPath);
}

async function deleteLocalRepoFile(repoPath: string): Promise<boolean> {
	try {
		await rm(getLocalRepoAbsolutePath(repoPath), { force: true });
		return true;
	} catch {
		return false;
	}
}

function encodeGitHubPath(path: string): string {
	return path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
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

	if (response.status === 404) return null;
	if (!response.ok) {
		const errText = await response.text();
		throw new Error(
			`Failed to read GitHub file sha: ${response.status} ${errText}`,
		);
	}

	const result = (await response.json()) as { sha?: string };
	return result.sha || null;
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
		throw new Error(
			`Failed to delete GitHub file: ${response.status} ${errText}`,
		);
	}

	const result = (await response.json()) as { commit?: { html_url?: string } };
	return result.commit?.html_url || "";
}

export const POST: APIRoute = async ({ request }) => {
	const expectedCode = import.meta.env.DEV_EDITOR_CODE;
	if (!expectedCode) {
		return json(500, { ok: false, message: "Server misconfigured: DEV_EDITOR_CODE not set" });
	}

	let body: DeleteImageRequest;
	try {
		body = await parseDeleteImageRequest(request);
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

	const repoPath =
		normalizeEditorUploadRepoPathFromInput(body.path || "") ||
		normalizeEditorUploadRepoPathFromInput(body.src || "");
	if (!repoPath) {
		return json(400, {
			ok: false,
			message: "Only /uploads/editor/* images are supported for file deletion.",
		});
	}

	const localDeleted = await deleteLocalRepoFile(repoPath);

	const githubToken = import.meta.env.GITHUB_TOKEN;
	const githubOwner = import.meta.env.GITHUB_OWNER;
	const githubRepo = import.meta.env.GITHUB_REPO;
	const githubBranch = import.meta.env.GITHUB_BRANCH || "main";

	let githubDeleted = false;
	let commitUrl = "";
	if (githubToken && githubOwner && githubRepo) {
		const githubBase = `https://api.github.com/repos/${githubOwner}/${githubRepo}`;
		const commonHeaders = {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${githubToken}`,
			"X-GitHub-Api-Version": "2022-11-28",
		};

		try {
			const sha = await readRepoFileSha({
				githubBase,
				path: repoPath,
				branch: githubBranch,
				headers: commonHeaders,
			});
			if (sha) {
				commitUrl = await deleteRepoFile({
					githubBase,
					path: repoPath,
					branch: githubBranch,
					headers: commonHeaders,
					sha,
					commitMessage: `chore(editor): delete image ${repoPath}`,
				});
				githubDeleted = true;
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to delete GitHub file";
			return json(502, { ok: false, message });
		}
	}

	return json(200, {
		ok: true,
		path: repoPath,
		localDeleted,
		githubDeleted,
		commitUrl,
	});
};

export const GET: APIRoute = async () => {
	return json(200, {
		ok: true,
		message: "Use POST to delete uploaded editor image files.",
	});
};
