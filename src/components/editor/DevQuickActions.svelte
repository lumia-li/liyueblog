<script lang="ts">
// 开发者快捷入口：文章编辑器 / 草稿箱 / 垃圾桶
// 从导航栏按钮组里独立出来，挂在它下方的一个小窗口里
import Icon from "@iconify/svelte";
import { getDeveloperModeEnabled } from "@utils/setting-utils";
import { url } from "@utils/url-utils.ts";
import { onMount } from "svelte";
import { fly } from "svelte/transition";

let enabled = false;
/** 默认收起：只有当内容滚动到导航栏附近时才出现 */
let scrolled = false;
const SHOW_AFTER_SCROLL = 40;

const editorHref = url("/editor");
const draftsHref = url("/drafts");
const trashHref = url("/trash");

onMount(() => {
	const refresh = () => {
		enabled = getDeveloperModeEnabled();
	};
	const onChange = (event: Event) => {
		enabled = Boolean((event as CustomEvent<boolean>).detail);
	};
	const onScroll = () => {
		scrolled = (window.scrollY || window.pageYOffset || 0) > SHOW_AFTER_SCROLL;
	};

	refresh();
	onScroll();
	window.addEventListener("developer-mode-change", onChange);
	window.addEventListener("focus", refresh);
	window.addEventListener("scroll", onScroll, { passive: true });

	return () => {
		window.removeEventListener("developer-mode-change", onChange);
		window.removeEventListener("focus", refresh);
		window.removeEventListener("scroll", onScroll);
	};
});
</script>

{#if enabled && scrolled}
	<div
		class="dev-quick-actions"
		transition:fly={{ y: -8, duration: 180 }}
		aria-label="开发者快捷入口"
	>
		<a
			href={editorHref}
			data-no-swup
			class="dev-quick-btn"
			aria-label="文章编辑器"
			title="文章编辑器"
		>
			<Icon icon="fa6-solid:pen" />
		</a>
		<a
			href={draftsHref}
			data-no-swup
			class="dev-quick-btn"
			aria-label="草稿箱"
			title="草稿箱"
		>
			<Icon icon="fa6-solid:box-archive" />
		</a>
		<a
			href={trashHref}
			data-no-swup
			class="dev-quick-btn is-danger"
			aria-label="垃圾桶"
			title="垃圾桶"
		>
			<Icon icon="material-symbols:delete-outline-rounded" />
		</a>
	</div>
{/if}

<style>
	.dev-quick-actions {
		position: absolute;
		top: calc(100% + 14px);
		right: 0;
		z-index: 70;
		display: flex;
		flex-direction: row;
		flex-wrap: nowrap;
		align-items: center;
		gap: 6px;
		padding: 6px;
		border-radius: 14px;
		background: var(--float-panel-bg, var(--card-bg));
		border: 1px solid var(--line-divider);
		box-shadow: 0 16px 36px -24px rgba(0, 0, 0, 0.7);
	}

	.dev-quick-btn {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: 9px;
		color: var(--btn-content);
		background: transparent;
		transition:
			background 0.16s ease,
			color 0.16s ease,
			transform 0.16s ease;
	}

	.dev-quick-btn:hover {
		background: var(--btn-regular-bg-hover, rgba(127, 127, 127, 0.12));
		color: var(--primary);
		transform: translateY(-1px);
	}

	.dev-quick-btn:active {
		transform: translateY(0);
	}

	.dev-quick-btn.is-danger {
		color: #ef4444;
	}

	.dev-quick-btn.is-danger:hover {
		background: rgba(239, 68, 68, 0.14);
		color: #ef4444;
	}
</style>
