// 「正在播放」同步接口
// - GET ：站点前端（同域）读取当前状态，带几秒 CDN 缓存
// - POST：本机 MusicBar 上报曲目 / 播放状态（需要口令），写入仓库里的状态文件
// 写入不触发重新部署：vercel.json 的 ignoreCommand 会跳过只改状态文件的提交
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { matchDevCredential } from "@utils/dev-auth-server";
import { getGithubEnv, readRepoFile, writeRepoFile } from "@utils/github-repo";
import {
	NOWPLAYING_STATE_REPO_PATH,
	describeNowPlayingState,
	type NowPlayingState,
	emptyNowPlayingState,
	normalizeNowPlayingState,
	parseNowPlayingState,
	serializeNowPlayingState,
} from "@utils/nowplaying-settings";
import type { APIRoute } from "astro";

export const prerender = false;

function json(status: number, payload: unknown, cacheSeconds = 0): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control":
				cacheSeconds > 0
					? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=60`
					: "no-store",
		},
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "未知错误";
}

function getLocalStatePath(): string {
	return resolve(process.cwd(), NOWPLAYING_STATE_REPO_PATH);
}

async function readLocalState(): Promise<NowPlayingState> {
	try {
		return parseNowPlayingState(await readFile(getLocalStatePath(), "utf8"));
	} catch {
		return emptyNowPlayingState();
	}
}

async function writeLocalState(content: string): Promise<void> {
	const absolutePath = getLocalStatePath();
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content, "utf8");
}

/**
 * 线上读仓库文件：构建产物里的那份是部署时的旧数据，
 * 页面要的是「刚刚」的播放状态，所以每次走 GitHub API。
 */
async function readCurrentState(): Promise<NowPlayingState> {
	if (import.meta.env.DEV) {
		return readLocalState();
	}

	const env = getGithubEnv();
	if (!env) {
		return readLocalState();
	}

	const file = await readRepoFile(env, NOWPLAYING_STATE_REPO_PATH);
	return file ? parseNowPlayingState(file.content) : emptyNowPlayingState();
}

function readCredential(
	request: Request,
	body: unknown,
): { devCode: string; devCodeHash: string } {
	const headerCode = request.headers.get("x-nowplaying-code") || "";
	const record =
		body && typeof body === "object" ? (body as Record<string, unknown>) : {};
	return {
		devCode:
			headerCode || (typeof record.code === "string" ? record.code : ""),
		devCodeHash:
			typeof record.codeHash === "string" ? record.codeHash : "",
	};
}

// GET：站内组件读取，无需口令
export const GET: APIRoute = async () => {
	try {
		const state = await readCurrentState();
		return json(200, { ok: true, state }, 5);
	} catch (error) {
		// 读不到也别让页面报错：返回空状态，组件会自动隐藏
		return json(
			200,
			{ ok: false, state: emptyNowPlayingState(), message: errorMessage(error) },
			2,
		);
	}
};

// POST：MusicBar 上报（换歌 / 播放暂停时各来一次）
export const POST: APIRoute = async ({ request }) => {
	let body: unknown = null;
	try {
		body = JSON.parse((await request.text()) || "{}");
	} catch {
		return json(400, { ok: false, message: "请求体不是有效 JSON" });
	}

	const expectedCode =
		import.meta.env.NOWPLAYING_CODE || import.meta.env.DEV_EDITOR_CODE || "";
	if (!expectedCode) {
		return json(500, {
			ok: false,
			message: "服务端未配置 NOWPLAYING_CODE 环境变量",
		});
	}

	const credential = readCredential(request, body);
	if (!matchDevCredential({ ...credential, expectedCode })) {
		return json(403, { ok: false, message: "口令校验失败" });
	}

	const state = normalizeNowPlayingState(body);
	if (!state) {
		return json(400, { ok: false, message: "无法解析播放状态" });
	}

	const content = serializeNowPlayingState(state);

	try {
		// 本地开发：直接写工作区文件，立刻能在预览里看到
		if (import.meta.env.DEV) {
			await writeLocalState(content);
			return json(200, { ok: true, state, source: "local" });
		}

		const env = getGithubEnv();
		if (!env) {
			return json(500, {
				ok: false,
				message: "缺少环境变量：GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO",
			});
		}

		const existing = await readRepoFile(env, NOWPLAYING_STATE_REPO_PATH);
		const commitUrl = await writeRepoFile({
			env,
			path: NOWPLAYING_STATE_REPO_PATH,
			content,
			commitMessage: `chore(nowplaying): ${describeNowPlayingState(state)}`,
			sha: existing?.sha,
		});

		return json(200, { ok: true, state, source: "github", commitUrl });
	} catch (error) {
		return json(500, { ok: false, message: errorMessage(error) });
	}
};
