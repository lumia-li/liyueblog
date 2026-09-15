import { LANGUAGE_CODE_PATTERN, normalizeLanguageCode } from "@i18n/translate/languages";
import {
	type GlossaryTerm,
	type PlaceholderToken,
	buildTerms,
	protectText,
	restorePlaceholders,
} from "@/server/translate/glossary";
import { resolveProvider } from "@/server/translate/providers";
import type {
	TranslateGlossary,
	TranslateGlossaryValue,
} from "@/types/translate";

/** 服务端硬性限制，防止被当成任意文本翻译网关滥用 */
export const TRANSLATE_LIMITS = {
	/** 单次最多文本条数 */
	maxTexts: 60,
	/** 单条文本最大长度 */
	maxTextLength: 2000,
	/** 单次总字符数上限 */
	maxTotalChars: 12000,
	/** 术语表条目上限 */
	maxGlossaryEntries: 200,
	/** 忽略词上限 */
	maxIgnoreWords: 200,
	/** 单个词条最大长度 */
	maxTermLength: 80,
} as const;

export interface NormalizedTranslateRequest {
	texts: string[];
	source: string;
	target: string;
	/** 翻译源（适配器 id），空字符串表示使用默认翻译源 */
	provider: string;
	glossary: TranslateGlossary;
	ignoreWords: string[];
}

export type NormalizeResult =
	| { ok: true; value: NormalizedTranslateRequest }
	| { ok: false; status: number; message: string };

function fail(status: number, message: string): NormalizeResult {
	return { ok: false, status, message };
}

function sanitizeGlossary(raw: unknown): TranslateGlossary {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const entries = Object.entries(raw as Record<string, unknown>).slice(
		0,
		TRANSLATE_LIMITS.maxGlossaryEntries,
	);
	const glossary: TranslateGlossary = {};
	for (const [key, value] of entries) {
		const term = key.trim();
		if (!term || term.length > TRANSLATE_LIMITS.maxTermLength) continue;
		if (typeof value === "string") {
			if (value.length > TRANSLATE_LIMITS.maxTermLength) continue;
			glossary[term] = value;
			continue;
		}
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const mapped: Record<string, string> = {};
			for (const [lang, text] of Object.entries(
				value as Record<string, unknown>,
			)) {
				if (typeof text !== "string") continue;
				if (text.length > TRANSLATE_LIMITS.maxTermLength) continue;
				mapped[normalizeLanguageCode(lang) || lang] = text;
			}
			if (Object.keys(mapped).length > 0) {
				glossary[term] = mapped as TranslateGlossaryValue;
			}
		}
	}
	return glossary;
}

function sanitizeIgnoreWords(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const words: string[] = [];
	for (const item of raw.slice(0, TRANSLATE_LIMITS.maxIgnoreWords)) {
		if (typeof item !== "string") continue;
		const word = item.trim();
		if (!word || word.length > TRANSLATE_LIMITS.maxTermLength) continue;
		words.push(word);
	}
	return words;
}

/** 参数校验与归一化 */
export function normalizeTranslateRequest(input: unknown): NormalizeResult {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return fail(400, "请求体必须是 JSON 对象");
	}

	const body = input as Record<string, unknown>;
	const rawTexts = body.texts;

	if (!Array.isArray(rawTexts) || rawTexts.length === 0) {
		return fail(400, "texts 必须是非空字符串数组");
	}
	if (rawTexts.length > TRANSLATE_LIMITS.maxTexts) {
		return fail(413, `单次最多翻译 ${TRANSLATE_LIMITS.maxTexts} 条文本`);
	}

	const texts: string[] = [];
	let totalChars = 0;
	for (const item of rawTexts) {
		if (typeof item !== "string") {
			return fail(400, "texts 必须是非空字符串数组");
		}
		if (item.length > TRANSLATE_LIMITS.maxTextLength) {
			return fail(
				413,
				`单条文本长度不能超过 ${TRANSLATE_LIMITS.maxTextLength} 个字符`,
			);
		}
		totalChars += item.length;
		if (totalChars > TRANSLATE_LIMITS.maxTotalChars) {
			return fail(
				413,
				`单次翻译总长度不能超过 ${TRANSLATE_LIMITS.maxTotalChars} 个字符`,
			);
		}
		texts.push(item);
	}

	if (typeof body.target !== "string" || !body.target.trim()) {
		return fail(400, "缺少目标语言 target");
	}
	const target = normalizeLanguageCode(body.target);
	if (!target || !LANGUAGE_CODE_PATTERN.test(target)) {
		return fail(400, "target 语言代码格式不正确");
	}

	let source = "auto";
	if (typeof body.source === "string" && body.source.trim()) {
		const normalized = normalizeLanguageCode(body.source);
		if (normalized !== "auto" && !LANGUAGE_CODE_PATTERN.test(normalized)) {
			return fail(400, "source 语言代码格式不正确");
		}
		source = normalized;
	}

	// provider 只做格式收敛，是否受支持交给路由层 / resolveProvider 判断
	let provider = "";
	if (typeof body.provider === "string" && body.provider.trim()) {
		provider = body.provider.trim().toLowerCase().slice(0, 40);
	}

	return {
		ok: true,
		value: {
			texts,
			source,
			target,
			provider,
			glossary: sanitizeGlossary(body.glossary),
			ignoreWords: sanitizeIgnoreWords(body.ignoreWords),
		},
	};
}

export interface ServerTranslateResult {
	translations: string[];
	provider: string;
	/** 实际与原文不同的条数 */
	translated: number;
}

/**
 * 翻译主流程：
 * 术语表占位符保护 → 去重 → 批量请求适配器 → 还原占位符 → 失败时回退原文。
 */
export async function translateTexts(
	request: NormalizedTranslateRequest,
): Promise<ServerTranslateResult> {
	const provider = resolveProvider(request.provider);
	const terms: GlossaryTerm[] = buildTerms({
		glossary: request.glossary,
		ignoreWords: request.ignoreWords,
	});

	// 源语言与目标语言一致时直接返回原文
	if (request.source !== "auto" && request.source === request.target) {
		return {
			translations: [...request.texts],
			provider: provider.id,
			translated: 0,
		};
	}

	const uniqueTexts: string[] = [];
	const indexOfUnique = new Map<string, number>();
	const itemRef: number[] = [];
	const itemDirect: string[] = [];
	const itemTokens: PlaceholderToken[][] = [];

	for (const text of request.texts) {
		const protectedResult = protectText(text, request.target, terms);
		itemTokens.push(protectedResult.tokens);

		if (protectedResult.tokens.length === 0) {
			// 没有命中术语表 / 忽略词，原文直接送翻译
			itemDirect.push("");
			itemRef.push(registerUnique(protectedResult.text));
			continue;
		}

		if (protectedResult.onlyTokens) {
			// 整段都是受保护词，无需请求翻译服务
			itemDirect.push(
				restorePlaceholders(protectedResult.text, protectedResult.tokens),
			);
			itemRef.push(-1);
			continue;
		}

		itemDirect.push("");
		itemRef.push(registerUnique(protectedResult.text));
	}

	function registerUnique(text: string): number {
		const existing = indexOfUnique.get(text);
		if (existing !== undefined) return existing;
		const index = uniqueTexts.length;
		uniqueTexts.push(text);
		indexOfUnique.set(text, index);
		return index;
	}

	let providerResults: string[] = [];
	if (uniqueTexts.length > 0) {
		providerResults = await provider.translate({
			texts: uniqueTexts,
			source: request.source,
			target: request.target,
		});
		if (providerResults.length !== uniqueTexts.length) {
			throw new Error("翻译服务返回的结果数量与请求不一致");
		}
	}

	const translations: string[] = [];
	let translated = 0;

	for (let i = 0; i < request.texts.length; i += 1) {
		const original = request.texts[i];
		const ref = itemRef[i];
		let value: string;

		if (ref < 0) {
			value = itemDirect[i];
		} else {
			const raw = providerResults[ref];
			value =
				typeof raw === "string" && raw.trim()
					? restorePlaceholders(raw, itemTokens[i])
					: original;
		}

		if (!value || !value.trim()) value = original;
		if (value !== original) translated += 1;
		translations.push(value);
	}

	return { translations, provider: provider.id, translated };
}
