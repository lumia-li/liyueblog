#!/usr/bin/env node
// 把旧不蒜子的历史计数导入自建统计（Upstash Redis）
//
// 用法：
//   node --env-file=.env scripts/import-busuanzi-count.mjs <导出文件.json>
//   例：node --env-file=.env scripts/import-busuanzi-count.mjs ../.bsz-export/busuanzi-export.json
//
// 环境变量（任选一组，优先级从上到下）：
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN
//   KV_REST_API_URL / KV_REST_API_TOKEN        （Vercel KV 集成注入的名字）
//   COUNT_REDIS_URL / COUNT_REDIS_TOKEN
//
// 说明：
//   - 站点总量用 SET 直接写入，重复执行结果一致（幂等）
//   - UV 是 Redis 集合，人数靠 SCARD 统计，所以用 seed:1..seed:N 占位成员补齐基数，
//     之后真实访客再 SADD 各自的哈希，总数就无缝接上了
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const BATCH_SIZE = 200;

const file = resolve(process.argv[2] || "busuanzi-export.json");
const url = (
	process.env.UPSTASH_REDIS_REST_URL ||
	process.env.KV_REST_API_URL ||
	process.env.COUNT_REDIS_URL ||
	""
).replace(/\/+$/, "");
const token =
	process.env.UPSTASH_REDIS_REST_TOKEN ||
	process.env.KV_REST_API_TOKEN ||
	process.env.COUNT_REDIS_TOKEN ||
	"";

if (!url || !token) {
	console.error(
		"缺少 Redis 配置：请先设置 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN（或 COUNT_REDIS_URL / COUNT_REDIS_TOKEN）",
	);
	console.error(
		"提示：用 node --env-file=.env scripts/import-busuanzi-count.mjs <文件> 运行",
	);
	process.exit(1);
}

function normalizePath(raw) {
	let path = String(raw || "/");
	path = path.split("?")[0].split("#")[0];
	path = path.replace(/\/{2,}/g, "/");
	if (!path.startsWith("/")) path = `/${path}`;
	if (path.length > 1 && !path.endsWith("/")) path = `${path}/`;
	path = path.replace(/[^\p{L}\p{N}\-_/.~%]/gu, "");
	if (!path) path = "/";
	return path.slice(0, 200);
}

async function send(commands) {
	const response = await fetch(`${url}/pipeline`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(commands),
	});
	if (!response.ok) {
		throw new Error(`Redis 请求失败（${response.status}）：${await response.text()}`);
	}
	const payload = await response.json();
	const failed = payload.find((item) => item?.error);
	if (failed) throw new Error(`Redis 执行失败：${failed.error}`);
	return payload;
}

/** 分批提交，避免单次 pipeline 过大 */
async function submit(commands, label) {
	for (let i = 0; i < commands.length; i += BATCH_SIZE) {
		await send(commands.slice(i, i + BATCH_SIZE));
	}
	console.log(`✓ ${label}：${commands.length} 条命令`);
}

const raw = JSON.parse(await readFile(file, "utf8"));
const sitePv = Number(raw?.site?.site_pv ?? 0);
const siteUv = Number(raw?.site?.site_uv ?? 0);
const pages = Array.isArray(raw?.pages) ? raw.pages : [];

console.log(`读取导出文件：${file}`);
console.log(`站点总量：PV ${sitePv} / UV ${siteUv}`);
console.log(`页面数量：${pages.length}`);

// 1. 站点总量
const siteCommands = [["SET", "site:pv", sitePv], ["DEL", "site:uv"]];
for (let i = 1; i <= siteUv; i += 1) {
	siteCommands.push(["SADD", "site:uv", `seed:${i}`]);
}
await submit(siteCommands, "站点总量已写入");

// 2. 逐页数据
const pageCommands = [];
let touchedPages = 0;
for (const page of pages) {
	const path = normalizePath(page?.path);
	const pv = Number(page?.page_pv ?? 0);
	const uv = Number(page?.page_uv ?? 0);
	if (pv <= 0 && uv <= 0) continue;
	pageCommands.push(["SET", `page:${path}:pv`, pv]);
	pageCommands.push(["DEL", `page:${path}:uv`]);
	for (let i = 1; i <= uv; i += 1) {
		pageCommands.push(["SADD", `page:${path}:uv`, `seed:${i}`]);
	}
	touchedPages += 1;
}
await submit(pageCommands, `逐页数据已写入（${touchedPages} 个页面）`);

// 3. 校验
const verify = await send([
	["GET", "site:pv"],
	["SCARD", "site:uv"],
	["GET", "page:/:pv"],
	["SCARD", "page:/:uv"],
]);
console.log("校验结果：");
console.log(`  站点 PV = ${verify[0]?.result}`);
console.log(`  站点 UV = ${verify[1]?.result}`);
console.log(`  首页 PV = ${verify[2]?.result}`);
console.log(`  首页 UV = ${verify[3]?.result}`);
console.log("导入完成。UV 里的 seed:* 成员只是占位，真实访客会继续累加。");
