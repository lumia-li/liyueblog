import { readEnv } from "@/server/translate/env";
import { translatejsProvider } from "@/server/translate/providers/translatejs";
import type { TranslationProvider } from "@/server/translate/providers/types";

/**
 * 适配器注册表。
 * 目前只启用了 translate.js 免费通道；想扩展时实现 TranslationProvider 后加到这里即可。
 */
export const PROVIDERS: Record<string, TranslationProvider> = {
	[translatejsProvider.id]: translatejsProvider,
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/**
 * 选择翻译服务。
 * 只启用了 translatejs（translate.service 免费通道），无需任何密钥。
 */
export function resolveProvider(): TranslationProvider {
	const configured = readEnv("TRANSLATE_PROVIDER").toLowerCase();
	if (configured && !PROVIDERS[configured]) {
		throw new Error(
			`TRANSLATE_PROVIDER=${configured} 已不再支持，当前仅启用：${PROVIDER_IDS.join(", ")}`,
		);
	}
	return translatejsProvider;
}

/** 当前服务信息（不含任何密钥） */
export function describeProvider(): {
	id: string;
	label: string;
	configured: boolean;
	mode: string;
	detail: string;
} {
	const provider = translatejsProvider;
	const description = provider.describe?.() ?? { mode: "unknown", detail: "" };
	return {
		id: provider.id,
		label: provider.label,
		configured: provider.isConfigured(),
		mode: description.mode,
		detail: description.detail,
	};
}
