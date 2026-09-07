<script lang="ts">
import DevConfirmDialog from "@components/editor/DevConfirmDialog.svelte";
import Icon from "@iconify/svelte";
import { readStoredDevCredential } from "@utils/dev-auth-client";
import { waitForPostsToDisappear } from "@utils/dev-refresh-wait-client";
import { getDeveloperModeEnabled } from "@utils/setting-utils";
import { url } from "@utils/url-utils";
import { onMount } from "svelte";

type SuccessAction = "reload" | "home" | "thoughts" | "none";

const DEV_EDITOR_SKIP_TRASH_CONFIRM_KEY = "devEditorSkipTrashConfirm";

export let kind: "post" | "thought" = "post";
export let title = "";
export let postId = "";
export let compact = false;
export let afterSuccess: SuccessAction = "reload";

function unitLabel(): string {
	return kind === "thought" ? "随笔" : "文章";
}

let developerModeEnabled = false;
let dialogOpen = false;
let isSubmitting = false;
let notice = "";
let noticeType: "info" | "success" | "error" = "info";
let rememberSkipDeleteConfirm = false;

function showNotice(message: string, type: "info" | "success" | "error") {
	notice = message;
	noticeType = type;
	window.setTimeout(() => {
		if (notice === message) {
			notice = "";
		}
	}, 2600);
}

function refreshDeveloperMode() {
	developerModeEnabled = getDeveloperModeEnabled();
	if (!developerModeEnabled) {
		dialogOpen = false;
	}
}

function shouldSkipTrashConfirm(): boolean {
	try {
		return localStorage.getItem(DEV_EDITOR_SKIP_TRASH_CONFIRM_KEY) === "true";
	} catch (_error) {
		return false;
	}
}

function setSkipTrashConfirm(skip: boolean) {
	try {
		if (skip) {
			localStorage.setItem(DEV_EDITOR_SKIP_TRASH_CONFIRM_KEY, "true");
			return;
		}
		localStorage.removeItem(DEV_EDITOR_SKIP_TRASH_CONFIRM_KEY);
	} catch (_error) {
		// Ignore localStorage write failures.
	}
}

function resetConfirm() {
	if (isSubmitting) return;
	dialogOpen = false;
	rememberSkipDeleteConfirm = false;
}

function beginConfirm() {
	if (isSubmitting) return;
	if (shouldSkipTrashConfirm()) {
		void movePostToTrash();
		return;
	}
	rememberSkipDeleteConfirm = false;
	dialogOpen = true;
}

function handleDeleteConfirm(event: CustomEvent<{ rememberChoice: boolean }>) {
	if (isSubmitting) return;
	dialogOpen = false;
	void movePostToTrash(event.detail.rememberChoice);
}

function readDevCode(): string {
	return readStoredDevCredential();
}

function performSuccessAction() {
	if (afterSuccess === "home") {
		window.location.replace(url("/"));
		return;
	}
	if (afterSuccess === "thoughts") {
		window.location.replace(url("/thoughts/"));
		return;
	}
	window.location.reload();
}

async function runSuccessAction() {
	if (afterSuccess === "none") return;
	const targetUrl =
		afterSuccess === "home"
			? new URL(url("/"), window.location.origin).toString()
			: afterSuccess === "thoughts"
				? new URL(url("/thoughts/"), window.location.origin).toString()
				: window.location.href;
	const waitPromise = waitForPostsToDisappear({
		pageUrl: targetUrl,
		postIds: [postId],
		titles: [title],
		kind,
	});

	if (document.visibilityState !== "visible" || !document.hasFocus()) {
		await waitPromise;
		performSuccessAction();
		return;
	}

	showNotice("正在等待页面更新...", "info");
	await waitPromise;
	performSuccessAction();
}

async function movePostToTrash(rememberChoice = false) {
	if (isSubmitting || !postId) return;

	if (afterSuccess === "home") {
		try {
			window.history.replaceState(window.history.state, "", url("/"));
		} catch (_error) {
			// Ignore history update failures.
		}
	} else if (afterSuccess === "thoughts") {
		try {
			window.history.replaceState(window.history.state, "", url("/thoughts/"));
		} catch (_error) {
			// Ignore history update failures.
		}
	}

	const devCodeHash = readDevCode();
	if (!devCodeHash) {
		showNotice("缺少开发者口令，请重新解锁开发者模式", "error");
		return;
	}

	isSubmitting = true;
	try {
		const response = await fetch("/api/dev/trash", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action: "move",
				kind,
				postId,
				devCodeHash,
			}),
		});
		const payload = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			message?: string;
		};
		if (!response.ok || !payload.ok) {
			throw new Error(payload.message || "移入垃圾桶失败");
		}
		window.dispatchEvent(new CustomEvent("trash-posts-updated"));
		showNotice(`已移入垃圾桶：${title || unitLabel()}`, "success");
		setSkipTrashConfirm(rememberChoice);
		dialogOpen = false;
		await runSuccessAction();
	} catch (error) {
		const message = error instanceof Error ? error.message : "移入垃圾桶失败";
		showNotice(message, "error");
	} finally {
		isSubmitting = false;
	}
}

onMount(() => {
	refreshDeveloperMode();
	const handleDeveloperModeChange = (event: Event) => {
		developerModeEnabled = Boolean((event as CustomEvent<boolean>).detail);
		if (!developerModeEnabled) {
			dialogOpen = false;
		}
	};
	const handleFocus = () => {
		refreshDeveloperMode();
	};
	const handleVisibility = () => {
		if (!document.hidden) {
			refreshDeveloperMode();
		}
	};

	window.addEventListener(
		"developer-mode-change",
		handleDeveloperModeChange as EventListener,
	);
	window.addEventListener("focus", handleFocus);
	document.addEventListener("visibilitychange", handleVisibility);

	return () => {
		window.removeEventListener(
			"developer-mode-change",
			handleDeveloperModeChange as EventListener,
		);
		window.removeEventListener("focus", handleFocus);
		document.removeEventListener("visibilitychange", handleVisibility);
	};
});
</script>

{#if developerModeEnabled}
	<div class={compact ? "dev-delete-slot compact" : "dev-delete-slot"}>
		<button
			type="button"
			class="delete-btn"
			disabled={isSubmitting}
			aria-label={`删除${unitLabel()}`}
			title="移入垃圾桶"
			on:click={beginConfirm}
		>
			<Icon icon="material-symbols:delete-outline-rounded" class="icon" />
			{#if !compact}
				<span>{isSubmitting ? "删除中..." : "删除"}</span>
			{/if}
		</button>
		{#if notice}
			<div class={`notice ${noticeType}`}>{notice}</div>
		{/if}
	</div>

	<DevConfirmDialog
		open={dialogOpen}
		label={`删除${unitLabel()}`}
		title={`确认将《${title || `未命名${unitLabel()}`}》删除吗？`}
		description="内容会先移入垃圾桶，不会立刻彻底删除。"
		note="如果只是普通删除，后续仍可以在垃圾桶中恢复。"
		confirmLabel="确认删除"
		cancelLabel="再想想"
		allowRememberChoice={true}
		bind:rememberChoice={rememberSkipDeleteConfirm}
		rememberChoiceLabel="以后删除文章时不再提醒（不建议）"
		rememberChoiceHint="该选项只会保存在当前浏览器中，后续点击删除会直接移入垃圾桶。"
		tone="danger"
		busy={isSubmitting}
		on:cancel={resetConfirm}
		on:confirm={handleDeleteConfirm}
	/>
{/if}

<style lang="stylus">
.dev-delete-slot
  display inline-flex
  flex-direction column
  align-items flex-end
  flex-shrink 0
  gap 0.36rem

.dev-delete-slot.compact
  justify-content flex-start
  min-width max-content

.delete-btn
  display inline-flex
  align-items center
  justify-content center
  gap 0.25rem
  height 2rem
  min-width 4.8rem
  padding 0 0.6rem
  border 1px solid rgba(239, 68, 68, 0.75)
  border-radius 0.58rem
  color rgba(239, 68, 68, 0.96)
  background rgba(239, 68, 68, 0.08)
  font-size 0.84rem
  font-weight 700
  transition background 0.2s ease, transform 0.2s ease, opacity 0.2s ease

  &:hover
    background rgba(239, 68, 68, 0.16)
    transform translateY(-1px)

  &:disabled
    opacity 0.58
    cursor not-allowed

.dev-delete-slot.compact .delete-btn
  min-width 2rem
  width 2rem
  padding 0

.icon
  font-size 1.1rem

.notice
  font-size 0.76rem
  line-height 1.3
  max-width 13rem
  text-align right

.notice.info
  color var(--btn-content)

.notice.success
  color rgba(34, 197, 94, 0.95)

.notice.error
  color rgba(239, 68, 68, 0.95)
</style>
