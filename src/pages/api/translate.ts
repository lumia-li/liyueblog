import { SUPPORTED_LANGUAGE_CODES } from "@i18n/translate/languages";
import {
	TRANSLATE_LIMITS,
	normalizeTranslateRequest,
	translateTexts,
} from "@/server/translate/engine";
import { getTermStats } from "@/server/translate/glossary";
import { describeProvider } from "@/server/translate/providers";
import type {
	TranslateErrorPayload,
	TranslateServiceInfo,
	TranslateSuccessPayload,
} from "@/types/translate";
import type { APIRoute } from "astro";

/**
 * 智能多语言翻译 API。
 *
 * - `prerender = false` 保证在 Vercel 上以函数（动态）形式执行，不会被静态预渲染。
 * - API Key 只在服务端读取（见 src/server/translate/providers/*），请求与响应中都不含密钥。
 * - 术语表与忽略词在服务端处理，前端拿不到具体规则。
 */
export const prerender = false;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 90;
const MAX_BODY_BYTES = 512 * 1024;

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function json(status: number, payload: unknown): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function errorResponse(status: number, message: string, code?: string): Response {
	const payload: TranslateErrorPayload = { ok: false, message, ...(code ? { code } : {}) };
	return json(status, payload);
}

function getClientIp(request: Request): string {
	const forwarded = request.headers.get("x-forwarded-for") || "";
	const first = forwarded.split(",")[0]?.trim();
	if (first) return first;
	return request.headers.get("x-real-ip") || request.headers.get("cf-connecting-ip") || "unknown";
}

function checkRateLimit(key: string): boolean {
	const now = Date.now();
	const bucket = rateBuckets.get(key);

	if (!bucket || now > bucket.resetAt) {
		rateBuckets.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
		if (rateBuckets.size > 5000) {
			for (const [bucketKey, value] of rateBuckets) {
				if (now > value.resetAt) rateBuckets.delete(bucketKey);
			}
		}
		return true;
	}

	bucket.count += 1;
	return bucket.count <= RATE_LIMIT_MAX_REQUESTS;
}

export const POST: APIRoute = async ({ request }) => {
	if (!checkRateLimit(getClientIp(request))) {
		return errorResponse(429, "请求过于频繁，请稍后再试", "RATE_LIMITED");
	}

	const contentLength = Number.parseInt(request.headers.get("content-length") || "0", 10);
	if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
		return errorResponse(413, "请求体过大", "PAYLOAD_TOO_LARGE");
	}

	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return errorResponse(400, "请求体不是合法的 JSON", "INVALID_JSON");
	}

	const normalized = normalizeTranslateRequest(raw);
	if (!normalized.ok) {
		return errorResponse(normalized.status, normalized.message, "INVALID_REQUEST");
	}

	try {
		const result = await translateTexts(normalized.value);
		const payload: TranslateSuccessPayload = {
			ok: true,
			provider: result.provider,
			translations: result.translations,
			requested: normalized.value.texts.length,
			translated: result.translated,
			returned: result.translations.length,
		};
		return json(200, payload);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "翻译服务暂时不可用，请稍后再试";
		// 服务端出错时前端保留原文，不会出现空白内容
		return errorResponse(502, message, "PROVIDER_ERROR");
	}
};

export const GET: APIRoute = async () => {
	const provider = describeProvider();
	const terms = getTermStats();
	const payload: TranslateServiceInfo = {
		ok: true,
		provider: provider.id,
		providerLabel: provider.label,
		configured: provider.configured,
		mode: provider.mode,
		detail: provider.detail,
		supportedLanguages: SUPPORTED_LANGUAGE_CODES,
		maxTexts: TRANSLATE_LIMITS.maxTexts,
		maxTotalChars: TRANSLATE_LIMITS.maxTotalChars,
		glossarySize: terms.glossarySize,
		ignoreWordsSize: terms.ignoreWordsSize,
	};
	return json(200, payload);
};
