import type { APIContext } from "astro";
import { getThoughtFeedItems } from "@utils/thoughts-utils";

// 静态 JSON 端点：构建时输出到 dist/thoughts/feed.json，
// 供无限滚动组件增量加载随笔数据。
export async function GET(_context: APIContext): Promise<Response> {
	const items = await getThoughtFeedItems();
	return new Response(JSON.stringify(items), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}
