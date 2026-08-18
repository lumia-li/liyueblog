import { getCollection, type CollectionEntry } from "astro:content";
import { formatDateToYYYYMMDD } from "./date-utils";
import { getThoughtUrlBySlug } from "./url-utils";

export type ThoughtEntry = CollectionEntry<"thoughts">;

// 供 feed.json 与无限滚动组件使用的一篇随笔的序列化结构
export interface ThoughtFeedItem {
	slug: string;
	title: string;
	published: string;
	description: string;
	url: string;
}

// 按发布时间倒序获取全部随笔
export async function getSortedThoughts(): Promise<ThoughtEntry[]> {
	const allThoughts = await getCollection("thoughts");
	return allThoughts.sort((a, b) => {
		const dateA = new Date(a.data.published);
		const dateB = new Date(b.data.published);
		return dateA > dateB ? -1 : 1;
	});
}

// 构建期生成全部随笔的卡片数据（元数据 + 详情页链接）
export async function getThoughtFeedItems(): Promise<ThoughtFeedItem[]> {
	const thoughts = await getSortedThoughts();
	return thoughts.map((t) => ({
		slug: t.slug,
		title: t.data.title ?? "",
		published: formatDateToYYYYMMDD(t.data.published),
		description: t.data.description ?? "",
		url: getThoughtUrlBySlug(t.slug),
	}));
}
