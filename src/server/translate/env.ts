/**
 * 服务端环境变量读取。
 *
 * 同时兼容两种运行时：
 * - Vite / Astro 注入的 `import.meta.env`（构建期已知）
 * - Node / Vercel Functions 的 `process.env`（运行期动态注入）
 *
 * 所有密钥只允许在这里被读取，绝不下发到浏览器。
 */
export function readEnv(...names: string[]): string {
	const runtimeEnv = import.meta.env as unknown as Record<string, unknown>;

	for (const name of names) {
		const fromImportMeta = runtimeEnv?.[name];
		if (typeof fromImportMeta === "string" && fromImportMeta.trim()) {
			return fromImportMeta.trim();
		}

		const fromProcess = (
			globalThis as unknown as {
				process?: { env?: Record<string, string | undefined> };
			}
		).process?.env?.[name];
		if (typeof fromProcess === "string" && fromProcess.trim()) {
			return fromProcess.trim();
		}
	}

	return "";
}
