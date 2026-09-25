<script lang="ts">
import { readStoredDevCredential } from "@utils/dev-auth-client";
import {
	clearFestivalPreview,
	emitFestivalSettingsChange,
	type FestivalFlags,
	normalizeFestivalFlags,
	readFestivalPreview,
	writeFestivalPreview,
} from "@utils/festival-settings";
import { getDeveloperModeEnabled } from "@utils/setting-utils";
import { onMount } from "svelte";
import buildFlags from "../../data/festival.json";

type StatusKind = "info" | "success" | "error";

type Status = {
	kind: StatusKind;
	text: string;
};

// 构建期打包进来的配置，作为首屏默认值
const BUILD_FLAGS: FestivalFlags = {
	midAutumn: buildFlags.midAutumn,
	newYear: buildFlags.newYear,
};

let devEnabled = false;
let loading = true;
let saving = false;
let flags: FestivalFlags = { ...BUILD_FLAGS };
let remoteFlags: FestivalFlags = { ...BUILD_FLAGS };
let status: Status = { kind: "info", text: "" };
let previewActive = false;

$: dirty =
	flags.midAutumn !== remoteFlags.midAutumn ||
	flags.newYear !== remoteFlags.newYear;

function describeFlags(value: FestivalFlags): string {
	if (value.midAutumn) return "中秋效果已开启";
	if (value.newYear) return "春节效果已开启";
	return "全部关闭";
}

function refreshPreviewState() {
	previewActive = readFestivalPreview() !== null;
}

function setStatus(kind: StatusKind, text: string) {
	status = { kind, text };
}

// 两个效果互斥：开启一个会自动关掉另一个
function toggleMidAutumn() {
	flags = flags.midAutumn
		? { midAutumn: false, newYear: false }
		: { midAutumn: true, newYear: false };
}

function toggleNewYear() {
	flags = flags.newYear
		? { midAutumn: false, newYear: false }
		: { midAutumn: false, newYear: true };
}

async function readResponseFlags(response: Response) {
	const data = (await response.json().catch(() => null)) as {
		ok?: boolean;
		message?: string;
		flags?: unknown;
		deployed?: boolean;
	} | null;
	const parsed = data?.flags ? normalizeFestivalFlags(data.flags) : null;
	return { data, parsed };
}

async function loadRemote() {
	const credential = readStoredDevCredential();
	if (!credential) {
		loading = false;
		setStatus("error", "没找到开发者口令，请重新解锁");
		return;
	}
	try {
		const response = await fetch(
			`/api/dev/festival?devCodeHash=${encodeURIComponent(credential)}`,
			{ headers: { Accept: "application/json" } },
		);
		const { data, parsed } = await readResponseFlags(response);
		if (!response.ok || !data?.ok || !parsed) {
			setStatus("error", data?.message || `读取失败（${response.status}）`);
			return;
		}
		remoteFlags = parsed;
		flags = { ...parsed };
		setStatus("info", `线上：${describeFlags(parsed)}`);
	} catch {
		setStatus("error", "读取失败，请检查网络");
	} finally {
		loading = false;
	}
}

async function save() {
	const credential = readStoredDevCredential();
	if (!credential) {
		setStatus("error", "没找到开发者口令，请重新解锁");
		return;
	}
	saving = true;
	try {
		const response = await fetch("/api/dev/festival", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ ...flags, devCodeHash: credential }),
		});
		const { data, parsed } = await readResponseFlags(response);
		if (!response.ok || !data?.ok || !parsed) {
			setStatus("error", data?.message || `保存失败（${response.status}）`);
			return;
		}

		remoteFlags = parsed;
		flags = { ...parsed };
		// 先在本机即时生效，访客等部署完成
		writeFestivalPreview(parsed);
		emitFestivalSettingsChange();
		refreshPreviewState();

		if (data.deployed) {
			setStatus("success", "已提交，全站约 1~2 分钟后生效");
		} else {
			setStatus("success", "已保存到本地（未触发部署）");
		}
	} catch {
		setStatus("error", "保存失败，请检查网络");
	} finally {
		saving = false;
	}
}

function clearPreview() {
	clearFestivalPreview();
	emitFestivalSettingsChange();
	refreshPreviewState();
	setStatus("info", "已清除本机预览");
}

onMount(() => {
	devEnabled = getDeveloperModeEnabled();
	refreshPreviewState();
	if (!devEnabled) {
		loading = false;
		return;
	}
	void loadRemote();
});
</script>

<div class="card-base festival-settings onload-animation">
	<h2 class="festival-title">节日效果</h2>
	<p class="festival-hint">同时只生效一个，保存后本机立即生效。</p>

	{#if !devEnabled}
		<p class="festival-hint">请先在「背景设置」面板输入口令解锁开发者模式。</p>
	{:else}
		<div class="festival-list">
			<div class="festival-row">
				<span class="festival-name">中秋效果 🌕</span>
				<button
					type="button"
					class="festival-switch"
					class:is-on={flags.midAutumn}
					role="switch"
					aria-checked={flags.midAutumn}
					aria-label="中秋效果"
					disabled={loading || saving}
					on:click={toggleMidAutumn}
				>
					<span class="festival-switch-knob"></span>
				</button>
			</div>

			<div class="festival-row">
				<span class="festival-name">春节效果 🏮</span>
				<button
					type="button"
					class="festival-switch"
					class:is-on={flags.newYear}
					role="switch"
					aria-checked={flags.newYear}
					aria-label="春节效果"
					disabled={loading || saving}
					on:click={toggleNewYear}
				>
					<span class="festival-switch-knob"></span>
				</button>
			</div>
		</div>

		<div class="festival-actions">
			<button
				class="festival-btn festival-btn-primary"
				type="button"
				disabled={loading || saving || !dirty}
				on:click={save}
			>
				{saving ? "保存中…" : "保存并部署"}
			</button>
			{#if previewActive}
				<button
					class="festival-btn"
					type="button"
					disabled={saving}
					on:click={clearPreview}
				>
					清除本机预览
				</button>
			{/if}
		</div>

		{#if status.text}
			<p
				class="festival-status"
				class:is-error={status.kind === "error"}
				class:is-success={status.kind === "success"}
			>
				{status.text}
			</p>
		{/if}
	{/if}
</div>

<style lang="css">
	.festival-settings {
		padding: 1rem 1.25rem;
		border-radius: 0.75rem;
	}

	.festival-title {
		font-size: 1.0625rem;
		font-weight: 700;
		color: #1f2937;
	}

	.festival-hint {
		font-size: 0.8125rem;
		line-height: 1.5;
		color: rgba(31, 41, 55, 0.62);
	}

	.festival-list {
		margin-top: 0.6rem;
	}

	.festival-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.55rem 0;
	}

	.festival-row + .festival-row {
		border-top: 1px dashed rgba(100, 116, 139, 0.35);
	}

	.festival-name {
		font-size: 0.9375rem;
		font-weight: 600;
		color: #1f2937;
	}

	/* 胶囊开关：颜色跟随主题色 */
	.festival-switch {
		position: relative;
		flex: none;
		width: 2.6rem;
		height: 1.45rem;
		padding: 0;
		border: none;
		border-radius: 9999px;
		background-color: var(--btn-regular-bg-hover);
		cursor: pointer;
		transition: background-color 0.2s ease;
	}

	.festival-switch.is-on {
		background-color: var(--primary);
	}

	.festival-switch:disabled {
		opacity: 0.6;
		cursor: not-allowed;
	}

	.festival-switch-knob {
		position: absolute;
		top: 0.175rem;
		left: 0.175rem;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 9999px;
		background-color: #fff;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.28);
		transition: transform 0.2s ease;
	}

	.festival-switch.is-on .festival-switch-knob {
		transform: translateX(1.15rem);
	}

	.festival-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.9rem;
	}

	/* 按钮：和编辑器里的「提交发布」同款（方圆 12px） */
	.festival-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0.5rem 1.05rem;
		line-height: 1;
		border: 1px solid var(--primary);
		border-radius: 12px;
		background-color: var(--btn-regular-bg);
		color: var(--btn-content);
		font-size: 0.8125rem;
		font-weight: 700;
		cursor: pointer;
		transition:
			transform 0.2s ease,
			background-color 0.2s ease,
			filter 0.2s ease,
			opacity 0.2s ease;
	}

	.festival-btn:hover:not(:disabled) {
		background-color: var(--btn-regular-bg-hover);
		transform: translateY(-1px);
	}

	.festival-btn:disabled {
		opacity: 0.55;
		filter: saturate(0.75);
		cursor: not-allowed;
	}

	.festival-btn-primary {
		background-color: var(--primary);
		color: #fff;
		box-shadow: 0 8px 20px
			color-mix(in oklab, var(--primary) 22%, transparent);
	}

	.festival-btn-primary:hover:not(:disabled) {
		background-color: var(--primary);
		filter: brightness(1.05);
	}

	.festival-status {
		margin-top: 0.75rem;
		font-size: 0.8125rem;
		line-height: 1.5;
		color: rgba(31, 41, 55, 0.72);
	}

	.festival-status.is-error {
		color: #dc2626;
	}

	.festival-status.is-success {
		color: #16a34a;
	}

	/* 深色模式 */
	:global(.dark) .festival-title,
	:global(.dark) .festival-name {
		color: #f3f4f6;
	}

	:global(.dark) .festival-hint {
		color: rgba(243, 244, 246, 0.66);
	}

	:global(.dark) .festival-row + .festival-row {
		border-top-color: rgba(148, 163, 184, 0.3);
	}

	:global(.dark) .festival-status {
		color: rgba(243, 244, 246, 0.72);
	}

	:global(.dark) .festival-status.is-error {
		color: #f87171;
	}

	:global(.dark) .festival-status.is-success {
		color: #4ade80;
	}
</style>
