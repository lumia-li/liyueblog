<script lang="ts">
import Icon from "@iconify/svelte";
import { saveDraft } from "@utils/dev-draft-utils";
import { getDeveloperModeEnabled } from "@utils/setting-utils";
import { onMount } from "svelte";

export let type: "post" | "thought" = "post";
export let title = "";
export let slug = "";
export let content = "";
export let description = "";
export let tags: string[] = [];
export let category = "";
export let image = "";
export let draft = false;
export let published = "";
export let compact = false;

let developerModeEnabled = false;
let notice = "";
let noticeType: "info" | "success" | "error" = "info";

function showNotice(message: string, type: "info" | "success" | "error") {
	notice = message;
	noticeType = type;
	window.setTimeout(() => {
		if (notice === message) {
			notice = "";
		}
	}, 2200);
}

function refreshDeveloperMode() {
	developerModeEnabled = getDeveloperModeEnabled();
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}

function buildDraftId(): string {
	const base = slugify(slug || title) || `post-${Date.now()}`;
	if (type === "thought") {
		return `published-edit-thought-${base}`;
	}
	return `published-edit-${base}`;
}

function editAndRepublish() {
	if (!developerModeEnabled) {
		showNotice("开发者模式未开启", "error");
		return;
	}
	if (!slug || !title || !content.trim()) {
		showNotice("当前文章信息不完整，无法进入编辑", "error");
		return;
	}
	const draftId = buildDraftId();
	saveDraft({
		id: draftId,
		type,
		title,
		slug,
		originalSlug: slug,
		description,
		tags: tags.join(", "),
		category,
		image,
		draft,
		content,
		published,
	});
	showNotice("已载入编辑器草稿", "success");
	window.location.href = `/editor?id=${encodeURIComponent(draftId)}`;
}

refreshDeveloperMode();

onMount(() => {
	const handleDeveloperModeChange = (event: Event) => {
		developerModeEnabled = Boolean((event as CustomEvent<boolean>).detail);
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
	<div class={compact ? "dev-edit-slot compact" : "dev-edit-slot"}>
		<button
			type="button"
			class="edit-btn"
			aria-label="编辑重发文章"
			title="编辑并重新发布"
			on:click={editAndRepublish}
		>
			<Icon icon="material-symbols:edit-outline-rounded" class="icon" />
			{#if !compact}
				<span>编辑重发</span>
			{/if}
		</button>
		{#if notice}
			<div class={`notice ${noticeType}`}>{notice}</div>
		{/if}
	</div>
{/if}

<style lang="stylus">
.dev-edit-slot
  display inline-flex
  flex-direction column
  align-items flex-end
  flex-shrink 0
  gap 0.36rem

.dev-edit-slot.compact
  justify-content flex-start
  min-width max-content

.edit-btn
  display inline-flex
  align-items center
  justify-content center
  gap 0.25rem
  height 2rem
  min-width 5.2rem
  padding 0 0.62rem
  border 1px solid rgba(59, 130, 246, 0.72)
  border-radius 0.58rem
  color rgba(37, 99, 235, 0.98)
  background rgba(59, 130, 246, 0.1)
  font-size 0.84rem
  font-weight 700
  transition background 0.2s ease, transform 0.2s ease, opacity 0.2s ease

  &:hover
    background rgba(59, 130, 246, 0.18)
    transform translateY(-1px)

.dev-edit-slot.compact .edit-btn
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
