import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { matchDevCredential } from "@utils/dev-auth-server";
import {
	FESTIVAL_CONFIG_REPO_PATH,
	type FestivalFlags,
	normalizeFestivalFlags,
} from "@utils/festival-settings";
import type { APIRoute } from "astro";

export const prerender = false;

type GitHubFile = {
	sha: string;
	content: string;
};

type GithubEnv = {
	githubBase: string;
	branch: string;
	headers: Record<string, string>;
};

function json(status: number, payload: Record<string, unknown>) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "未知错误";
}

function encodeGitHubPath(path: string): string {
	return path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

function decodeGithubBase64(content: string): string {
	return Buffer.from(content.replace(/\n/g, ""), "base64").toString("utf8");
}

function encodeGithubBase64(content: string): string {
	return Buffer.from(content, "utf8").toString("base64");
}

function serializeFlags(flags: FestivalFlags): string {
	return `${JSON.stringify(flags, null, "\t")}\n`;
}

function parseFlagsText(text: string): FestivalFlags | null {
	try {
		return normalizeFestivalFlags(JSON.parse(text));
	} catch {
		return null;
	}
}

function describeFlags(flags: FestivalFlags): string {
	if (flags.midAutumn) return "开启中秋灯笼效果";
	if (flags.newYear) return "开启新年灯笼效果";
	if (flags.nationalDay) return "开启国庆花朵效果";
	return "关闭所有节日效果";
}

function getGithubEnv(): GithubEnv | null {
	const token = import.meta.env.GITHUB_TOKEN;
	const owner = import.meta.env.GITHUB_OWNER;
	const repo = import.meta.env.GITHUB_REPO;
	if (!token || !owner || !repo) return null;
	return {
		githubBase: `https://api.github.com/repos/${owner}/${repo}`,
		branch: import.meta.env.GITHUB_BRANCH || "main",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	};
}

function readCredentials(payload: {
	devCode?: unknown;
	devCodeHash?: unknown;
}): { devCode: string; devCodeHash: string } {
	return {
		devCode: typeof payload.devCode === "string" ? payload.devCode : "",
		devCodeHash:
			typeof payload.devCodeHash === "string" ? payload.devCodeHash : "",
	};
}

function isAuthorized(
	credentials: { devCode: string; devCodeHash: string },
	expectedCode: string,
): boolean {
	return matchDevCredential({
		devCode: credentials.devCode,
		devCodeHash: credentials.devCodeHash,
		expectedCode,
	});
}

function getLocalConfigPath(): string {
	return resolve(process.cwd(), FESTIVAL_CONFIG_REPO_PATH);
}

async function readLocalConfig(): Promise<FestivalFlags | null> {
	try {
		return parseFlagsText(await readFile(getLocalConfigPath(), "utf8"));
	} catch {
		return null;
	}
}

async function writeLocalConfig(content: string): Promise<void> {
	const absolutePath = getLocalConfigPath();
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf8");
}

async function readRepoFile(
	env: GithubEnv,
	path: string,
): Promise<GitHubFile | null> {
	const response = await fetch(
		`${env.githubBase}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(env.branch)}`,
		{ headers: env.headers },
	);

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`读取 GitHub 文件失败：${response.status} ${errText}`);
	}

	const result = (await response.json()) as {
		sha?: string;
		content?: string;
	};

	if (!result.sha || !result.content) {
		throw new Error("GitHub 文件响应不完整");
	}

	return {
		sha: result.sha,
		content: decodeGithubBase64(result.content),
	};
}

async function writeRepoFile(params: {
	env: GithubEnv;
	path: string;
	content: string;
	commitMessage: string;
	sha?: string;
}): Promise<string> {
	const response = await fetch(
		`${params.env.githubBase}/contents/${encodeGitHubPath(params.path)}`,
		{
			method: "PUT",
			headers: {
				...params.env.headers,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				message: params.commitMessage,
				content: encodeGithubBase64(params.content),
				branch: params.env.branch,
				...(params.sha ? { sha: params.sha } : {}),
			}),
		},
	);

	if (!response.ok) {
		const errText = await response.text();
		throw new Error(`写入 GitHub 失败：${response.status} ${errText}`);
	}

	const result = (await response.json()) as {
		commit?: { html_url?: string };
	};

	return result.commit?.html_url || "";
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

async function readCurrentFlags(): Promise<{
	flags: FestivalFlags;
	source: "github" | "local";
} | null> {
	// 本地开发优先读本地文件，和构建期读取的保持一致
	if (import.meta.env.DEV) {
		const localFlags = await readLocalConfig();
		if (localFlags) return { flags: localFlags, source: "local" };
	}
	const env = getGithubEnv();
	if (env) {
		const file = await readRepoFile(env, FESTIVAL_CONFIG_REPO_PATH);
		if (!file) return null;
		const flags = parseFlagsText(file.content);
		return flags ? { flags, source: "github" } : null;
	}
	const flags = await readLocalConfig();
	return flags ? { flags, source: "local" } : null;
}

// GET：读取当前节日配置（控制台用来显示真实状态）
export const GET: APIRoute = async ({ request }) => {
	const expectedCode = import.meta.env.DEV_EDITOR_CODE || "";
	if (!expectedCode) {
		return json(500, {
			ok: false,
			message: "服务端未配置 DEV_EDITOR_CODE",
		});
	}

	const url = new URL(request.url);
	const credentials = readCredentials({
		devCode: url.searchParams.get("devCode"),
		devCodeHash: url.searchParams.get("devCodeHash"),
	});
	if (!isAuthorized(credentials, expectedCode)) {
		return json(403, { ok: false, message: "开发者口令校验失败" });
	}

	try {
		const current = await readCurrentFlags();
		if (!current) {
			return json(404, {
				ok: false,
				message: "仓库里还没有节日配置文件，保存一次就会创建",
			});
		}
		return json(200, {
			ok: true,
			flags: current.flags,
			source: current.source,
		});
	} catch (error) {
		return json(500, { ok: false, message: errorMessage(error) });
	}
};

// POST：写入节日配置并触发重新部署
export const POST: APIRoute = async ({ request }) => {
	const expectedCode = import.meta.env.DEV_EDITOR_CODE || "";
	if (!expectedCode) {
		return json(500, {
			ok: false,
			message: "服务端未配置 DEV_EDITOR_CODE",
		});
	}

	let body: {
		midAutumn?: unknown;
		newYear?: unknown;
		devCode?: unknown;
		devCodeHash?: unknown;
	};
	try {
		body = JSON.parse((await request.text()) || "{}");
	} catch {
		return json(400, { ok: false, message: "请求体不是有效 JSON" });
	}

	const flags = normalizeFestivalFlags(body);
	if (!flags) {
		return json(400, {
			ok: false,
			message: "缺少 midAutumn / newYear 布尔值",
		});
	}

	if (!isAuthorized(readCredentials(body), expectedCode)) {
		return json(403, { ok: false, message: "开发者口令校验失败" });
	}

	const content = serializeFlags(flags);
	const env = getGithubEnv();

	try {
		// 本地开发时同步落盘，保证本地配置和线上一致
		if (import.meta.env.DEV) {
			await writeLocalConfig(content);
		}

		if (!env) {
			if (!import.meta.env.DEV) {
				return json(500, {
					ok: false,
					message:
						"缺少发布环境变量：GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO",
				});
			}
			// 本地开发没有 token 时只改本地文件，方便调试
			return json(200, {
				ok: true,
				flags,
				source: "local",
				deployed: false,
				commitUrl: "",
			});
		}

		const existing = await readRepoFile(env, FESTIVAL_CONFIG_REPO_PATH);
		const commitUrl = await writeRepoFile({
			env,
			path: FESTIVAL_CONFIG_REPO_PATH,
			content,
			commitMessage: `chore(festival): ${describeFlags(flags)}`,
			sha: existing?.sha,
		});
		const deployed = await triggerDeployHook(
			import.meta.env.VERCEL_DEPLOY_HOOK_URL,
		);

		return json(200, {
			ok: true,
			flags,
			source: "github",
			deployed,
			commitUrl,
		});
	} catch (error) {
		return json(500, { ok: false, message: errorMessage(error) });
	}
};
