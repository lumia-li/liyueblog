<script lang="ts">
import { getDeveloperModeEnabled } from "@utils/setting-utils";
import { url } from "@utils/url-utils";
import { onMount } from "svelte";

interface Props {
	active: "festival" | "editor";
}

export let active: Props["active"];

let devEnabled = false;

onMount(() => {
	devEnabled = getDeveloperModeEnabled();
});
</script>

{#if devEnabled}
	<nav class="dev-console-nav card-base onload-animation">
		<a
			class="dev-console-tab"
			class:is-active={active === "festival"}
			href={url("/dev")}
		>
			节日效果
		</a>
		<a
			class="dev-console-tab"
			class:is-active={active === "editor"}
			href={url("/editor")}
		>
			文章编辑器
		</a>
	</nav>
{/if}

<style lang="css">
	.dev-console-nav {
		display: flex;
		flex-wrap: wrap;
		gap: 0.4rem;
		padding: 0.4rem;
		margin-bottom: 1rem;
		border-radius: 0.5rem;
	}

	.dev-console-tab {
		padding: 0.4rem 0.85rem;
		border-radius: 9999px;
		font-size: 0.875rem;
		font-weight: 600;
		text-decoration: none;
		color: rgba(31, 41, 55, 0.78);
		transition:
			background-color 0.2s ease,
			color 0.2s ease;
	}

	.dev-console-tab:hover {
		background-color: var(--btn-regular-bg-hover);
		color: #1f2937;
	}

	.dev-console-tab.is-active {
		background-color: var(--primary);
		color: #fff;
	}

	:global(.dark) .dev-console-tab {
		color: rgba(243, 244, 246, 0.78);
	}

	:global(.dark) .dev-console-tab:hover {
		color: #f3f4f6;
	}

	:global(.dark) .dev-console-tab.is-active {
		color: #fff;
	}
</style>
