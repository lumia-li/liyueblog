function normalizePostId(postId: string): string {
	return postId.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function postIdToSlug(postId: string): string {
	let normalized = normalizePostId(postId);
	for (const root of ["src/content/posts/", "src/content/thoughts/"]) {
		if (normalized.startsWith(root)) {
			normalized = normalized.slice(root.length);
			break;
		}
	}
	normalized = normalized.replace(/\.md$/i, "");
	if (normalized.endsWith("/index")) {
		normalized = normalized.slice(0, -"/index".length);
	}
	return normalized;
}

function buildEncodedPath(slug: string, kind: "post" | "thought"): string {
	const encodedSlug = slug
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
	return kind === "thought" ? `/thoughts/${encodedSlug}/` : `/posts/${encodedSlug}/`;
}

function buildMarkers(
	postIds: string[],
	titles: string[],
	kind: "post" | "thought",
): string[] {
	const markers = new Set<string>();
	for (const postId of postIds) {
		const slug = postIdToSlug(postId);
		if (!slug) continue;
		markers.add(buildEncodedPath(slug, kind));
	}
	for (const title of titles) {
		const trimmed = title.trim();
		if (!trimmed) continue;
		markers.add(trimmed);
	}
	return [...markers];
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

export async function waitForPostsToDisappear(params: {
	pageUrl: string;
	postIds: string[];
	titles?: string[];
	kind?: "post" | "thought";
	timeoutMs?: number;
	intervalMs?: number;
}): Promise<boolean> {
	if (typeof window === "undefined" || typeof fetch === "undefined") {
		return false;
	}

	const kind = params.kind || "post";
	const markers = buildMarkers(params.postIds, params.titles || [], kind);
	if (markers.length < 1) {
		return true;
	}

	const timeoutMs = params.timeoutMs ?? 25_000;
	const intervalMs = params.intervalMs ?? 700;
	const deadline = Date.now() + timeoutMs;
	const targetUrl = new URL(params.pageUrl, window.location.origin);

	while (Date.now() < deadline) {
		try {
			const probeUrl = new URL(targetUrl.toString());
			probeUrl.searchParams.set("__dev_wait", String(Date.now()));
			const response = await fetch(probeUrl.toString(), {
				method: "GET",
				cache: "no-store",
				headers: {
					"Cache-Control": "no-cache, no-store, max-age=0",
					Pragma: "no-cache",
				},
			});

			if (response.ok) {
				const html = await response.text();
				const stillPresent = markers.some((marker) => html.includes(marker));
				if (!stillPresent) {
					return true;
				}
			}
		} catch {
			// Ignore transient probe failures and retry until timeout.
		}

		await delay(intervalMs);
	}

	return false;
}
