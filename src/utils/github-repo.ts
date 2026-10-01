// GitHub 仓库文件读写：给需要从外部改仓库文件的接口复用（如 /api/nowplaying）
// 环境变量与站内控制台一致：GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO / GITHUB_BRANCH
//
// 支持写「非默认分支」：正在播放这类高频数据放在独立分支上，
// 默认分支（main）不会因为上报产生提交，自然也不会触发重新部署。

export type GithubEnv = {
	githubBase: string;
	branch: string;
	headers: Record<string, string>;
};

export type GithubFile = {
	sha: string;
	content: string;
};

/** 一次进程内确认过的分支，避免每次上报都去查一遍 */
const ensuredBranches = new Set<string>();

export function getGithubEnv(): GithubEnv | null {
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

/**
 * 确保目标分支存在：不存在就从默认分支的最新提交拉一个出来。
 * 已经存在（含并发创建返回 422）时直接放过。
 */
export async function ensureRepoBranch(
	env: GithubEnv,
	branch: string,
): Promise<void> {
	if (!branch || branch === env.branch) return;

	const cacheKey = `${env.githubBase}#${branch}`;
	if (ensuredBranches.has(cacheKey)) return;

	const existing = await fetch(
		`${env.githubBase}/branches/${encodeURIComponent(branch)}`,
		{ headers: env.headers },
	);
	if (existing.ok) {
		ensuredBranches.add(cacheKey);
		return;
	}

	const headResponse = await fetch(
		`${env.githubBase}/git/ref/heads/${encodeURIComponent(env.branch)}`,
		{ headers: env.headers },
	);
	if (!headResponse.ok) {
		throw new Error(`读取 ${env.branch} 分支失败：${headResponse.status}`);
	}

	const head = (await headResponse.json()) as { object?: { sha?: string } };
	const sha = head.object?.sha;
	if (!sha) {
		throw new Error("取不到默认分支的最新提交");
	}

	const created = await fetch(`${env.githubBase}/git/refs`, {
		method: "POST",
		headers: { ...env.headers, "Content-Type": "application/json" },
		body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
	});

	// 422：并发下已被别人创建，可以直接用
	if (!created.ok && created.status !== 422) {
		const errText = await created.text();
		throw new Error(`创建分支 ${branch} 失败：${created.status} ${errText}`);
	}

	ensuredBranches.add(cacheKey);
}

/** 读取仓库文件；文件不存在返回 null */
export async function readRepoFile(
	env: GithubEnv,
	path: string,
	ref?: string,
): Promise<GithubFile | null> {
	const target = ref || env.branch;
	const response = await fetch(
		`${env.githubBase}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(target)}`,
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

/** 写入仓库文件（传 sha 表示更新已有文件），返回提交地址 */
export async function writeRepoFile(params: {
	env: GithubEnv;
	path: string;
	content: string;
	commitMessage: string;
	sha?: string;
	ref?: string;
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
				branch: params.ref || params.env.branch,
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
