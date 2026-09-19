<script lang="ts">
	import Icon from "@iconify/svelte";
	import { onMount } from "svelte";

	export let buttonLabel = "填写申请表单";
	export let title = "申请友链";
	export let description = "";
	export let endpoint = "/api/friend-apply";

	let dialog: HTMLDialogElement | undefined;
	let nameInput: HTMLInputElement | undefined;

	let siteName = "";
	let siteUrl = "";
	let intro = "";
	let avatar = "";
	let backlink = "";
	let contact = "";
	let website = ""; // 蜜罐字段：正常访客看不见，机器人会填

	let submitting = false;
	let errorMessage = "";
	let success = false;
	/** 服务端自动检测的提示（站点/头像可达性、双向链接） */
	let warnings: string[] = [];
	/** update = 这次提交的是对「已通过友链」的信息更新 */
	let submittedState = "";

	$: canSubmit =
		!submitting &&
		siteName.trim() !== "" &&
		siteUrl.trim() !== "" &&
		intro.trim() !== "";

	const inputClass =
		"w-full h-10 rounded-lg px-3 text-sm bg-[var(--btn-regular-bg)] text-90 " +
		"placeholder:text-black/25 dark:placeholder:text-white/25 border border-transparent " +
		"outline-none transition focus:border-[var(--primary)]";

	function openDialog() {
		errorMessage = "";
		success = false;
		warnings = [];
		submittedState = "";
		// 用原生 <dialog>.showModal()：渲染在 top layer，
		// 不受页面里 will-change: transform 容器的影响
		dialog?.showModal();
		requestAnimationFrame(() => nameInput?.focus());
	}

	function closeDialog() {
		if (submitting) return;
		dialog?.close();
	}

	// 点击遮罩关闭：必须「按下」和「抬起」都落在弹窗外层（dialog 自身铺满全屏，
	// 面板居中）才算真正点了遮罩。
	// 只判断 click 的 target 是不够的：在输入框里按住左键拖选文本时，
	// click 的 target 会变成 mousedown/mouseup 的共同祖先——也就是 dialog 本身，
	// 于是弹窗会在拖选文字的过程中被误关。
	let pressedOnBackdrop = false;

	function handleDialogMouseDown(event: MouseEvent) {
		pressedOnBackdrop = event.target === dialog;
	}

	function handleDialogMouseUp(event: MouseEvent) {
		const releasedOnBackdrop = event.target === dialog;
		if (pressedOnBackdrop && releasedOnBackdrop) {
			pressedOnBackdrop = false;
			closeDialog();
		}
	}

	async function submit() {
		if (!canSubmit) return;
		submitting = true;
		errorMessage = "";
		try {
			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: siteName,
					url: siteUrl,
					avatar,
					backlink,
					contact,
					description: intro,
					website,
				}),
			});
			const data = (await response.json().catch(() => null)) as {
				ok?: boolean;
				message?: string;
				statusToken?: string;
				state?: string;
				warnings?: string[];
			} | null;

			if (!response.ok || !data?.ok) {
				errorMessage =
					data?.message || `提交失败（HTTP ${response.status}），请稍后再试`;
				return;
			}

			success = true;
			submittedState = data.state === "update" ? "update" : "pending";
			warnings = Array.isArray(data.warnings) ? data.warnings : [];

			// 存下查询凭证，友链页顶部的状态条靠它显示「审核中 / 已通过 / 未通过」
			try {
				if (data.statusToken) {
					localStorage.setItem(
						"friendApplyRecord",
						JSON.stringify({
							token: data.statusToken,
							url: siteUrl,
							name: siteName,
							at: Date.now(),
							state: submittedState,
						}),
					);
					window.dispatchEvent(new CustomEvent("friend-apply-submitted"));
				}
			} catch {
				// 隐私模式等场景 localStorage 不可用，忽略即可，不影响提交结果
			}

			siteName = "";
			siteUrl = "";
			avatar = "";
			backlink = "";
			contact = "";
			intro = "";
		} catch {
			errorMessage = "网络异常，提交失败，请稍后再试";
		} finally {
			submitting = false;
		}
	}

	onMount(() => {
		return () => {
			// Swup 切页销毁组件时把弹窗一起关掉，避免残留遮罩
			dialog?.close();
		};
	});
</script>

<button
	type="button"
	class="btn-regular rounded-lg h-10 px-4 gap-2 text-sm font-bold active:scale-95"
	onclick={openDialog}
>
	<Icon icon="fa6-solid:pen-to-square" class="text-[1.125rem]"></Icon>
	<span>{buttonLabel}</span>
</button>

<dialog
	bind:this={dialog}
	class="friend-apply-dialog"
	onmousedown={handleDialogMouseDown}
	onmouseup={handleDialogMouseUp}
>
	<div class="friend-apply-panel p-5 md:p-6">
		<div class="flex items-start justify-between gap-4">
			<h3 class="text-lg font-bold text-90 pt-1">{title}</h3>
			<button
				type="button"
				aria-label="关闭"
				class="nav-icon-btn h-9 w-9 shrink-0 active:scale-90"
				onclick={closeDialog}
			>
				<Icon icon="fa6-solid:xmark" class="text-[1.125rem]"></Icon>
			</button>
		</div>

		{#if description}
			<p class="text-75 text-sm mt-2 mb-4">{description}</p>
		{/if}

		{#if success}
			<div class="flex flex-col items-center gap-3 py-6 text-center">
				<Icon icon="fa6-solid:circle-check" class="text-[2.5rem] text-[var(--primary)]"></Icon>
				<div class="text-90 font-bold">
					{submittedState === "update" ? "信息更新已提交！" : "申请已提交！"}
				</div>
				<p class="text-75 text-sm">
					{submittedState === "update"
						? "你的站点已经在友链列表里了，这次是信息更新：审核通过后列表会自动换成新信息。"
						: "会尽快审核，通过后你的站点就会出现在友链列表里~"}
				</p>

				<!-- 服务端自动检测的结果：只提示，不影响提交 -->
				{#if warnings.length > 0}
					<div class="w-full flex flex-col gap-2 text-left">
						{#each warnings as warning}
							<div class="flex items-start gap-2 text-xs text-75">
								<Icon
									icon="fa6-solid:circle-info"
									class="mt-0.5 shrink-0 text-[var(--primary)]"
								></Icon>
								<span>{warning}</span>
							</div>
						{/each}
					</div>
				{/if}

				<p class="text-30 text-xs">页面顶部会显示审核进度，不用守在这里等</p>
				<button
					type="button"
					class="btn-regular rounded-lg h-9 px-4 text-sm font-bold mt-2 active:scale-95"
					onclick={closeDialog}
				>关闭</button>
			</div>
		{:else}
			<form
				class="flex flex-col gap-3"
				onsubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<label class="flex flex-col gap-1.5">
					<span class="text-75 text-xs font-medium">名称 <span class="text-red-400">*</span></span>
					<input
						bind:value={siteName}
						bind:this={nameInput}
						type="text"
						maxlength="40"
						placeholder="博客名称"
						class={inputClass}
					/>
				</label>

				<label class="flex flex-col gap-1.5">
					<span class="text-75 text-xs font-medium">简介 <span class="text-red-400">*</span></span>
					<input
						bind:value={intro}
						type="text"
						maxlength="80"
						placeholder="博客简介"
						class={inputClass}
					/>
				</label>

				<label class="flex flex-col gap-1.5">
					<span class="text-75 text-xs font-medium">链接 <span class="text-red-400">*</span></span>
					<input
						bind:value={siteUrl}
						type="url"
						maxlength="200"
						placeholder="https://example.com/"
						class={inputClass}
					/>
				</label>

				<label class="flex flex-col gap-1.5">
					<span class="text-75 text-xs font-medium">
						头像
						<span class="text-30">（可选，建议填原图直链）</span>
					</span>
					<input
						bind:value={avatar}
						type="url"
						maxlength="300"
						placeholder="https://example.com/avatar.png"
						class={inputClass}
					/>
				</label>

				<label class="flex flex-col gap-1.5">
					<span class="text-75 text-xs font-medium">
						友链页
						<span class="text-30">（可选，填了自动确认双向链接）</span>
					</span>
					<input
						bind:value={backlink}
						type="url"
						maxlength="200"
						placeholder="https://example.com/friends/"
						class={inputClass}
					/>
				</label>

				<label class="flex flex-col gap-1.5">
					<span class="text-75 text-xs font-medium">
						联系方式
						<span class="text-30">（可选，方便审核时联系你）</span>
					</span>
					<input
						bind:value={contact}
						type="text"
						maxlength="60"
						placeholder="邮箱 / QQ / GitHub"
						class={inputClass}
					/>
				</label>

				<!-- 蜜罐：正常访客看不到 -->
				<div class="friend-apply-honeypot" aria-hidden="true">
					<label>
						网址
						<input bind:value={website} type="text" tabindex="-1" autocomplete="off" />
					</label>
				</div>

				{#if errorMessage}
					<div class="flex items-start gap-2 text-sm text-red-500 dark:text-red-400">
						<Icon icon="fa6-solid:triangle-exclamation" class="mt-0.5 shrink-0"></Icon>
						<span>{errorMessage}</span>
					</div>
				{/if}

				<div class="flex items-center justify-end gap-2 mt-1">
					<button
						type="button"
						class="btn-regular rounded-lg h-10 px-4 text-sm font-bold active:scale-95"
						onclick={closeDialog}
					>取消</button>
					<button
						type="submit"
						disabled={!canSubmit}
						class="btn-regular rounded-lg h-10 px-4 gap-2 text-sm font-bold active:scale-95 disabled:opacity-50 disabled:pointer-events-none"
					>
						{#if submitting}
							<Icon icon="fa6-solid:spinner" class="text-[1.125rem] animate-spin"></Icon>
							<span>提交中…</span>
						{:else}
							<Icon icon="fa6-solid:paper-plane" class="text-[1.125rem]"></Icon>
							<span>提交申请</span>
						{/if}
					</button>
				</div>
			</form>
		{/if}
	</div>
</dialog>

<style>
	/* 弹窗铺满视口，面板居中——这样点击四周空白就能关闭 */
	dialog.friend-apply-dialog {
		border: none;
		background: transparent;
		color: inherit;
		padding: 1rem;
	}

	dialog.friend-apply-dialog[open] {
		display: flex;
		align-items: center;
		justify-content: center;
		position: fixed;
		inset: 0;
		width: 100%;
		max-width: none;
		height: 100%;
		max-height: none;
		margin: 0;
	}

	dialog.friend-apply-dialog::backdrop {
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(3px);
	}

	.friend-apply-panel {
		width: min(30rem, 100%);
		max-height: min(85vh, 44rem);
		overflow-y: auto;
		background: var(--card-bg);
		border-radius: var(--radius-large);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.35);
	}

	.friend-apply-honeypot {
		position: absolute;
		left: -9999px;
		width: 1px;
		height: 1px;
		overflow: hidden;
		opacity: 0;
	}
</style>
