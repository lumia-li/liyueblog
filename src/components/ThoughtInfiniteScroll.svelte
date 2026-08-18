<script lang="ts">
	import Icon from "@iconify/svelte";
	import { onMount } from "svelte";
	import { THOUGHTS_BATCH_SIZE } from "../constants/constants";

	interface ThoughtItem {
		slug: string;
		title: string;
		published: string;
		description: string;
		url: string;
	}

	// 首屏已由服务端渲染的条数
	export let startIndex = 0;
	// 随笔总数
	export let total = 0;
	// feed.json 的绝对地址
	export let feedUrl = "";

	let items: ThoughtItem[] = [];
	let loading = false;
	let finished = false;
	let error = "";
	let sentinel: HTMLDivElement | undefined = undefined;
	let observer: IntersectionObserver | null = null;

	$: hasMore = !finished && startIndex + items.length < total;

	async function loadMore(): Promise<void> {
		if (loading || finished || !hasMore) return;
		loading = true;
		error = "";
		try {
			const res = await fetch(feedUrl);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const all: ThoughtItem[] = await res.json();
			const cursor = startIndex + items.length;
			const batch = all.slice(cursor, cursor + THOUGHTS_BATCH_SIZE);
			if (batch.length === 0) {
				finished = true;
				return;
			}
			items = [...items, ...batch];
			if (startIndex + items.length >= total) {
				finished = true;
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	// 不支持 IntersectionObserver 时的降级方案：一次性加载全部
	async function loadAll(): Promise<void> {
		if (loading) return;
		loading = true;
		error = "";
		try {
			const res = await fetch(feedUrl);
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`);
			}
			const all: ThoughtItem[] = await res.json();
			items = all.slice(startIndex);
			finished = true;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		if (typeof window === "undefined") return;

		if (!("IntersectionObserver" in window)) {
			void loadAll();
			return;
		}

		observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						void loadMore();
					}
				}
			},
			{ rootMargin: "200px 0px" },
		);

		if (sentinel) {
			observer.observe(sentinel);
		}

		// Swup 切换页面销毁组件时清理监听，避免事件/观察器重复绑定
		return () => {
			observer?.disconnect();
			observer = null;
		};
	});
</script>

<div class="flex flex-col gap-4">
	{#each items as item (item.slug)}
		<a
			href={item.url}
			aria-label={item.title || "随笔"}
			class="card-base group flex flex-col w-full rounded-[var(--radius-large)] overflow-hidden relative px-6 py-6 md:px-9 md:py-7 hover:bg-[var(--btn-card-bg-hover)] active:bg-[var(--btn-card-bg-active)]"
		>
			<div class="flex items-center justify-between mb-3">
				<div class="flex items-center">
					<div class="meta-icon">
						<Icon icon="material-symbols:calendar-today-outline-rounded" class="text-xl"></Icon>
					</div>
					<span class="text-50 text-sm font-medium">{item.published}</span>
				</div>
				<Icon
					icon="material-symbols:chevron-right-rounded"
					class="text-[2rem] text-[var(--primary)] transition opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0"
				></Icon>
			</div>

			{#if item.title}
				<h2 class="text-xl font-bold text-90 mb-2 group-hover:text-[var(--primary)] transition">{item.title}</h2>
			{/if}

			{#if item.description}
				<p class="text-75 line-clamp-2">{item.description}</p>
			{/if}
		</a>
	{/each}

	{#if hasMore}
		<div bind:this={sentinel} class="w-full h-px" aria-hidden="true"></div>
	{/if}

	{#if loading}
		<div class="text-center text-50 text-sm py-6">加载中…</div>
	{/if}

	{#if finished && items.length > 0}
		<div class="text-center text-50 text-sm py-6">已经到底啦～</div>
	{/if}

	{#if error}
		<div class="text-center text-red-500 dark:text-red-400 text-sm py-6">加载失败：{error}</div>
	{/if}
</div>
