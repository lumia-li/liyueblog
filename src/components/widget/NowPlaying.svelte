<script lang="ts">
	import type { NowPlayingState } from "@utils/nowplaying-settings";

	type Snapshot = { state: NowPlayingState; receivedAt: number };

	// 接口刷新间隔：状态只在换歌 / 播放暂停时变化，不需要太频繁
	const REFRESH_MS = 15000;
	// 暂停后超过这个时长仍无新上报，就认为 MusicBar 已经不在了
	// （正常关闭程序时会上报一次「已停止」，这里只是休眠 / 强制关机的兜底）
	const OFFLINE_TIMEOUT_MS = 60 * 60 * 1000;

	let snapshot = $state<Snapshot | null>(null);
	let clock = $state(Date.now());

	function formatTime(ms: number): string {
		const totalSeconds = Math.max(0, Math.floor(ms / 1000));
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		return `${minutes}:${seconds.toString().padStart(2, "0")}`;
	}

	async function refresh(): Promise<void> {
		try {
			const response = await fetch("/api/nowplaying", {
				headers: { accept: "application/json" },
			});
			if (!response.ok) return;
			const payload = (await response.json()) as { state?: NowPlayingState };
			const state = payload?.state;
			if (!state || typeof state.title !== "string") return;
			snapshot = { state, receivedAt: Date.now() };
		} catch {
			// 网络异常时保留上一份数据，让推算进度自然走到头
		}
	}

	$effect(() => {
		refresh();
		const refreshTimer = setInterval(refresh, REFRESH_MS);
		const clockTimer = setInterval(() => {
			clock = Date.now();
		}, 1000);
		return () => {
			clearInterval(refreshTimer);
			clearInterval(clockTimer);
		};
	});

	const view = $derived.by(() => {
		const current = snapshot;
		if (!current) return null;

		const { state, receivedAt } = current;
		if (!state.title) return null;

		// 进度本地推算：拿到「上报时的位置 + 是否在播」就够，不必高频上报
		const elapsed = state.isPlaying ? Math.max(0, clock - receivedAt) : 0;
		const position = state.positionMs + elapsed;

		// 播放中但推算位置早已越过总时长 → MusicBar 已经停止上报
		if (
			state.isPlaying &&
			state.durationMs > 0 &&
			position > state.durationMs + 60_000
		) {
			return null;
		}
		// 暂停后长时间没有新上报（比如关掉了 MusicBar）同样按离线处理
		if (
			!state.isPlaying &&
			clock - Date.parse(state.updatedAt) > OFFLINE_TIMEOUT_MS
		) {
			return null;
		}

		const ratio =
			state.durationMs > 0 ? Math.min(1, position / state.durationMs) : 0;
		return {
			title: state.title,
			artist: state.artist,
			coverUrl: state.coverUrl,
			isPlaying: state.isPlaying,
			percent: Math.max(0, ratio) * 100,
			timeText:
				state.durationMs > 0
					? `${formatTime(Math.min(position, state.durationMs))} / ${formatTime(state.durationMs)}`
					: "",
		};
	});
</script>

{#if view}
	<div class="now-playing">
		<div class="head">
			<span class="dot" class:playing={view.isPlaying}></span>
			<span class="label">{view.isPlaying ? "正在播放" : "已暂停"}</span>
			{#if view.timeText}<span class="time">{view.timeText}</span>{/if}
		</div>

		<div class="body">
			{#if view.coverUrl}
				<img
					class="cover"
					src={view.coverUrl}
					alt=""
					loading="lazy"
					referrerpolicy="no-referrer"
				/>
			{:else}
				<div class="cover placeholder" aria-hidden="true">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
						<path d="M9 18V6l10-2v12" stroke-linecap="round" stroke-linejoin="round" />
						<circle cx="6.5" cy="18" r="2.5" />
						<circle cx="16.5" cy="16" r="2.5" />
					</svg>
				</div>
			{/if}
			<div class="meta">
				<div class="title" title={view.title}>{view.title}</div>
				{#if view.artist}<div class="artist" title={view.artist}>{view.artist}</div>{/if}
			</div>
		</div>

		<div class="bar"><i style={`width:${view.percent}%`}></i></div>
	</div>
{/if}

<style>
	.now-playing {
		border-radius: 12px;
		padding: 0.85rem 0.9rem;
		background: rgba(128, 128, 128, 0.12);
		backdrop-filter: blur(6px);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 0.45rem;
		font-size: 0.72rem;
		opacity: 0.65;
		margin-bottom: 0.6rem;
	}

	.dot {
		width: 0.42rem;
		height: 0.42rem;
		border-radius: 50%;
		background: currentColor;
		opacity: 0.4;
		flex: none;
	}

	.dot.playing {
		opacity: 1;
		background: #34c759;
		animation: np-pulse 1.8s ease-in-out infinite;
	}

	@keyframes np-pulse {
		0%,
		100% {
			transform: scale(1);
			opacity: 1;
		}
		50% {
			transform: scale(1.35);
			opacity: 0.55;
		}
	}

	.label {
		font-weight: 500;
	}

	.time {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		opacity: 0.85;
	}

	.body {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: 0;
	}

	.cover {
		width: 3rem;
		height: 3rem;
		border-radius: 8px;
		object-fit: cover;
		flex: none;
		background: rgba(128, 128, 128, 0.18);
	}

	.cover.placeholder {
		display: grid;
		place-items: center;
	}

	.cover.placeholder svg {
		width: 55%;
		height: 55%;
		opacity: 0.45;
	}

	.meta {
		min-width: 0;
	}

	.title {
		font-size: 0.86rem;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.artist {
		font-size: 0.75rem;
		opacity: 0.62;
		margin-top: 0.15rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.bar {
		height: 3px;
		margin-top: 0.7rem;
		border-radius: 2px;
		background: rgba(128, 128, 128, 0.25);
		overflow: hidden;
	}

	.bar i {
		display: block;
		height: 100%;
		border-radius: 2px;
		background: currentColor;
		opacity: 0.55;
		transition: width 1s linear;
	}
</style>
