import { readEnv } from "@/server/translate/env";
import type {
	ProviderDescription,
	ProviderTranslateInput,
	TranslationProvider,
} from "@/server/translate/providers/types";
import {
	chunk,
	readErrorBody,
} from "@/server/translate/providers/utils";

/**
 * translate.js 的免费翻译通道（translate.service），项目地址：
 * https://github.com/xnx3/translate
 *
 * 特点：完全免费、无需注册、无需 API Key，服务端带缓存，
 * 底层使用的是 Google / 微软等开放翻译服务，国内可直连。
 *
 * 接口：POST {base}/translate.json（form 表单）
 *   from = auto | 语言 id（可省略，省略即自动识别）
 *   to   = 语言 id（必填）
 *   text = JSON 数组字符串，如 ["你好","再见"]
 * 响应：{ result: 0失败 | 1成功 | 2需登录, info, text: [...], original, from, to }
 *
 * 限制：官方有「2 秒内最多 2 次请求」的防护，超出会返回 result=0 且 text=null，
 * 因此这里做了串行队列 + 最小间隔 + 失败重试。
 */

const DEFAULT_BASE_URL = "https://api.translate.zvo.cn";
const TRANSLATE_PATH = "/translate.json";
const LANGUAGE_PATH = "/language.json";

/** 单次请求最大文本条数（实测 50 条可一次返回） */
const MAX_BATCH = 50;
/** 最小请求间隔，避开官方的频率防护（2 秒内最多 2 次） */
const MIN_REQUEST_INTERVAL_MS = 1200;
/** 被限流后的最大重试次数 */
const MAX_RETRIES = 2;
/** 语言表缓存时长 */
const LANGUAGE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

/** 站内语言代码 → translate.service 的 serviceId */
const SERVICE_ID_BY_CODE: Record<string, string> = {
	zh: "zh-CN",
	"zh-TW": "zh-TW",
	en: "en",
	ja: "ja",
	ko: "ko",
	fr: "fr",
	de: "de",
	es: "es",
	ru: "ru",
	pt: "pt",
	it: "it",
	ar: "ar",
};

/** language.json 拉取失败时的兜底映射（serviceId → 语言 id） */
const FALLBACK_ID_BY_SERVICE: Record<string, string> = {
	"zh-cn": "chinese_simplified",
	"zh-tw": "chinese_traditional",
	en: "english",
	ja: "japanese",
	ko: "korean",
	fr: "french",
	de: "deutsch",
	es: "spanish",
	ru: "russian",
	pt: "portuguese",
	it: "italian",
	ar: "arabic",
};

interface TranslateServiceResponse {
	result?: number;
	info?: string;
	text?: Array<string | null> | null;
	original?: Array<string | null> | null;
}

// ------------------------------------------------------------------ 语言表

let languageCache: { map: Map<string, string>; expiresAt: number } | null = null;

async function loadLanguageMap(baseUrl: string): Promise<Map<string, string>> {
	if (languageCache && Date.now() < languageCache.expiresAt) {
		return languageCache.map;
	}

	const map = new Map<string, string>(Object.entries(FALLBACK_ID_BY_SERVICE));
	try {
		const response = await fetch(`${baseUrl}${LANGUAGE_PATH}`, {
			headers: { Accept: "application/json" },
		});
		if (response.ok) {
			const payload = (await response.json()) as {
				list?: Array<{ id?: string; serviceId?: string }>;
			};
			if (Array.isArray(payload?.list)) {
				for (const item of payload.list) {
					const serviceId = String(item?.serviceId ?? "")
						.trim()
						.toLowerCase();
					const id = String(item?.id ?? "").trim();
					if (serviceId && id) map.set(serviceId, id);
				}
			}
		}
	} catch {
		/* 拉取失败时使用兜底映射 */
	}

	languageCache = { map, expiresAt: Date.now() + LANGUAGE_CACHE_TTL_MS };
	return map;
}

function toServiceId(code: string): string {
	const normalized = code.trim();
	return SERVICE_ID_BY_CODE[normalized] ?? normalized;
}

// ------------------------------------------------------------------ 请求节流

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 串行执行，保证同一时刻只有一个请求 */
function enqueue<T>(task: () => Promise<T>): Promise<T> {
	const run = queue.then(task, task);
	queue = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

async function throttle(): Promise<void> {
	const wait = lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now();
	if (wait > 0) await sleep(wait);
	lastRequestAt = Date.now();
}

// ------------------------------------------------------------------ 翻译调用

async function postTranslate(
	baseUrl: string,
	params: Record<string, string>,
): Promise<TranslateServiceResponse> {
	const response = await enqueue(async () => {
		await throttle();
		return fetch(`${baseUrl}${TRANSLATE_PATH}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "application/json",
			},
			body: new URLSearchParams(params),
		});
	});

	if (!response.ok) {
		const body = await readErrorBody(response);
		throw new Error(
			`translate.service 返回 ${response.status}${body ? `：${body}` : ""}`,
		);
	}

	return (await response.json()) as TranslateServiceResponse;
}

async function translateGroup(
	baseUrl: string,
	group: string[],
	from: string,
	to: string,
): Promise<string[]> {
	let lastInfo = "";

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
		if (attempt > 0) await sleep(1200 * attempt * attempt);

		const payload = await postTranslate(baseUrl, {
			from,
			to,
			text: JSON.stringify(group),
		});

		if (
			payload?.result === 1 &&
			Array.isArray(payload.text) &&
			payload.text.length === group.length
		) {
			return payload.text.map((item) =>
				typeof item === "string" ? item : "",
			);
		}

		lastInfo = String(payload?.info ?? "");
		if (payload?.result === 2) {
			throw new Error(`translate.service 需要登录：${lastInfo || "未知原因"}`);
		}
		// result = 0：多为频率防护，退避后重试
	}

	throw new Error(`translate.service 翻译失败：${lastInfo || "未知错误"}`);
}

export const translatejsProvider: TranslationProvider = {
	id: "translatejs",
	label: "translate.js 免费通道",
	isConfigured(): boolean {
		// 完全免费，无需任何配置
		return true;
	},
	describe(): ProviderDescription {
		return {
			mode: "translate-service-free",
			detail:
				"translate.service 免费通道（无需密钥，带服务端缓存；有 2 秒内最多 2 次的频率限制）",
		};
	},
	async translate(input: ProviderTranslateInput): Promise<string[]> {
		const baseUrl = (
			readEnv("TRANSLATE_API_URL") || DEFAULT_BASE_URL
		).replace(/\/+$/, "");

		const languageMap = await loadLanguageMap(baseUrl);
		const to = languageMap.get(toServiceId(input.target).toLowerCase());
		if (!to) {
			throw new Error(`translate.service 不支持目标语言：${input.target}`);
		}

		let from = "auto";
		if (input.source && input.source !== "auto") {
			from =
				languageMap.get(toServiceId(input.source).toLowerCase()) ?? "auto";
		}

		const results: string[] = [];
		for (const group of chunk(input.texts, MAX_BATCH)) {
			results.push(...(await translateGroup(baseUrl, group, from, to)));
		}
		return results;
	},
};
