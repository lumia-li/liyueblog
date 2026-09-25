import type { AstroIntegration } from "@swup/astro";

declare global {
	interface Window {
		// type from '@swup/astro' is incorrect
		swup: AstroIntegration;
		__bgSelectionIndex?: number;
		__bgSelection?: {
			src: string;
			type: "image" | "video";
		} | null;
		pagefind: {
			search: (query: string) => Promise<{
				results: Array<{
					data: () => Promise<SearchResult>;
				}>;
			}>;
		};
		showWaifuMessage?: (
			text: string,
			duration?: number,
			options?: {
				force?: boolean;
			},
		) => boolean;
		/** 登记“睡觉时”也要保留的看板娘台词（避免被通用睡觉文案替换） */
		__extraSleepingWaifuMessages?: string[];
	}
}

interface SearchResult {
	url: string;
	meta: {
		title: string;
	};
	excerpt: string;
	content?: string;
	word_count?: number;
	filters?: Record<string, unknown>;
	anchors?: Array<{
		element: string;
		id: string;
		text: string;
		location: number;
	}>;
	weighted_locations?: Array<{
		weight: number;
		balanced_score: number;
		location: number;
	}>;
	locations?: number[];
	raw_content?: string;
	raw_url?: string;
	sub_results?: SearchResult[];
}
