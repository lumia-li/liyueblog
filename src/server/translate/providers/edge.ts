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
 * 微软 Edge 翻译接口（edge.microsoft.com/translate/translatetext）。
 *
 * 特点：无需注册、无需 API Key，直接复用 Edge 浏览器自带的翻译通道，
 * 质量与速度都优于公共免费通道，且没有 translate.service 那样的频率防护。
 *
 * 请求：POST {endpoint}?from=zh-Hans&to=en&api-version=3.0
 *   body = JSON 数组，如 ["你好","再见"]（一次可提交多条）
 *   from 省略时接口会自动识别源语言（响应里会带 detectedLanguage）
 * 响应：[{ translations: [{ text }] }, ...]，顺序与入参一一对应
 *
 * 注意：伪装 Edge 浏览器的 UA / Origin / Referer 是必需的，
 * 否则接口会拒绝请求（参考 Edge 翻译扩展的实际调用方式）。
 */

const DEFAULT_ENDPOINT = "https://edge.microsoft.com/translate/translatetext";
const API_VERSION = "3.0";

/** 单次请求最大文本条数（再多也放得下，这里保守取值保证响应体不过大） */
const MAX_BATCH = 25;
/** 单个批次请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 15000;

/** 站内语言代码 → 微软接口的 BCP-47 代码 */
const EDGE_CODE_BY_CODE: Record<string, string> = {
	zh: "zh-Hans",
	"zh-TW": "zh-Hant",
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

const BROWSER_HEADERS: Record<string, string> = {
	"Content-Type": "application/json",
	Accept: "application/json",
	"User-Agent":
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
	Origin: "https://www.microsoft.com",
	Referer: "https://www.microsoft.com/",
};

interface EdgeTranslationItem {
	translations?: Array<{ text?: string }>;
}

/** 站内语言代码 → 微软代码；未知代码原样下发，交给接口自行判断 */
function toEdgeCode(code: string): string {
	const normalized = code.trim();
	return EDGE_CODE_BY_CODE[normalized] ?? normalized;
}

async function translateGroup(
	endpoint: string,
	texts: string[],
	from: string,
	to: string,
): Promise<string[]> {
	const params = new URLSearchParams({ to, "api-version": API_VERSION });
	if (from) params.set("from", from);

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	let response: Response;
	try {
		response = await fetch(`${endpoint}?${params.toString()}`, {
			method: "POST",
			headers: BROWSER_HEADERS,
			body: JSON.stringify(texts),
			signal: controller.signal,
		});
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error("微软翻译请求超时");
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`微软翻译请求失败：${message}`);
	} finally {
		clearTimeout(timer);
	}

	if (!response.ok) {
		const body = await readErrorBody(response);
		throw new Error(
			`微软翻译返回 ${response.status}${body ? `：${body}` : ""}`,
		);
	}

	const payload = (await response.json().catch(() => null)) as
		| EdgeTranslationItem[]
		| null;
	if (!Array.isArray(payload) || payload.length !== texts.length) {
		throw new Error("微软翻译返回格式异常");
	}

	return payload.map((item) => {
		const translation = Array.isArray(item?.translations)
			? item.translations[0]
			: undefined;
		return typeof translation?.text === "string" ? translation.text : "";
	});
}

export const edgeProvider: TranslationProvider = {
	id: "edge",
	label: "微软 Edge 翻译",
	isConfigured(): boolean {
		// 公共接口，无需任何配置
		return true;
	},
	describe(): ProviderDescription {
		return {
			mode: "edge-translate-public",
			detail:
				"微软 Edge 翻译接口（无需密钥，单条 / 批量均可，支持源语言自动识别）",
		};
	},
	async translate(input: ProviderTranslateInput): Promise<string[]> {
		if (input.texts.length === 0) return [];

		const endpoint = (
			readEnv("EDGE_TRANSLATE_API_URL") || DEFAULT_ENDPOINT
		).replace(/\/+$/, "");

		const to = toEdgeCode(input.target);
		// source 为 auto（或未匹配到）时省略 from，由接口自动识别
		const from =
			input.source && input.source !== "auto"
				? EDGE_CODE_BY_CODE[input.source] ?? ""
				: "";

		const results: string[] = [];
		for (const group of chunk(input.texts, MAX_BATCH)) {
			results.push(...(await translateGroup(endpoint, group, from, to)));
		}
		return results;
	},
};
