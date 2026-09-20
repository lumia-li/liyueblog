<script lang="ts">
	import Icon from "@iconify/svelte";
	import { onMount } from "svelte";
	import { checkFriendDescription, checkFriendName } from "../utils/friend-text";

	export let buttonLabel = "填写申请表单";
	export let title = "申请友链";
	export let description = "";
	export let endpoint = "/api/friend-apply";
	/** 链接体检接口：填完链接失焦 / 点提交时先查一次（见 src/pages/api/friend-link-check.ts） */
	export let checkEndpoint = "/api/friend-link-check";

	let dialog: HTMLDialogElement | undefined;
	let nameInput: HTMLInputElement | undefined;

	let siteName = "";
	let siteUrl = "";
	let intro = "";
	let avatar = "";
	let backlink = "";
	let website = ""; // 蜜罐字段：正常访客看不见，机器人会填
	/** 本次提交有没有填「友链页」（提交时先记下来，因为成功后输入框会被清空） */
	let submittedWithoutBacklink = false;

	let submitting = false;
	let errorMessage = "";
	let success = false;
	/** 服务端自动检测的提示（站点/头像可达性、双向链接） */
	let warnings: string[] = [];
	/** update = 这次提交的是对「已通过友链」的信息更新 */
	let submittedState = "";

	// ── 链接体检：结论显示在对应输入框下方 ──────────────────────
	type FieldCheck = { level: "pass" | "note" | "error"; message?: string };
	type CheckField = "url" | "avatar" | "backlink";

	let fieldChecks: Partial<Record<CheckField, FieldCheck>> = {};
	let checkingLinks = false;
	/** 自动抓取填进头像框的那个地址（换站点时跟着清掉，避免留着别人家的图） */
	let autoFilledAvatar = "";

	function clearCheck(field: CheckField) {
		if (!fieldChecks[field]) return;
		const next = { ...fieldChecks };
		delete next[field];
		fieldChecks = next;
	}

	async function checkLinks(fields: CheckField[] = ["url", "avatar", "backlink"]) {
		const payload: Record<string, string> = {};
		if (fields.includes("url") && siteUrl.trim()) payload.url = siteUrl.trim();
		if (fields.includes("avatar") && avatar.trim()) payload.avatar = avatar.trim();
		if (fields.includes("backlink") && backlink.trim()) payload.backlink = backlink.trim();

		// 被清空的字段顺手把旧结论也去掉
		const next = { ...fieldChecks };
		for (const field of fields) {
			if (!payload[field]) delete next[field];
		}
		fieldChecks = next;
		if (Object.keys(payload).length === 0) return;

		checkingLinks = true;
		try {
			const response = await fetch(checkEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const data = (await response.json().catch(() => null)) as {
				ok?: boolean;
				fields?: Partial<Record<CheckField, FieldCheck>>;
				avatarSuggestion?: { url: string; source: string };
			} | null;
			if (!response.ok || !data?.ok || !data.fields) return;

			// 没填头像 → 把抓来的图填进输入框（填完静默验证一次，打不开就撤回）
			if (data.avatarSuggestion?.url && !avatar.trim() && fields.includes("url")) {
				await applyAvatarSuggestion(data.avatarSuggestion.url);
			}

			fieldChecks = { ...fieldChecks, ...data.fields };
		} catch {
			// 检测接口挂了不拦着用户填表：提交时服务端还会再查一遍
		} finally {
			checkingLinks = false;
		}
	}

	/**
	 * 把自动抓到的头像填进输入框。
	 * 填完先静默验证一次：确认能打开才留着；打不开就直接撤掉，
	 * 不给申请人弹任何提示（这图不是他填的，不该让他负责）。
	 */
	async function applyAvatarSuggestion(url: string) {
		avatar = url;
		autoFilledAvatar = url;
		try {
			const response = await fetch(checkEndpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ avatar: url }),
			});
			const data = (await response.json().catch(() => null)) as {
				ok?: boolean;
				fields?: Partial<Record<CheckField, FieldCheck>>;
			} | null;
			if (!response.ok || !data?.ok || data.fields?.avatar?.level !== "pass") {
				avatar = "";
				autoFilledAvatar = "";
			}
		} catch {
			avatar = "";
			autoFilledAvatar = "";
		}
	}

	/** 改站点地址时，顺手把"上一个站点自动抓来的头像"清掉 */
	function onUrlInput() {
		clearCheck("url");
		if (autoFilledAvatar && avatar === autoFilledAvatar) {
			avatar = "";
			autoFilledAvatar = "";
		}
	}

	// ── 名称 / 简介的本地检测（规则与后端共用 utils/friend-text.ts）──────
	type TextField = "name" | "description";
	let textChecks: Partial<Record<TextField, string>> = {};

	function validateText(field: TextField) {
		const result = field === "name" ? checkFriendName(siteName) : checkFriendDescription(intro);
		const next = { ...textChecks };
		if (result.ok) delete next[field];
		else next[field] = result.message;
		textChecks = next;
	}

	function clearTextCheck(field: TextField) {
		if (!textChecks[field]) return;
		const next = { ...textChecks };
		delete next[field];
		textChecks = next;
	}

	/** 有「确定有问题」的字段时不许提交（note 只是提示，不拦） */
	const hasBlockingError = (checks: Partial<Record<CheckField, FieldCheck>> = fieldChecks) =>
		Object.values(checks).some((check) => check?.level === "error");

	$: hasTextError = Object.keys(textChecks).length > 0;

	$: canSubmit =
		!submitting &&
		!checkingLinks &&
		siteName.trim() !== "" &&
		siteUrl.trim() !== "" &&
		intro.trim() !== "" &&
		!hasTextError &&
		!hasBlockingError(fieldChecks);

	const inputClass =
		"w-full h-10 rounded-lg px-3 text-sm bg-[var(--btn-regular-bg)] text-90 " +
		"placeholder:text-black/25 dark:placeholder:text-white/25 border border-transparent " +
		"outline-none transition focus:border-[var(--primary)]";

	function openDialog() {
		errorMessage = "";
		success = false;
		warnings = [];
		submittedState = "";
		fieldChecks = {};
		textChecks = {};
		submittedWithoutBacklink = false;
		// 用原生 <dialog>.showModal()：渲染在 top layer，
		// 不受页面里 will-change: transform 容器的影响
		dialog?.showModal();
		requestAnimationFrame(() => nameInput?.focus());
	}

	function closeDialog() {
		if (submitting) return;
		dialog?.close();
	}

	async function submit() {
		if (submitting) return;
		submitting = true;
		errorMessage = "";
		try {
			// ① 先查名称 / 简介的文本，再查链接：任一有问题就停在这一步，不触发申请
			validateText("name");
			validateText("description");
			if (Object.keys(textChecks).length > 0) return;

			await checkLinks();
			if (hasBlockingError()) return;

			const response = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: siteName,
					url: siteUrl,
					avatar,
					backlink,
					description: intro,
					website,
				}),
			});
			const data = (await response.json().catch(() => null)) as {
				ok?: boolean;
				message?: string;
				/** 服务端把不合格的字段挂在这里：链接类是 url/avatar/backlink，文本类是 name/description */
				field?: CheckField | TextField;
				statusToken?: string;
				state?: string;
				warnings?: string[];
			} | null;

			if (!response.ok || !data?.ok) {
				// 名称 / 简介没过（服务端兜底）→ 显示到对应输入框下方
				if (data?.field === "name" || data?.field === "description") {
					textChecks = {
						...textChecks,
						[data.field]: data.message || "内容没检测通过",
					};
					return;
				}
				// 链接类的问题同样挂回对应输入框
				if (data?.field) {
					fieldChecks = {
						...fieldChecks,
						[data.field]: { level: "error", message: data.message || "检测没通过" },
					};
					return;
				}
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

			submittedWithoutBacklink = !backlink.trim();
			siteName = "";
			siteUrl = "";
			avatar = "";
			backlink = "";
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

<dialog bind:this={dialog} class="friend-apply-dialog">
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

				{#if submittedWithoutBacklink}
					<div class="flex items-start gap-2 text-xs text-75 text-left">
						<Icon
							icon="fa6-solid:circle-info"
							class="mt-0.5 shrink-0 text-[var(--primary)]"
						></Icon>
						<span>
							你没填「友链页」，审核会慢一点——站长得手动去你的站上确认有没有加回本站。下次填上它会快很多。
						</span>
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
						oninput={() => clearTextCheck("name")}
						onblur={() => validateText("name")}
					/>
					{#if textChecks.name}
						<p class="text-xs leading-5 text-red-500 dark:text-red-400">{textChecks.name}</p>
					{/if}
				</label>

				<label class="flex flex-col gap-1.5">
					<span class="text-75 text-xs font-medium">简介 <span class="text-red-400">*</span></span>
					<input
						bind:value={intro}
						type="text"
						maxlength="80"
						placeholder="博客简介"
						class={inputClass}
						oninput={() => clearTextCheck("description")}
						onblur={() => validateText("description")}
					/>
					{#if textChecks.description}
						<p class="text-xs leading-5 text-red-500 dark:text-red-400">
							{textChecks.description}
						</p>
					{/if}
				</label>

				<label class="flex flex-col gap-1.5">
					<span class="text-75 text-xs font-medium">链接 <span class="text-red-400">*</span></span>
					<input
						bind:value={siteUrl}
						type="url"
						maxlength="200"
						placeholder="https://example.com/"
						class={inputClass}
						oninput={onUrlInput}
						onblur={() => checkLinks(["url"])}
					/>
					{#if fieldChecks.url?.message}
						<p
							class={"text-xs leading-5 " +
								(fieldChecks.url.level === "error"
									? "text-red-500 dark:text-red-400"
									: "text-50")}
						>
							{fieldChecks.url.message}
						</p>
					{/if}
				</label>

				<label class="flex flex-col gap-1.5">
					<span class="text-75 text-xs font-medium">
						头像
						<span class="text-30">（可选，留空会自动从你站点抓一个）</span>
					</span>
					<input
						bind:value={avatar}
						type="url"
						maxlength="300"
						placeholder="https://example.com/avatar.png"
						class={inputClass}
						oninput={() => clearCheck("avatar")}
						onblur={() => checkLinks(["avatar"])}
					/>
					{#if fieldChecks.avatar?.message}
						<p
							class={"text-xs leading-5 " +
								(fieldChecks.avatar.level === "error"
									? "text-red-500 dark:text-red-400"
									: "text-50")}
						>
							{fieldChecks.avatar.message}
						</p>
					{/if}
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
						oninput={() => clearCheck("backlink")}
						onblur={() => checkLinks(["backlink"])}
					/>
					{#if fieldChecks.backlink?.message}
						<p
							class={"text-xs leading-5 " +
								(fieldChecks.backlink.level === "error"
									? "text-red-500 dark:text-red-400"
									: "text-50")}
						>
							{fieldChecks.backlink.message}
						</p>
					{/if}
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
						{#if submitting || checkingLinks}
							<Icon icon="fa6-solid:spinner" class="text-[1.125rem] animate-spin"></Icon>
							<span>{checkingLinks && !submitting ? "检测链接中…" : "提交中…"}</span>
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
