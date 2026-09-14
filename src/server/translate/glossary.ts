import { readEnv } from "@/server/translate/env";
import type { TranslateGlossary, TranslateGlossaryValue } from "@/types/translate";

/**
 * 术语表与忽略词（服务端处理，前端完全拿不到这些逻辑）。
 *
 * - 术语表：做占位符保护，翻译完成后再替换为指定译法，保证品牌名 / 技术名词不被误译。
 * - 忽略词：整词保护，翻译后原样还原，完全不翻译。
 *
 * 两者都可以通过环境变量追加：
 *   TRANSLATE_GLOSSARY='{"我的博客":"My Blog","DeepSeek":{"en":"DeepSeek"}}'
 *   TRANSLATE_IGNORE_WORDS='liyueovo,liyueovo.top'
 */

/** 内置术语表：技术名词 / 品牌名，按目标语言给出确定译法 */
export const SERVER_GLOSSARY: TranslateGlossary = {
	// 品牌与站点
	璃月小站: { en: "Liyue Blog", ja: "リーユエ小駅" },
	璃月: { en: "Liyue", ja: "リーユエ" },

	// 框架与工具链（保持原样，避免被音译）
	Astro: "Astro",
	Svelte: "Svelte",
	"SvelteKit": "SvelteKit",
	Tailwind: "Tailwind",
	"Tailwind CSS": "Tailwind CSS",
	TypeScript: "TypeScript",
	JavaScript: "JavaScript",
	"Node.js": "Node.js",
	Vite: "Vite",
	Vercel: "Vercel",
	Biome: "Biome",
	pnpm: "pnpm",
	npm: "npm",
	Markdown: "Markdown",
	KaTeX: "KaTeX",
	Pagefind: "Pagefind",
	Swup: "Swup",
	Live2D: "Live2D",
	GitHub: "GitHub",
	Git: "Git",
	Docker: "Docker",
	Nginx: "Nginx",
	MySQL: "MySQL",
	Express: "Express",
	Supabase: "Supabase",
	CloudBase: "CloudBase",
	OpenAI: "OpenAI",
	DeepSeek: "DeepSeek",
	ChatGPT: "ChatGPT",
	DeepL: "DeepL",
	Google: "Google",
	API: "API",
	CDN: "CDN",
	CSS: "CSS",
	HTML: "HTML",
	JSON: "JSON",
	RSS: "RSS",
	SEO: "SEO",
	UI: "UI",
	UX: "UX",
	WebP: "WebP",
	WebSocket: "WebSocket",
};

/** 内置忽略词：出现即原样保留，绝不翻译 */
export const SERVER_IGNORE_WORDS: string[] = [
	"liyueovo.top",
	"liyueovo",
	"liyue-blog",
	"wangchen-2023",
	"CC BY-NC-SA 4.0",
];

export type GlossaryTermKind = "glossary" | "ignore";

export interface GlossaryTerm {
	term: string;
	kind: GlossaryTermKind;
	/** 术语表条目对应的译法（忽略词为空） */
	value?: TranslateGlossaryValue;
}

export function isGlossaryValue(value: unknown): value is TranslateGlossaryValue {
	if (typeof value === "string") return true;
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return Object.values(value as Record<string, unknown>).every(
			(item) => typeof item === "string",
		);
	}
	return false;
}

/** 解析 JSON 形式的术语表，失败时返回空对象 */
export function parseGlossaryJson(raw: string): TranslateGlossary {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const result: TranslateGlossary = {};
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (!key.trim() || !isGlossaryValue(value)) continue;
			result[key] = value;
		}
		return result;
	} catch {
		return {};
	}
}

function parseWordList(raw: string): string[] {
	if (!raw) return [];
	return raw
		.split(/[,，\n]/)
		.map((item) => item.trim())
		.filter(Boolean);
}

/** 读取环境变量中追加的术语表 / 忽略词 */
export function getEnvGlossary(): TranslateGlossary {
	return parseGlossaryJson(readEnv("TRANSLATE_GLOSSARY"));
}

export function getEnvIgnoreWords(): string[] {
	return parseWordList(readEnv("TRANSLATE_IGNORE_WORDS"));
}

/**
 * 合并术语表与忽略词。
 * 优先级：内置 > 环境变量 > 请求参数，保证服务端始终掌握最终解释权。
 */
export function buildTerms(options: {
	glossary?: TranslateGlossary;
	ignoreWords?: string[];
}): GlossaryTerm[] {
	const ignoreList = [
		...new Set([
			...SERVER_IGNORE_WORDS,
			...getEnvIgnoreWords(),
			...(options.ignoreWords ?? []),
		]),
	];

	const glossary: TranslateGlossary = {
		...options.glossary,
		...getEnvGlossary(),
		...SERVER_GLOSSARY,
	};

	const terms: GlossaryTerm[] = [];
	const seen = new Set<string>();

	for (const word of ignoreList) {
		const term = word.trim();
		if (!term) continue;
		const key = term.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		terms.push({ term, kind: "ignore" });
	}

	for (const [term, value] of Object.entries(glossary)) {
		const trimmed = term.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		terms.push({ term: trimmed, kind: "glossary", value });
	}

	// 长词优先，避免短词先命中导致长词被切碎
	terms.sort((a, b) => b.term.length - a.term.length);
	return terms;
}

// ------------------------------------------------------------------ 占位符保护

export interface PlaceholderToken {
	placeholder: string;
	/** 还原时写回的最终文本 */
	resolved: string;
	/** 原始词条，便于排查 */
	term: string;
}

/**
 * 占位符统一使用数学白色方括号 ⟦n⟧。
 * 实测：[[0]] 会被翻译引擎改写成「[[ 0] ]」导致还原失败，而 ⟦0⟧ 能原样保留。
 * 后面几个是兜底模式，用于尽可能把被改写的占位符还原回来。
 */
const PLACEHOLDER_PATTERNS: RegExp[] = [
	/⟦\s*(\d+)\s*⟧/g,
	/\[\[\s*(\d+)\s*\]\s*\]/g,
	/［［\s*(\d+)\s*］\s*］/g,
	/\{\{\s*(\d+)\s*\}\}/g,
	/[〔【]\s*(\d+)\s*[〕】]/g,
];

const ASCII_ONLY = /^[\x20-\x7E]+$/;
const WORD_CHAR = /[A-Za-z0-9_]/;

interface TermMatcher {
	regex: RegExp;
	terms: GlossaryTerm[];
}

let cachedMatcher: TermMatcher | null = null;
let cachedMatcherKey = "";

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getMatcher(terms: GlossaryTerm[]): TermMatcher | null {
	if (terms.length === 0) return null;
	const key = terms.map((item) => `${item.kind}:${item.term}`).join("|");
	if (cachedMatcher && cachedMatcherKey === key) return cachedMatcher;
	const regex = new RegExp(terms.map((item) => escapeRegExp(item.term)).join("|"), "gi");
	cachedMatcher = { regex, terms };
	cachedMatcherKey = key;
	return cachedMatcher;
}

/** ASCII 词条需要判断左右边界，避免 API 命中 CAPITAL 这类词中词 */
function hasValidBoundary(text: string, index: number, matched: string): boolean {
	if (!ASCII_ONLY.test(matched)) return true;
	const before = index > 0 ? text[index - 1] : "";
	const after = text[index + matched.length] ?? "";
	if (before && WORD_CHAR.test(before)) return false;
	if (after && WORD_CHAR.test(after)) return false;
	return true;
}

function resolveTerm(term: GlossaryTerm, target: string): string {
	if (term.kind === "ignore" || term.value === undefined) return term.term;
	if (typeof term.value === "string") return term.value;
	const base = target.split("-")[0];
	return (
		term.value[target] ??
		term.value[base] ??
		term.value[target.toLowerCase()] ??
		term.value.en ??
		term.term
	);
}

export interface ProtectResult {
	text: string;
	tokens: PlaceholderToken[];
	/** 保护后剩余可翻译内容为空（整段都是受保护词） */
	onlyTokens: boolean;
}

/** 用占位符替换术语表 / 忽略词，返回保护后的文本 */
export function protectText(
	text: string,
	target: string,
	terms: GlossaryTerm[],
): ProtectResult {
	const matcher = getMatcher(terms);
	const tokens: PlaceholderToken[] = [];
	if (!matcher) return { text, tokens, onlyTokens: false };

	matcher.regex.lastIndex = 0;
	let output = "";
	let lastIndex = 0;
	let match = matcher.regex.exec(text);

	while (match) {
		const matched = match[0];
		if (matched.length === 0) {
			matcher.regex.lastIndex += 1;
			match = matcher.regex.exec(text);
			continue;
		}

		if (hasValidBoundary(text, match.index, matched)) {
			const term = matcher.terms.find(
				(item) => item.term.toLowerCase() === matched.toLowerCase(),
			);
			if (term) {
				const placeholder = `⟦${tokens.length}⟧`;
				tokens.push({
					placeholder,
					resolved: resolveTerm(term, target),
					term: term.term,
				});
				output += text.slice(lastIndex, match.index) + placeholder;
				lastIndex = match.index + matched.length;
			}
		}

		match = matcher.regex.exec(text);
	}

	if (tokens.length === 0) return { text, tokens, onlyTokens: false };

	output += text.slice(lastIndex);
	const onlyTokens =
		PLACEHOLDER_PATTERNS.reduce(
			(acc, pattern) => acc.replace(pattern, ""),
			output,
		).trim().length === 0;
	return { text: output, tokens, onlyTokens };
}

/** 把译文中的占位符还原为术语表译法 / 忽略词原文 */
export function restorePlaceholders(
	text: string,
	tokens: PlaceholderToken[],
): string {
	if (tokens.length === 0) return text;
	const pick = (index: string): string | undefined => {
		const token = tokens[Number(index)];
		return token ? token.resolved : undefined;
	};
	let output = text;
	for (const pattern of PLACEHOLDER_PATTERNS) {
		output = output.replace(pattern, (full, index: string) => pick(index) ?? full);
	}
	return output;
}

/** 术语表 / 忽略词规模（用于 GET 信息接口） */
export function getTermStats(): { glossarySize: number; ignoreWordsSize: number } {
	return {
		glossarySize:
			Object.keys(SERVER_GLOSSARY).length + Object.keys(getEnvGlossary()).length,
		ignoreWordsSize: SERVER_IGNORE_WORDS.length + getEnvIgnoreWords().length,
	};
}
