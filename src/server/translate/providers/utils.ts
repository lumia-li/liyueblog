/** 适配器公共工具 */

/** 把数组切成固定大小的块 */
export function chunk<T>(items: T[], size: number): T[][] {
	if (size <= 0) return [items];
	const result: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		result.push(items.slice(i, i + size));
	}
	return result;
}

/** 读取错误响应体，截断后用于提示 */
export async function readErrorBody(response: Response): Promise<string> {
	try {
		const text = await response.text();
		return text.slice(0, 300);
	} catch {
		return "";
	}
}
