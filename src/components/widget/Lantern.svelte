<script lang="ts">
import {
	FESTIVAL_SETTINGS_CHANGE_EVENT,
	type FestivalFlags,
	type FestivalMode,
	resolveFestivalFlags,
	resolveFestivalMode,
} from "@utils/festival-settings";
import { onMount } from "svelte";
import { cubicOut } from "svelte/easing";
import { fade } from "svelte/transition";
import festivalConfig from "../../data/festival.json";

type FestivalLantern = {
	id: number;
	left: string;
	duration: string;
	delay: string;
};

type FestivalFlower = {
	id: number;
	left: string;
	src: string;
	duration: string;
	delay: string;
	sway: string;
	rockTime: string;
};

/* ==================================================================
 * 节日开关
 * ------------------------------------------------------------------
 * 开关值来自仓库里的 src/data/festival.json：站内开发者控制台 /dev 可以切换，
 * 保存后提交配置并触发重新部署，全站生效。
 * 部署完成前，本机会先用「本机预览」立即生效（两者一致时自动清理预览）。
 *
 * 开启节日后，按钮统一走这套逻辑：
 *   「🏮 灯笼已关」纸片 → 悬停撕纸 → 露出节日按钮 → 点击触发节日效果 + 弹文字
 *   → 长按倒放撕纸、把纸片贴回去
 *     中秋 = 露出「🌕 中秋快乐」，点击放飞中秋灯笼雨
 *     新年 = 露出「🏮 新年快乐」，点击挂出顶部 4 个新年灯笼
 *     国庆 = 露出「🌼 国庆快乐」，点击撒下一轮国庆花朵
 *
 * 三个节日都关闭时，按钮回到原来的「躲开点击 + 连点 5 次消失」彩蛋。
 * ================================================================== */
const BUILD_FESTIVAL_FLAGS: FestivalFlags = {
	midAutumn: festivalConfig.midAutumn,
	newYear: festivalConfig.newYear,
	nationalDay: festivalConfig.nationalDay,
};

let festivalMode: FestivalMode = resolveFestivalMode(BUILD_FESTIVAL_FLAGS);
/* ================================================================== */

// 旧版本把灯笼/按钮状态持久化进了 localStorage，现在只用于清理，不再读写
const LEGACY_LANTERN_ENABLED_KEY = "lanternEnabled";
const LEGACY_LANTERN_CONTROL_HIDDEN_KEY = "lanternControlHidden";
const LEGACY_LANTERN_DODGE_ATTEMPTS_KEY = "lanternDodgeAttempts";
const LEGACY_LANTERN_POSITION_KEYS = [
	"lanternPositionV2_desktop",
	"lanternPositionV2_mobile",
];

/* ---------------- 中秋模式参数 ---------------- */
// 撕纸动画时长（需与 CSS 中的 animation 时长保持一致）
const TEAR_DURATION_MS = 640;
// 长按多久算"长按"（长按 = 把纸片贴回去）
const LONG_PRESS_MS = 600;
// 中秋灯笼素材（位于 public/images/）
const FESTIVAL_LANTERN_SRC = "/images/mid-autumn-lantern.svg";
const FESTIVAL_LANTERN_COUNT_DESKTOP = 24;
const FESTIVAL_LANTERN_COUNT_MOBILE = 14;
// 灯笼横向分布的总宽度（vw），留出左右边距
const FESTIVAL_SLOT_SPAN_VW = 96;
const FESTIVAL_BASE_GAP_MS = 180;
const FESTIVAL_GAP_JITTER_MS = 120;
const FESTIVAL_RISE_MIN_S = 9;
const FESTIVAL_RISE_JITTER_S = 3;
const FESTIVAL_CLEANUP_BUFFER_MS = 800;
// 中秋模式的提示文字
const MID_AUTUMN_MESSAGES = [
	"🌕 中秋快乐，人月两团圆",
	"但愿人长久，千里共婵娟",
	"🥮 月饼管够，好运连连",
	"🏮 灯笼升起来啦，愿望都算数",
];
// 新年模式的提示文字
const NEW_YEAR_MESSAGES = [
	"🎆 新年快乐，万事顺遂",
	"🏮 灯笼挂好啦，好运一整年",
	"🧧 恭喜发财，红包拿来",
	"🎊 新的一年，越过越顺",
];
// 国庆模式的提示文字
const NATIONAL_DAY_MESSAGES = [
	"🎉 国庆快乐，假期愉快",
	"🌼 花朵飘落，祝福满满",
	"🎊 吃好玩好，万事顺遂",
	"✨ 山河明媚，好运连连",
];

/* ---------------- 国庆模式参数 ---------------- */
// 花朵素材（位于 public/images/）
const NATIONAL_DAY_FLOWERS = [
	"/images/national-day-flower-yellow.svg",
	"/images/national-day-flower-orange.svg",
];
const NATIONAL_DAY_FLOWER_COUNT_DESKTOP = 30;
const NATIONAL_DAY_FLOWER_COUNT_MOBILE = 18;
// 横向槽位数量：每轮洗牌后依次占用，保证分布均匀
const NATIONAL_DAY_SLOT_COUNT = 16;
const NATIONAL_DAY_SPAWN_MIN_MS = 40;
const NATIONAL_DAY_SPAWN_JITTER_MS = 50;
const NATIONAL_DAY_FALL_MIN_S = 4;
const NATIONAL_DAY_FALL_JITTER_S = 2;
const NATIONAL_DAY_SWAY_MIN_PX = 12;
const NATIONAL_DAY_SWAY_JITTER_PX = 20;
const NATIONAL_DAY_ROCK_MIN_S = 0.55;
const NATIONAL_DAY_ROCK_JITTER_S = 0.35;

/* ---------------- 看板娘台词 ---------------- */
// 触发节日效果时看板娘说的话（看板娘只在桌面端加载，没加载成功时静默跳过）
// 带日期的台词只在她「今天真的是这个节日」时才说：
//   中秋 = 农历八月十五、春节 = 农历正月初一、国庆 = 10月1日
const WAIFU_MESSAGE_DURATION_MS = 5000;
const WAIFU_SLEEP_STORAGE_KEY = "Sleepy";

// 农历月日：用运行环境内置的农历日历算，不引第三方库
function getLunarDate(now: Date): { month: number; day: number } | null {
	try {
		const parts = new Intl.DateTimeFormat("en-u-ca-chinese", {
			month: "numeric",
			day: "numeric",
		}).formatToParts(now);
		const month = Number(parts.find((part) => part.type === "month")?.value);
		const day = Number(parts.find((part) => part.type === "day")?.value);
		if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
		return { month, day };
	} catch {
		return null;
	}
}

// 今天是不是农历某月某日（如八月十五）
function isLunarFestivalDay(now: Date, month: number, day: number): boolean {
	const lunar = getLunarDate(now);
	return lunar !== null && lunar.month === month && lunar.day === day;
}

// 今天是不是公历某月某日（如 10 月 1 日）
function isSolarDay(now: Date, month: number, day: number): boolean {
	return now.getMonth() + 1 === month && now.getDate() === day;
}

type WaifuFestivalLines = {
	/** 今天是不是这个节日的真实日子 */
	isFestivalDay: (now: Date) => boolean;
	/** 只有节日本身那天才说的日期台词，{date} 会替换成今天的真实日期 */
	dateLine: string;
	sleepyDateLine: string;
	awake: string[];
	sleepy: string[];
};
const WAIFU_FESTIVAL_LINES: Record<
	Exclude<FestivalMode, "none">,
	WaifuFestivalLines
> = {
	"mid-autumn": {
		isFestivalDay: (now) => isLunarFestivalDay(now, 8, 15),
		dateLine: "今天是{date}，<span>中秋节</span>哦~有没有吃月饼或者看看月亮呀?",
		sleepyDateLine:
			"唔……今天{date}呀……<span>中秋节</span>……（打哈欠）月亮好圆……",
		awake: [
			"🌕 <span>中秋快乐</span>~今晚的月亮好圆，记得吃月饼哦！",
			"灯笼都升起来啦，要不要一起<span>赏月</span>呀~",
			"月饼你爱吃甜的还是咸的?我两个都要！",
			"月圆人团圆，今天记得跟家里人说说话呀~",
			"听说今晚的月亮最圆，快抬头看看呀~",
		],
		sleepy: [
			"唔……（打哈欠）让我……再吃一口月饼……",
			"呼……灯笼都飘到我梦里了……月亮也在梦里……",
			"（梦话）五仁月饼……也不是不能吃啦……",
		],
	},
	"new-year": {
		isFestivalDay: (now) => isLunarFestivalDay(now, 1, 1),
		dateLine: "今天是{date}，<span>春节</span>哦~ 新年快乐，红包拿来呀！",
		sleepyDateLine: "唔……今天{date}呀……<span>春节</span>……（打哈欠）红包……",
		awake: [
			"🏮 <span>新年快乐</span>~新的一年也要开开心心的哦！",
			"灯笼挂好啦，快许个<span>新年愿望</span>吧~",
			"过年吃饺子还是汤圆?我都想要~",
			"新的一年，希望你事事顺遂、少熬夜呀！",
			"今天要走亲戚还是在家躺着?我猜是躺着~",
		],
		sleepy: [
			"唔……（打哈欠）红包……再给我一个嘛……",
			"呼……守岁就交给你啦……我先眯一会儿……",
			"（梦话）鞭炮……好吵……可是好热闹……",
		],
	},
	"national-day": {
		isFestivalDay: (now) => isSolarDay(now, 10, 1),
		dateLine: "今天是{date}，<span>国庆节</span>哦~假期要好好休息呀！",
		sleepyDateLine: "唔……今天{date}呀……<span>国庆节</span>……（打哈欠）假期……",
		awake: [
			"🌼 <span>国庆快乐</span>~假期要好好休息哦！",
			"花朵都飘下来啦，祝你<span>玩得开心</span>~",
			"假期计划好去哪里玩了吗?人多的地方要小心呀~",
			"出去走走也好，宅在家里也好，开心最重要呀~",
			"别忘了给家里打个电话，顺便报告一下行程~",
		],
		sleepy: [
			"唔……（打哈欠）假期……就是要睡觉呀……",
			"呼……再睡五分钟……假期还长着呢……",
			"（梦话）别叫我……景点人太多了……",
		],
	},
};

/* ---------------- 原彩蛋模式参数 ---------------- */
const MIN_VISIBLE_PIXELS = 32;
const CONTROL_MARGIN_PX = 2;
const LEGACY_CONTROL_MARGIN_PX = 10;
const POSITION_DEFAULT_EPSILON_PX = 2;
const LANTERN_POSITION_KEY_PREFIX = "lanternPositionV2";
const MAX_DODGE_ATTEMPTS = 5;
const DODGE_TOAST_MESSAGES = [
	"不要点啦",
	"再戳我就躲远一点啦",
	"你再点我就彻底消失啦",
];

/* ---------------- 通用参数 ---------------- */
const TOAST_DURATION_MS = 1300;
const TOAST_MIN_MARGIN_PX = 8;
const TOAST_GAP_PX = 10;
const TOAST_ESTIMATED_WIDTH = 220;
const TOAST_ESTIMATED_HEIGHT = 42;

// 新年灯笼（默认关闭，保持原样）
let isEnabled = false;

// 中秋模式状态
let tearing = false;
let torn = false;
let restoring = false;
let tearTimer: ReturnType<typeof setTimeout> | null = null;
let longPressTimer: ReturnType<typeof setTimeout> | null = null;
let longPressTriggered = false;
let festivalLanterns: FestivalLantern[] = [];
let festivalFlowers: FestivalFlower[] = [];
let festivalTimer: ReturnType<typeof setTimeout> | null = null;
let festivalMessageCursor = 0;
let festivalLanternSeed = 0;
let festivalFlowerSeed = 0;

// 原彩蛋模式状态
let offsetX = 0;
let offsetY = 0;
let currentDeviceKey = "";
let controlHidden = false;
let dodgeAttempts = 0;
let controlPositionReady = false;

// 提示气泡（两种模式共用）
let lanternToastVisible = false;
let lanternToastMessage = "";
let lanternToastTimeout: ReturnType<typeof setTimeout> | null = null;
let lanternToastX = 14;
let lanternToastY = 64;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function randomBetween(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

function isLocalStorageAvailable() {
	try {
		return (
			typeof window !== "undefined" &&
			typeof window.localStorage !== "undefined"
		);
	} catch {
		return false;
	}
}

function isMobileDevice() {
	return typeof window !== "undefined" && window.innerWidth <= 768;
}

// 清理旧版本留下的键值，避免老访客被历史状态影响
function cleanupLegacyState() {
	if (!isLocalStorageAvailable()) return;
	localStorage.removeItem(LEGACY_LANTERN_ENABLED_KEY);
	localStorage.removeItem(LEGACY_LANTERN_CONTROL_HIDDEN_KEY);
	localStorage.removeItem(LEGACY_LANTERN_DODGE_ATTEMPTS_KEY);
	if (festivalMode !== "none") {
		// 节日模式下按钮固定在右下角，旧的位置记录不再需要
		for (const key of LEGACY_LANTERN_POSITION_KEYS) {
			localStorage.removeItem(key);
		}
	}
}

function getToggleRect() {
	if (typeof document === "undefined") return null;
	const toggle = document.querySelector(
		".lantern-toggle-container",
	) as HTMLElement | null;
	return toggle?.getBoundingClientRect() ?? null;
}

function updateLanternToastPosition() {
	if (typeof window === "undefined") return;
	const toastEl = document.querySelector(
		".lantern-toast",
	) as HTMLElement | null;
	const toastWidth = toastEl?.offsetWidth || TOAST_ESTIMATED_WIDTH;
	const toastHeight = toastEl?.offsetHeight || TOAST_ESTIMATED_HEIGHT;
	const minX = TOAST_MIN_MARGIN_PX;
	const maxX = window.innerWidth - toastWidth - TOAST_MIN_MARGIN_PX;
	const minY = TOAST_MIN_MARGIN_PX;
	const maxY = window.innerHeight - toastHeight - TOAST_MIN_MARGIN_PX;

	const rect = getToggleRect();
	const anchorX = rect ? rect.left : maxX;
	const anchorY = rect ? rect.top : window.innerHeight;

	// 优先放在按钮上方；上方空间不够就放到按钮下方
	let y = anchorY - toastHeight - TOAST_GAP_PX;
	if (y < minY) {
		y = (rect ? rect.bottom : anchorY) + TOAST_GAP_PX;
	}

	// 与按钮左对齐，超出视口再收缩
	let x = anchorX;
	if (x > maxX) {
		x = maxX;
	}
	if (x < minX) {
		x = minX;
	}

	lanternToastX = Math.round(clamp(x, minX, maxX));
	lanternToastY = Math.round(clamp(y, minY, maxY));
}

function showLanternToast(message: string) {
	lanternToastMessage = message;
	lanternToastVisible = true;
	updateLanternToastPosition();
	requestAnimationFrame(() => {
		updateLanternToastPosition();
	});
	if (lanternToastTimeout) {
		clearTimeout(lanternToastTimeout);
	}
	lanternToastTimeout = setTimeout(() => {
		lanternToastVisible = false;
		lanternToastTimeout = null;
	}, TOAST_DURATION_MS);
}

/* ==================================================================
 * 中秋模式：撕纸 → 中秋按钮 → 灯笼雨 → 长按贴回
 * ================================================================== */

// 生成一轮中秋灯笼：横向打乱槽位均匀分布，纵向依次错开升起
function buildFestivalRound() {
	const count = isMobileDevice()
		? FESTIVAL_LANTERN_COUNT_MOBILE
		: FESTIVAL_LANTERN_COUNT_DESKTOP;
	const slotWidth = FESTIVAL_SLOT_SPAN_VW / count;
	const slots = Array.from({ length: count }, (_, index) => index);

	for (let i = slots.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[slots[i], slots[j]] = [slots[j], slots[i]];
	}

	const items: FestivalLantern[] = [];
	let delay = 0;
	for (let i = 0; i < count; i += 1) {
		delay += randomBetween(
			FESTIVAL_BASE_GAP_MS,
			FESTIVAL_BASE_GAP_MS + FESTIVAL_GAP_JITTER_MS,
		);
		festivalLanternSeed += 1;
		items.push({
			id: festivalLanternSeed,
			left: `${((slots[i] + 0.25 + Math.random() * 0.5) * slotWidth).toFixed(2)}vw`,
			duration: `${randomBetween(
				FESTIVAL_RISE_MIN_S,
				FESTIVAL_RISE_MIN_S + FESTIVAL_RISE_JITTER_S,
			).toFixed(2)}s`,
			delay: `${Math.round(delay)}ms`,
		});
	}

	const maxDurationMs = (FESTIVAL_RISE_MIN_S + FESTIVAL_RISE_JITTER_S) * 1000;
	const totalMs = delay + maxDurationMs + FESTIVAL_CLEANUP_BUFFER_MS;

	return { items, totalMs };
}

function getFestivalMessages() {
	if (festivalMode === "new-year") return NEW_YEAR_MESSAGES;
	if (festivalMode === "national-day") return NATIONAL_DAY_MESSAGES;
	return MID_AUTUMN_MESSAGES;
}

function pickFestivalMessage() {
	const messages = getFestivalMessages();
	const message = messages[festivalMessageCursor % messages.length];
	festivalMessageCursor += 1;
	return message;
}

// 中秋效果：放飞一轮从页面底部升起的灯笼
function triggerMidAutumnLanterns() {
	const { items, totalMs } = buildFestivalRound();
	festivalLanterns = items;

	if (festivalTimer) {
		clearTimeout(festivalTimer);
	}
	festivalTimer = setTimeout(() => {
		festivalLanterns = [];
		festivalTimer = null;
	}, totalMs);

	showLanternToast(pickFestivalMessage());
}

// 新年效果：挂出顶部的 4 个新年灯笼
function triggerNewYearLanterns() {
	isEnabled = true;
	showLanternToast(pickFestivalMessage());
}

// 洗牌：返回 0..length-1 的乱序数组
function buildShuffledQueue(length: number): number[] {
	const queue = Array.from({ length }, (_, index) => index);
	for (let i = queue.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		[queue[i], queue[j]] = [queue[j], queue[i]];
	}
	return queue;
}

// 生成一轮国庆花朵：素材与横向槽位都洗牌后依次取用，保证数量均衡、分布均匀
function buildNationalDayRound() {
	const count = isMobileDevice()
		? NATIONAL_DAY_FLOWER_COUNT_MOBILE
		: NATIONAL_DAY_FLOWER_COUNT_DESKTOP;
	const assetQueue = buildShuffledQueue(NATIONAL_DAY_FLOWERS.length);
	const slotQueue = buildShuffledQueue(NATIONAL_DAY_SLOT_COUNT);

	const items: FestivalFlower[] = [];
	let delay = 0;
	for (let i = 0; i < count; i += 1) {
		delay += randomBetween(
			NATIONAL_DAY_SPAWN_MIN_MS,
			NATIONAL_DAY_SPAWN_MIN_MS + NATIONAL_DAY_SPAWN_JITTER_MS,
		);
		if (assetQueue.length === 0) {
			assetQueue.push(...buildShuffledQueue(NATIONAL_DAY_FLOWERS.length));
		}
		if (slotQueue.length === 0) {
			slotQueue.push(...buildShuffledQueue(NATIONAL_DAY_SLOT_COUNT));
		}
		const assetIndex = assetQueue.pop() ?? 0;
		const slot = slotQueue.pop() ?? 0;
		const swayDirection = Math.random() < 0.5 ? -1 : 1;

		festivalFlowerSeed += 1;
		items.push({
			id: festivalFlowerSeed,
			src: NATIONAL_DAY_FLOWERS[assetIndex],
			left: `${(((slot + 0.2 + Math.random() * 0.6) / NATIONAL_DAY_SLOT_COUNT) * 96).toFixed(2)}vw`,
			duration: `${randomBetween(
				NATIONAL_DAY_FALL_MIN_S,
				NATIONAL_DAY_FALL_MIN_S + NATIONAL_DAY_FALL_JITTER_S,
			).toFixed(2)}s`,
			delay: `${Math.round(delay)}ms`,
			sway: `${Math.round(
				swayDirection *
					randomBetween(
						NATIONAL_DAY_SWAY_MIN_PX,
						NATIONAL_DAY_SWAY_MIN_PX + NATIONAL_DAY_SWAY_JITTER_PX,
					),
			)}px`,
			rockTime: `${randomBetween(
				NATIONAL_DAY_ROCK_MIN_S,
				NATIONAL_DAY_ROCK_MIN_S + NATIONAL_DAY_ROCK_JITTER_S,
			).toFixed(2)}s`,
		});
	}

	const maxFallMs =
		(NATIONAL_DAY_FALL_MIN_S + NATIONAL_DAY_FALL_JITTER_S) * 1000;
	const totalMs = delay + maxFallMs + FESTIVAL_CLEANUP_BUFFER_MS;

	return { items, totalMs };
}

// 国庆效果：从顶部落下一轮花朵（边落边左右摇晃）
function triggerNationalDayFlowers() {
	const { items, totalMs } = buildNationalDayRound();
	festivalFlowers = items;

	if (festivalTimer) {
		clearTimeout(festivalTimer);
	}
	festivalTimer = setTimeout(() => {
		festivalFlowers = [];
		festivalTimer = null;
	}, totalMs);

	showLanternToast(pickFestivalMessage());
}

// 看板娘是不是睡着了（睡觉状态由 Layout 的 Live2D 逻辑写在 sessionStorage）
function isWaifuSleeping(): boolean {
	if (typeof window === "undefined") return false;
	try {
		return sessionStorage.getItem(WAIFU_SLEEP_STORAGE_KEY) === "1";
	} catch {
		return false;
	}
}

// 今天的日期，如「9月25日」
function getTodayLabel(): string {
	const today = new Date();
	return `${today.getMonth() + 1}月${today.getDate()}日`;
}

// 当前节日该说的台词：今天真是这个节日才加带日期那句，其余时候说普通（或瞌睡）台词
function buildFestivalWaifuLines(sleeping: boolean): string[] {
	if (festivalMode === "none") return [];
	const lines = WAIFU_FESTIVAL_LINES[festivalMode];
	if (!lines) return [];
	const baseLines = sleeping ? lines.sleepy : lines.awake;
	if (!lines.isFestivalDay(new Date())) {
		return [...baseLines];
	}
	const dateTemplate = sleeping ? lines.sleepyDateLine : lines.dateLine;
	return [dateTemplate.replace("{date}", getTodayLabel()), ...baseLines];
}

// 睡觉时的节日台词要登记给 Layout，避免被通用的睡觉文案替换掉
function rememberSleepingWaifuLine(line: string) {
	if (typeof window === "undefined") return;
	const registered = window.__extraSleepingWaifuMessages;
	if (Array.isArray(registered)) {
		if (!registered.includes(line)) {
			registered.push(line);
		}
		return;
	}
	window.__extraSleepingWaifuMessages = [line];
}

// 让看板娘说一句当前节日的台词（她睡着时说的是瞌睡版本）
function speakFestivalWaifuMessage() {
	if (typeof window === "undefined" || festivalMode === "none") return;
	const sleeping = isWaifuSleeping();
	const lines = buildFestivalWaifuLines(sleeping);
	if (lines.length === 0) return;

	const line = lines[Math.floor(Math.random() * lines.length)];
	if (sleeping) {
		rememberSleepingWaifuLine(line);
	}

	const speak = (): boolean => {
		const show = window.showWaifuMessage;
		if (typeof show !== "function") return false;
		show(line, WAIFU_MESSAGE_DURATION_MS);
		return true;
	};

	if (speak()) return;

	// 看板娘可能还没加载完（移动端不加载），稍后重试几次
	let attempts = 0;
	const timer = window.setInterval(() => {
		attempts += 1;
		if (speak() || attempts >= 6) {
			window.clearInterval(timer);
		}
	}, 600);
}

// 点击节日按钮：按当前开启的节日触发对应效果
function triggerFestival() {
	speakFestivalWaifuMessage();

	if (festivalMode === "new-year") {
		triggerNewYearLanterns();
		return;
	}
	if (festivalMode === "national-day") {
		triggerNationalDayFlowers();
		return;
	}
	triggerMidAutumnLanterns();
}

// 纸片被撕开后才露出的节日按钮文案
function getFestivalButtonLabel() {
	if (festivalMode === "new-year") return "🏮 新年快乐";
	if (festivalMode === "national-day") return "🌼 国庆快乐";
	return "🌕 中秋快乐";
}

function getTornAriaLabel() {
	if (festivalMode === "new-year") return "点击挂起新年灯笼，长按把纸贴回来";
	if (festivalMode === "national-day")
		return "点击撒下国庆花朵，长按把纸贴回来";
	return "点击放飞中秋灯笼，长按把纸贴回来";
}

// 撕掉"灯笼已关"这层纸，露出中秋按钮
function revealToggle() {
	if (torn || tearing || restoring) return;
	tearing = true;
	if (tearTimer) {
		clearTimeout(tearTimer);
	}
	tearTimer = setTimeout(() => {
		tearing = false;
		torn = true;
		tearTimer = null;
	}, TEAR_DURATION_MS);
}

// 长按：反向播放撕纸动画，把纸片贴回原位（恢复成"灯笼已关"），并收起节日效果
function restoreToggle() {
	if (!torn || restoring) return;
	restoring = true;
	// 新年模式：把已经挂上的灯笼一起收回去
	if (festivalMode === "new-year") {
		isEnabled = false;
	}
	if (tearTimer) {
		clearTimeout(tearTimer);
	}
	tearTimer = setTimeout(() => {
		restoring = false;
		torn = false;
		tearTimer = null;
	}, TEAR_DURATION_MS);
}

function cancelLongPress() {
	if (longPressTimer) {
		clearTimeout(longPressTimer);
		longPressTimer = null;
	}
}

function handleTogglePressStart() {
	cancelLongPress();
	longPressTriggered = false;
	longPressTimer = setTimeout(() => {
		longPressTimer = null;
		if (!torn || restoring) return;
		longPressTriggered = true;
		restoreToggle();
	}, LONG_PRESS_MS);
}

function handleTogglePressEnd() {
	cancelLongPress();
}

function handleToggleMouseEnter() {
	revealToggle();
}

function handleToggleTouchStart() {
	revealToggle();
	handleTogglePressStart();
}

function handleToggleClick() {
	// 长按恢复时不再触发中秋效果
	if (longPressTriggered) {
		longPressTriggered = false;
		return;
	}
	// 纸还没撕掉（或正在贴回去）时先不触发效果
	if (!torn || restoring) return;
	triggerFestival();
}

/* ==================================================================
 * 原彩蛋模式：躲开点击 + 连点 5 次消失（隐藏状态只在本页有效）
 * ================================================================== */

function getToggleElements() {
	const control = document.querySelector(
		".lantern-control--prank",
	) as HTMLElement | null;
	const toggle = document.querySelector(
		".lantern-toggle-container--prank",
	) as HTMLElement | null;
	return { control, toggle };
}

function getToggleSize() {
	const { toggle } = getToggleElements();
	const rect = toggle?.getBoundingClientRect();
	return {
		width: rect?.width || 140,
		height: rect?.height || 44,
	};
}

function getMovementBounds() {
	if (typeof window === "undefined") {
		return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
	}
	const { width, height } = getToggleSize();
	return {
		minX: -(width - MIN_VISIBLE_PIXELS),
		maxX: window.innerWidth - MIN_VISIBLE_PIXELS,
		minY: -(height - MIN_VISIBLE_PIXELS),
		maxY: window.innerHeight - MIN_VISIBLE_PIXELS,
	};
}

function getDefaultTogglePosition(marginPx = CONTROL_MARGIN_PX) {
	if (typeof window === "undefined") return { x: 0, y: 0 };
	const { width, height } = getToggleSize();
	return {
		x: window.innerWidth - marginPx - width,
		y: window.innerHeight - marginPx - height,
	};
}

function getDeviceStorageKey() {
	const deviceKey = isMobileDevice() ? "mobile" : "desktop";
	currentDeviceKey = deviceKey;
	return deviceKey;
}

function loadLanternPosition() {
	const defaults = getDefaultTogglePosition();
	if (!isLocalStorageAvailable()) {
		offsetX = defaults.x;
		offsetY = defaults.y;
		return;
	}
	const deviceKey = getDeviceStorageKey();
	const savedPosition = localStorage.getItem(
		`${LANTERN_POSITION_KEY_PREFIX}_${deviceKey}`,
	);
	if (savedPosition === null) {
		offsetX = defaults.x;
		offsetY = defaults.y;
		return;
	}
	try {
		const position = JSON.parse(savedPosition);
		const x = Number(position?.x);
		const y = Number(position?.y);
		if (!Number.isFinite(x) || !Number.isFinite(y)) {
			offsetX = defaults.x;
			offsetY = defaults.y;
			return;
		}
		const legacyDefaults = getDefaultTogglePosition(LEGACY_CONTROL_MARGIN_PX);
		const wasLegacyDefault =
			Math.abs(x - legacyDefaults.x) <= POSITION_DEFAULT_EPSILON_PX &&
			Math.abs(y - legacyDefaults.y) <= POSITION_DEFAULT_EPSILON_PX;
		if (wasLegacyDefault) {
			offsetX = defaults.x;
			offsetY = defaults.y;
			return;
		}
		offsetX = x;
		offsetY = y;
	} catch {
		offsetX = defaults.x;
		offsetY = defaults.y;
	}
}

function saveLanternPosition() {
	if (!isLocalStorageAvailable()) return;
	const deviceKey = getDeviceStorageKey();
	localStorage.setItem(
		`${LANTERN_POSITION_KEY_PREFIX}_${deviceKey}`,
		JSON.stringify({ x: offsetX, y: offsetY }),
	);
}

function clampOffsetToViewport() {
	if (typeof window === "undefined") return;
	const { minX, maxX, minY, maxY } = getMovementBounds();
	offsetX = clamp(offsetX, minX, maxX);
	offsetY = clamp(offsetY, minY, maxY);
}

function dodgeToggleFromPoint() {
	if (typeof window === "undefined") return;
	const { minX, maxX, minY, maxY } = getMovementBounds();
	const minJumpDistance = isMobileDevice() ? 180 : 240;
	let targetX = offsetX;
	let targetY = offsetY;

	for (let i = 0; i < 8; i += 1) {
		const candidateX = randomBetween(minX, maxX);
		const candidateY = randomBetween(minY, maxY);
		const jumpDistance = Math.hypot(candidateX - offsetX, candidateY - offsetY);
		targetX = candidateX;
		targetY = candidateY;
		if (jumpDistance >= minJumpDistance) {
			break;
		}
	}

	offsetX = targetX;
	offsetY = targetY;
	clampOffsetToViewport();
	saveLanternPosition();
}

function hideControl() {
	controlHidden = true;
}

function resetControlState() {
	// 按需求：连点消失只在本页有效，刷新 / 重开页面按钮会重新出现
	controlHidden = false;
	dodgeAttempts = 0;
}

function handleToggleAttempt() {
	if (controlHidden) return;
	dodgeAttempts += 1;
	const message =
		DODGE_TOAST_MESSAGES[(dodgeAttempts - 1) % DODGE_TOAST_MESSAGES.length];

	if (dodgeAttempts >= MAX_DODGE_ATTEMPTS) {
		hideControl();
		showLanternToast("不陪你玩啦 我先藏好啦");
		return;
	}

	dodgeToggleFromPoint();
	showLanternToast(message);
}

function handleToggleMouseDown() {
	handleToggleAttempt();
}

function handleToggleTouchStartPrank() {
	handleToggleAttempt();
}

/* ==================================================================
 * 公共：节日模式切换 / 窗口尺寸变化
 * ================================================================== */

// 切换节日时清掉上一个节日残留的动画与灯笼，避免状态串台
function resetFestivalState() {
	tearing = false;
	torn = false;
	restoring = false;
	festivalLanterns = [];
	festivalFlowers = [];
	isEnabled = false;
	if (tearTimer) {
		clearTimeout(tearTimer);
		tearTimer = null;
	}
	if (longPressTimer) {
		clearTimeout(longPressTimer);
		longPressTimer = null;
	}
	if (festivalTimer) {
		clearTimeout(festivalTimer);
		festivalTimer = null;
	}
}

// 原彩蛋模式的初始化（位置记忆 + 显示按钮）
function initControlPosition() {
	resetControlState();
	currentDeviceKey = getDeviceStorageKey();
	loadLanternPosition();
	clampOffsetToViewport();
	controlPositionReady = true;

	requestAnimationFrame(() => {
		clampOffsetToViewport();
		saveLanternPosition();
	});
}

/**
 * 计算当前该用哪种节日模式：构建期配置优先被「本机即时预览」覆盖
 */
function applyFestivalMode() {
	const next = resolveFestivalMode(resolveFestivalFlags(BUILD_FESTIVAL_FLAGS));
	if (next === festivalMode) return;
	resetFestivalState();
	festivalMode = next;
	if (next === "none") {
		initControlPosition();
	}
}

function handleResize() {
	if (festivalMode === "none") {
		const newDeviceKey = isMobileDevice() ? "mobile" : "desktop";
		if (newDeviceKey !== currentDeviceKey) {
			currentDeviceKey = newDeviceKey;
			loadLanternPosition();
		}
		clampOffsetToViewport();
		saveLanternPosition();
	}
	if (lanternToastVisible) {
		updateLanternToastPosition();
	}
}

onMount(() => {
	cleanupLegacyState();
	applyFestivalMode();

	if (festivalMode === "none") {
		initControlPosition();
	}

	// 控制台保存后广播事件，这里立刻切到新效果
	window.addEventListener(FESTIVAL_SETTINGS_CHANGE_EVENT, applyFestivalMode);
	window.addEventListener("resize", handleResize);

	return () => {
		window.removeEventListener(
			FESTIVAL_SETTINGS_CHANGE_EVENT,
			applyFestivalMode,
		);
		window.removeEventListener("resize", handleResize);
		if (lanternToastTimeout) {
			clearTimeout(lanternToastTimeout);
			lanternToastTimeout = null;
		}
		if (tearTimer) {
			clearTimeout(tearTimer);
			tearTimer = null;
		}
		if (longPressTimer) {
			clearTimeout(longPressTimer);
			longPressTimer = null;
		}
		if (festivalTimer) {
			clearTimeout(festivalTimer);
			festivalTimer = null;
		}
	};
});
</script>

{#if isEnabled}
	<div
		class="lantern-container"
		transition:fade={{ duration: 350, easing: cubicOut }}
	>
		<div class="lantern-item pos-1">
			<div class="lantern-line"></div>
			<div class="lantern-body">
				<div class="lantern-cap cap-top"></div>
				<div class="lantern-body-inner"></div>
				<span class="lantern-text">新</span>
				<div class="lantern-cap cap-bottom"></div>
			</div>
			<div class="lantern-tassel"></div>
		</div>

		<div class="lantern-item pos-2">
			<div class="lantern-line"></div>
			<div class="lantern-body">
				<div class="lantern-cap cap-top"></div>
				<div class="lantern-body-inner"></div>
				<span class="lantern-text">年</span>
				<div class="lantern-cap cap-bottom"></div>
			</div>
			<div class="lantern-tassel"></div>
		</div>

		<div class="lantern-item pos-3">
			<div class="lantern-line"></div>
			<div class="lantern-body">
				<div class="lantern-cap cap-top"></div>
				<div class="lantern-body-inner"></div>
				<span class="lantern-text">快</span>
				<div class="lantern-cap cap-bottom"></div>
			</div>
			<div class="lantern-tassel"></div>
		</div>

		<div class="lantern-item pos-4">
			<div class="lantern-line"></div>
			<div class="lantern-body">
				<div class="lantern-cap cap-top"></div>
				<div class="lantern-body-inner"></div>
				<span class="lantern-text">乐</span>
				<div class="lantern-cap cap-bottom"></div>
			</div>
			<div class="lantern-tassel"></div>
		</div>
	</div>
{/if}

{#if festivalMode !== "none"}
	<!-- 节日模式：默认是写着"灯笼已关"的纸片，移上去撕开露出节日按钮 -->
	<div class="lantern-control lantern-control--festival">
		<div class="lantern-toggle-container">
			<button
				type="button"
				class="lantern-toggle lantern-toggle--festival"
				on:mouseenter={handleToggleMouseEnter}
				on:focus={revealToggle}
				on:mousedown={handleTogglePressStart}
				on:mouseup={handleTogglePressEnd}
				on:mouseleave={handleTogglePressEnd}
				on:touchstart={handleToggleTouchStart}
				on:touchend={handleTogglePressEnd}
				on:touchcancel={handleTogglePressEnd}
				on:click={handleToggleClick}
				aria-label={torn
					? getTornAriaLabel()
					: "灯笼已关，把鼠标移上来看看"}
			>
				<span class="lantern-toggle-festival" aria-hidden="true"
					>{getFestivalButtonLabel()}</span
				>

				{#if !torn || restoring}
					<span
						class="paper paper-left"
						class:is-tearing={tearing}
						class:is-restoring={restoring}
						aria-hidden="true"
					>
						<span class="paper-face">🏮 灯笼已关</span>
					</span>
					<span
						class="paper paper-right"
						class:is-tearing={tearing}
						class:is-restoring={restoring}
						aria-hidden="true"
					>
						<span class="paper-face">🏮 灯笼已关</span>
					</span>
				{/if}
			</button>
		</div>
	</div>

	<!-- 中秋灯笼雨（只有中秋模式才有） -->
	{#if festivalMode === "mid-autumn" && festivalLanterns.length}
		<div class="festival-layer" aria-hidden="true">
			{#each festivalLanterns as lantern (lantern.id)}
				<img
					class="festival-lantern"
					src={FESTIVAL_LANTERN_SRC}
					alt=""
					style={`left: ${lantern.left}; --rise-time: ${lantern.duration}; animation-delay: ${lantern.delay};`}
				/>
			{/each}
		</div>
	{/if}

	<!-- 国庆花朵飘落（只有国庆模式才有） -->
	{#if festivalMode === "national-day" && festivalFlowers.length}
		<div class="festival-layer" aria-hidden="true">
			{#each festivalFlowers as flower (flower.id)}
				<div
					class="festival-flower"
					style={`left: ${flower.left}; --fall-time: ${flower.duration}; --sway: ${flower.sway}; animation-delay: ${flower.delay};`}
				>
					<img
						src={flower.src}
						alt=""
						style={`--rock-time: ${flower.rockTime};`}
					/>
				</div>
			{/each}
		</div>
	{/if}
{:else}
	<!-- 原彩蛋模式：会躲开点击的「灯笼已关」按钮 -->
	{#if !controlHidden && controlPositionReady}
		<div class="lantern-control lantern-control--prank">
			<div
				class="lantern-toggle-container lantern-toggle-container--prank"
				style={`transform: translate(${offsetX}px, ${offsetY}px);`}
				tabindex="0"
				role="button"
				aria-label="灯笼控制按钮 会躲开点击"
			>
				<button
					type="button"
					class="lantern-toggle lantern-toggle--prank"
					on:mousedown|preventDefault|stopPropagation={handleToggleMouseDown}
					on:touchstart|preventDefault|stopPropagation={handleToggleTouchStartPrank}
					aria-label="别点我 我会躲开"
				>
					🏮 灯笼已关
				</button>
			</div>
		</div>
	{/if}
{/if}

{#if lanternToastVisible}
	<div
		class="lantern-toast"
		style={`left: ${lanternToastX}px; top: ${lanternToastY}px;`}
		transition:fade={{ duration: 180, easing: cubicOut }}
	>
		{lanternToastMessage}
	</div>
{/if}

<style lang="css">
	/* 容器定位 */
	.lantern-container {
		position: fixed;
		top: -20px; /* 向上微调，露出挂绳 */
		width: 100%;
		display: flex;
		justify-content: space-between;
		padding: 0 50px;
		box-sizing: border-box;
		z-index: 9999;
		pointer-events: none;
	}

	.lantern-item {
		display: flex;
		flex-direction: column;
		align-items: center;
		animation: swing 3.5s infinite ease-in-out;
		transform-origin: top center;
	}

	/* 顶部吊绳 */
	.lantern-line {
		width: 3px;
		height: 50px;
		background-color: #dc8f03;
	}

	/* 灯笼主体：调整为更圆润的扁椭圆 */
	.lantern-body {
		width: 120px;
		height: 95px;
		background: #d32f2f; /* 更深一点的红 */
		border-radius: 50% / 45%;
		position: relative;
		/* 核心修改：多重阴影实现图片中的红色外发光效果 */
		box-shadow: 0 0 50px 15px rgba(255, 69, 0, 0.4);
		display: flex;
		justify-content: center;
		align-items: center;
		border: 2px solid #ffca28;
	}

	/* 灯笼纵向纹理：改为弧形 */
	.lantern-body::before {
		content: "";
		position: absolute;
		width: 70px;
		height: 100%;
		border-left: 2px solid #ffca28;
		border-right: 2px solid #ffca28;
		border-radius: 50%;
		opacity: 0.5;
	}

	/* 灯笼中间纵向纹理 */
	.lantern-body-inner {
		position: absolute;
		width: 30px;
		height: 100%;
		border-left: 2px solid #ffca28;
		border-right: 2px solid #ffca28;
		border-radius: 50%;
		opacity: 0.5;
	}

	/* 灯笼上下盖子 */
	.lantern-cap {
		width: 50px;
		height: 8px;
		background: #ffca28;
		border-radius: 4px;
		position: absolute;
		z-index: 10;
	}
	.cap-top { top: -4px; }
	.cap-bottom { bottom: -4px; }

	/* 文字样式：优化了字体族和光效 */
	.lantern-text {
		color: #ffca28;
		/* 优先使用华文行楷，其次是楷体，最后是通用的 serif 衬线体 */
		font-family: "STXingkai", "华文行楷", "KaiTi", "楷体", "STKaiti", "华文楷体", serif;
		font-size: 42px; /* 略微调大一点，更有视觉冲击力 */
		font-weight: bold;
		line-height: 1;
		text-align: center;
		/* 金色文字的微弱外发光，模拟灯火照亮文字的效果 */
		text-shadow:
			0 0 10px rgba(255, 202, 40, 0.8),
			1px 1px 3px rgba(0, 0, 0, 0.5);
		z-index: 20;
		user-select: none;
	}

	/* 底部流苏：加长并优化细节 */
	.lantern-tassel {
		width: 6px;
		height: 40px;
		background: #ffca28;
		position: relative;
		margin-top: 5px;
		border-radius: 0 0 3px 3px;
	}

	/* 摇摆动画 */
	@keyframes swing {
		0% { transform: rotate(-5deg); }
		50% { transform: rotate(5deg); }
		100% { transform: rotate(-5deg); }
	}

	/* 个别位置微调 */
	.pos-1 { margin-top: 10px; }
	.pos-2 { margin-top: 40px; }
	.pos-3 { margin-top: 40px; }
	.pos-4 { margin-top: 10px; }

	/* 控制开关容器（两种模式共用定位外壳） */
	.lantern-control {
		position: fixed;
		z-index: 10000;
		pointer-events: none;
	}

	/* 中秋模式：固定在右下角 */
	.lantern-control--festival {
		right: 2px;
		bottom: 2px;
	}

	/* 原彩蛋模式：左上角 + transform 位移 */
	.lantern-control--prank {
		top: 0;
		left: 0;
	}

	.lantern-toggle-container {
		pointer-events: auto;
	}

	/* 原彩蛋模式的移动过渡 */
	.lantern-toggle-container--prank {
		transition: transform 0.1s ease-out;
	}

	/* 按钮本体（两种模式共用的基础样式） */
	.lantern-toggle {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 8px 16px;
		border-radius: 20px;
		font-size: 14px;
		font-weight: bold;
		cursor: pointer;
		user-select: none;
	}

	/* 中秋模式的按钮（纸被撕掉后露出来的那个） */
	.lantern-toggle--festival {
		min-width: 8.6rem;
		border: 2px solid #ffca28;
		background-color: #8f1f1f;
		color: #ffe4ad;
		box-shadow:
			0 2px 8px rgba(0, 0, 0, 0.28),
			0 0 14px rgba(255, 180, 60, 0.28);
		transition:
			transform 0.25s ease,
			box-shadow 0.25s ease;
	}

	.lantern-toggle--festival:hover {
		transform: translateY(-2px);
		box-shadow:
			0 6px 16px rgba(0, 0, 0, 0.32),
			0 0 22px rgba(255, 180, 60, 0.5);
	}

	.lantern-toggle--festival:active {
		transform: translateY(0);
	}

	.lantern-toggle--festival:focus-visible {
		outline: 2px solid #ffca28;
		outline-offset: 2px;
	}

	.lantern-toggle-festival {
		display: inline-flex;
		align-items: center;
		white-space: nowrap;
		letter-spacing: 0.05em;
		text-shadow: 0 0 10px rgba(255, 202, 40, 0.55);
	}

	/* 原彩蛋模式的按钮（原本的金色药丸样式） */
	.lantern-toggle--prank {
		background-color: rgba(255, 202, 40, 0.9);
		color: #d32f2f;
		border: 2px solid #d32f2f;
		transition: all 0.3s ease;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
	}

	.lantern-toggle--prank:hover {
		background-color: rgba(255, 202, 40, 1);
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
	}

	.lantern-toggle--prank:active {
		transform: translateY(0);
	}

	/* 盖在按钮上的那张纸（默认显示"灯笼已关"） */
	.paper {
		position: absolute;
		inset: -2px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 2px solid #d32f2f;
		border-radius: 20px;
		background-color: rgba(255, 202, 40, 0.95);
		color: #d32f2f;
		font-size: 14px;
		font-weight: bold;
		white-space: nowrap;
		pointer-events: none;
		will-change: transform, opacity;
	}

	.paper-face {
		display: inline-flex;
		align-items: center;
	}

	/* 撕开/贴回时的锯齿裂口（外缘仍保留纸片的圆角） */
	.paper-left:is(.is-tearing, .is-restoring) {
		clip-path: polygon(
			13.4% 0,
			52% 0,
			45% 8%, 54% 16%, 44% 25%, 53% 34%, 45% 43%, 54% 52%,
			45% 61%, 53% 70%, 44% 79%, 53% 88%, 46% 100%,
			13.4% 100%,
			3.9% 85.4%, 0 50%, 3.9% 14.6%
		);
		filter: drop-shadow(2px 0 3px rgba(0, 0, 0, 0.2));
	}

	.paper-right:is(.is-tearing, .is-restoring) {
		clip-path: polygon(
			52% 0,
			86.6% 0,
			96.1% 14.6%, 100% 50%, 96.1% 85.4%,
			86.6% 100%,
			46% 100%,
			53% 88%, 44% 79%, 53% 70%, 45% 61%, 54% 52%,
			45% 43%, 53% 34%, 44% 25%, 54% 16%, 45% 8%
		);
		filter: drop-shadow(-2px 0 3px rgba(0, 0, 0, 0.2));
	}

	/* 撕开：两半纸片分离飞走 */
	.paper-left.is-tearing {
		animation: tear-left 0.62s cubic-bezier(0.34, 0.8, 0.4, 1) forwards;
	}

	.paper-right.is-tearing {
		animation: tear-right 0.62s cubic-bezier(0.34, 0.8, 0.4, 1) forwards;
	}

	/* 贴回：倒放同一段动画 */
	.paper-left.is-restoring {
		animation: tear-left 0.62s cubic-bezier(0.34, 0.8, 0.4, 1) reverse forwards;
	}

	.paper-right.is-restoring {
		animation: tear-right 0.62s cubic-bezier(0.34, 0.8, 0.4, 1) reverse forwards;
	}

	@keyframes tear-left {
		0% {
			transform: translate(0, 0) rotate(0deg) scale(1);
			opacity: 1;
		}
		100% {
			transform: translate(-22px, 10px) rotate(-18deg) scale(1.04);
			opacity: 0;
		}
	}

	@keyframes tear-right {
		0% {
			transform: translate(0, 0) rotate(0deg) scale(1);
			opacity: 1;
		}
		100% {
			transform: translate(24px, -6px) rotate(16deg) scale(1.04);
			opacity: 0;
		}
	}

	/* 中秋灯笼雨：从页面底部升起的灯笼 */
	.festival-layer {
		position: fixed;
		inset: 0;
		z-index: 9990;
		pointer-events: none;
	}

	.festival-lantern {
		position: fixed;
		bottom: -120px;
		width: 45px;
		height: auto;
		pointer-events: none;
		user-select: none;
		will-change: transform;
		animation: festival-rise var(--rise-time, 10s) linear forwards;
	}

	@keyframes festival-rise {
		0% { transform: translateY(0); }
		30% { transform: translateY(-30vh); }
		55% { transform: translateY(-60vh); }
		80% { transform: translateY(-90vh); }
		100% { transform: translateY(-120vh); }
	}

	/* 国庆花朵：容器负责匀速下落，图片负责左右摇晃 */
	.festival-flower {
		position: fixed;
		top: -80px;
		pointer-events: none;
		user-select: none;
		will-change: transform;
		animation: festival-fall var(--fall-time, 5s) linear forwards;
	}

	.festival-flower img {
		display: block;
		width: 48px;
		height: auto;
		animation: festival-rock var(--rock-time, 1.4s) ease-in-out infinite
			alternate;
	}

	@keyframes festival-fall {
		0% { transform: translateY(0); }
		100% { transform: translateY(110vh); }
	}

	@keyframes festival-rock {
		from { transform: translateX(calc(var(--sway, 0px) * -1)); }
		to { transform: translateX(var(--sway, 0px)); }
	}

	.lantern-toast {
		position: fixed;
		left: 14px;
		top: 64px;
		z-index: 10001;
		max-width: min(70vw, 18rem);
		padding: 0.55rem 0.75rem;
		border-radius: 0.65rem;
		border: 1px solid rgba(255, 202, 40, 0.85);
		background: rgba(34, 24, 16, 0.92);
		color: #ffe4ad;
		font-size: 0.84rem;
		font-weight: 700;
		line-height: 1.2;
		box-shadow: 0 8px 20px rgba(0, 0, 0, 0.28);
		pointer-events: none;
	}

	@media (prefers-reduced-motion: reduce) {
		.paper-left:is(.is-tearing, .is-restoring),
		.paper-right:is(.is-tearing, .is-restoring) {
			animation-duration: 1ms;
		}

		.festival-lantern {
			animation-duration: 1ms;
			animation-delay: 0ms !important;
		}

		.festival-flower {
			animation-duration: 1ms;
			animation-delay: 0ms !important;
		}

		.festival-flower img {
			animation: none;
		}
	}

	/* Mobile only adjustments */
	@media (max-width: 768px) {
		.lantern-container {
			top: -10px;
			padding: 0 12px;
		}

		.lantern-item {
			animation-duration: 4.5s;
		}

		.lantern-line {
			width: 2px;
			height: 30px;
		}

		.lantern-body {
			width: 72px;
			height: 58px;
			box-shadow: 0 0 24px 8px rgba(255, 69, 0, 0.35);
			border-width: 1px;
		}

		.lantern-body::before {
			width: 40px;
			border-left-width: 1px;
			border-right-width: 1px;
		}

		.lantern-body-inner {
			width: 18px;
			border-left-width: 1px;
			border-right-width: 1px;
		}

		.lantern-cap {
			width: 34px;
			height: 6px;
			border-radius: 3px;
		}

		.lantern-text {
			font-size: 24px;
			text-shadow:
				0 0 6px rgba(255, 202, 40, 0.7),
				1px 1px 2px rgba(0, 0, 0, 0.45);
		}

		.lantern-tassel {
			width: 4px;
			height: 24px;
			margin-top: 4px;
		}

		.pos-2,
		.pos-3 {
			display: none;
		}

		.lantern-toggle--festival {
			min-width: 7.6rem;
			padding: 10px 14px;
		}

		.lantern-toggle--prank {
			padding: 10px 18px;
		}

		.paper,
		.paper-face {
			font-size: 13px;
		}

		.festival-lantern {
			bottom: -90px;
			width: 34px;
		}

		.festival-flower img {
			width: 36px;
		}

		.lantern-toast {
			max-width: min(80vw, 16rem);
			font-size: 0.8rem;
		}
	}
</style>
