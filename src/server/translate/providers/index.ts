import { DEFAULT_TRANSLATE_PROVIDER } from "@i18n/translate/providers";
import { readEnv } from "@/server/translate/env";
import { edgeProvider } from "@/server/translate/providers/edge";
import { translatejsProvider } from "@/server/translate/providers/translatejs";
import type { TranslationProvider } from "@/server/translate/providers/types";

/**
 * 适配器注册表。
 *
 * 已启用：
 * - translatejs：translate.js 免费通道（translate.service）
 * - edge：微软 Edge 翻译接口
 *
 * 想扩展时实现 TranslationProvider 后加到这里即可（前端面板的短标签
 * 在 src/i18n/translate/providers.ts 里维护）。
 */
export const PROVIDERS: Record<string, TranslationProvider> = {
	[translatejsProvider.id]: translatejsProvider,
	[edgeProvider.id]: edgeProvider,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/** 按 id 取一个可用的适配器，未知或不可用时返回 null */
function pickProvider(id: string): TranslationProvider | null {
	const provider = PROVIDERS[id.trim().toLowerCase()];
	if (!provider || !provider.isConfigured()) return null;
	return provider;
}

/**
 * 选择翻译服务。
 * 优先级：请求指定的 provider > 环境变量 TRANSLATE_PROVIDER > 内置默认。
 *
 * @param requested 请求体里的 provider（访客在面板里选择的翻译源）
 */
export function resolveProvider(requested?: string): TranslationProvider {
	if (requested && requested.trim()) {
		const provider = pickProvider(requested);
		if (!provider) {
			throw new Error(
				`不支持的翻译源：${requested}，可选：${PROVIDER_IDS.join("、")}`,
			);
		}
		return provider;
	}

	const configured = readEnv("TRANSLATE_PROVIDER").toLowerCase();
	if (configured) {
		const provider = pickProvider(configured);
		if (!provider) {
			throw new Error(
				`TRANSLATE_PROVIDER=${configured} 不可用，可选：${PROVIDER_IDS.join("、")}`,
			);
		}
		return provider;
	}

	return (
		PROVIDERS[DEFAULT_TRANSLATE_PROVIDER] ??
		PROVIDERS[PROVIDER_IDS[0]] ??
		translatejsProvider
	);
}

/** 单个翻译源的公开信息（不含任何密钥） */
export interface ProviderSummary {
	id: string;
	label: string;
	configured: boolean;
	mode: string;
	detail: string;
}

function summarize(provider: TranslationProvider): ProviderSummary {
	const description = provider.describe?.() ?? { mode: "unknown", detail: "" };
	return {
		id: provider.id,
		label: provider.label,
		configured: provider.isConfigured(),
		mode: description.mode,
		detail: description.detail,
	};
}

/**
 * 翻译源信息。
 * @param id 指定翻译源 id；不传则使用当前生效的默认翻译源。
 */
export function describeProvider(id?: string): ProviderSummary {
	let provider: TranslationProvider | undefined;
	if (id) provider = PROVIDERS[id.trim().toLowerCase()];
	if (!provider) {
		try {
			provider = resolveProvider();
		} catch {
			provider = translatejsProvider;
		}
	}
	return summarize(provider);
}

/** 全部已启用的翻译源信息，顺序与注册表一致 */
export function listProviders(): ProviderSummary[] {
	return PROVIDER_IDS.map((id) => describeProvider(id));
}
