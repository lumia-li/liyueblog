// 节日自动排期
// ------------------------------------------------------------------
// 按真实日历（农历 / 公历）判断今天处在哪个节日的窗口里，到点自动把对应的
// 节日开关写回 src/data/festival.json。
// 由 .github/workflows/festival-schedule.yml 每天定时执行；只有配置真的变化
// 时才会提交，提交会触发 Vercel 重新部署，于是线上自动切换节日效果。
//
// 用法：
//   node scripts/festival-schedule.mjs                     # 按「今天」写入
//   node scripts/festival-schedule.mjs --dry-run           # 只打印，不改文件
//   node scripts/festival-schedule.mjs --date=2026-10-01   # 指定日期（测试用）
// ------------------------------------------------------------------
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONFIG_PATH = resolve(process.cwd(), "src/data/festival.json");
const TIME_ZONE = "Asia/Shanghai";

/**
 * 节日窗口：以节日当天为 0，窗口范围是 [−beforeDays, +afterDays]。
 * 窗口之外会自动「关闭所有节日效果」，所以不需要再手动关。
 * 想只在节日当天生效，把 beforeDays / afterDays 都改成 0 即可。
 */
const FESTIVALS = [
	{
		key: "newYear",
		label: "春节",
		lunar: { month: 1, day: 1 },
		beforeDays: 1,
		afterDays: 7,
	},
	{
		key: "midAutumn",
		label: "中秋",
		lunar: { month: 8, day: 15 },
		beforeDays: 1,
		afterDays: 3,
	},
	{
		key: "nationalDay",
		label: "国庆",
		solar: { month: 10, day: 1 },
		beforeDays: 1,
		afterDays: 6,
	},
];

/** 写回文件时的字段顺序（保持 diff 稳定） */
const FLAG_ORDER = [
	"midAutumn",
	"newYear",
	"nationalDay",
	"autoPlay",
	"autoPlayAllPages",
	"autoSchedule",
];

const MODE_LABELS = {
	midAutumn: "开启中秋灯笼效果",
	newYear: "开启新年灯笼效果",
	nationalDay: "开启国庆花朵效果",
	none: "关闭所有节日效果",
};

function parseArgs(argv) {
	const options = { dryRun: false, date: "" };
	for (const arg of argv) {
		if (arg === "--dry-run") options.dryRun = true;
		else if (arg.startsWith("--date=")) {
			options.date = arg.slice("--date=".length);
		}
	}
	return options;
}

/** 北京时间的今天，格式 YYYY-MM-DD */
function todayInTimeZone() {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: TIME_ZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
}

/** 纯日期加减，不涉及时区 */
function addDays(dayText, days) {
	const [year, month, day] = dayText.split("-").map(Number);
	const date = new Date(Date.UTC(year, month - 1, day));
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

/**
 * 农历月日：用运行环境内置的农历日历算，和前台 Lantern 组件是同一套，
 * 不引第三方库（Node 20+ 自带完整 ICU）
 */
function lunarDayOf(dayText) {
	const date = new Date(`${dayText}T12:00:00+08:00`);
	const parts = new Intl.DateTimeFormat("en-u-ca-chinese", {
		timeZone: TIME_ZONE,
		month: "numeric",
		day: "numeric",
	}).formatToParts(date);
	return {
		month: Number(parts.find((part) => part.type === "month")?.value),
		day: Number(parts.find((part) => part.type === "day")?.value),
	};
}

/** 公历月日 */
function solarDayOf(dayText) {
	const [, month, day] = dayText.split("-").map(Number);
	return { month, day };
}

/**
 * 今天处在哪个节日的窗口里；窗口重叠时取离节日当天最近的那个
 * offset = 今天到节日当天的天数差：正数 = 节前几天，负数 = 节后几天，
 * 所以「提前 beforeDays 天开、节后 afterDays 天关」对应 offset ∈ [-afterDays, +beforeDays]
 */
function findActiveFestival(dayText) {
	let hit = null;
	for (const festival of FESTIVALS) {
		const target = festival.lunar ?? festival.solar;
		for (
			let offset = -festival.afterDays;
			offset <= festival.beforeDays;
			offset += 1
		) {
			const day = addDays(dayText, offset);
			const current = festival.lunar ? lunarDayOf(day) : solarDayOf(day);
			if (current.month !== target.month || current.day !== target.day) {
				continue;
			}
			const distance = Math.abs(offset);
			if (!hit || distance < hit.distance) {
				hit = { festival, offset, distance };
			}
		}
	}
	return hit;
}

/** 生成目标配置：只动三个节日开关，其余开关保持原样 */
function buildFlags(current, activeKey) {
	const next = {};
	for (const key of FLAG_ORDER) {
		if (key === "midAutumn" || key === "newYear" || key === "nationalDay") {
			next[key] = key === activeKey;
			continue;
		}
		// autoSchedule 缺省视为开启；其余字段缺省视为关闭
		next[key] =
			key === "autoSchedule" ? current[key] !== false : current[key] === true;
	}
	return next;
}

function serializeFlags(flags) {
	return `${JSON.stringify(flags, null, "\t")}\n`;
}

function isSameFlags(a, b) {
	return FLAG_ORDER.every((key) => a[key] === b[key]);
}

function describeFlags(flags) {
	const mode =
		FLAG_ORDER.find(
			(key) =>
				(key === "midAutumn" || key === "newYear" || key === "nationalDay") &&
				flags[key],
		) ?? "none";
	return `${MODE_LABELS[mode]}（日历自动）`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const dayText = options.date || todayInTimeZone();
	const current = JSON.parse(await readFile(CONFIG_PATH, "utf8"));

	if (current.autoSchedule === false) {
		console.log(`[festival] ${dayText}：自动排期已关闭（autoSchedule=false），跳过`);
		return;
	}

	const hit = findActiveFestival(dayText);
	const activeKey = hit?.festival.key ?? null;
	const next = buildFlags(current, activeKey);

	if (isSameFlags(current, next)) {
		console.log(`[festival] ${dayText}：无需变更（当前已是 ${describeFlags(next)}）`);
		return;
	}

	const summary = describeFlags(next);
	let relation = "节日当天";
	if (hit && hit.offset > 0) relation = `节前 ${hit.offset} 天`;
	else if (hit && hit.offset < 0) relation = `节后 ${-hit.offset} 天`;

	const detail = hit
		? `${hit.festival.label}窗口内（${relation}）`
		: "不在任何节日窗口内";

	if (options.dryRun) {
		console.log(`[festival] ${dayText}：${detail}`);
		console.log(`[festival] 将要写入：${serializeFlags(next).trimEnd()}`);
	} else {
		await writeFile(CONFIG_PATH, serializeFlags(next), "utf8");
		console.log(`[festival] ${dayText}：${detail}`);
		console.log(`[festival] 已写入 festival.json`);
	}
	// 最后一行给工作流当提交信息用
	console.log(summary);
}

await main();
