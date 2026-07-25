<script lang="ts">
import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";
import Icon from "@iconify/svelte";
import { getDeveloperModeEnabled } from "@utils/setting-utils";
import { url } from "@utils/url-utils.ts";
import { onMount } from "svelte";
import type { SearchResult } from "@/global";

let keywordDesktop = "";
let keywordMobile = "";
let result: SearchResult[] = [];
let isSearching = false;
let pagefindLoaded = false;
let initialized = false;
let developerModeEnabled = false;
const cjkRegex = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const editorHref = url("/editor");
const draftsHref = url("/drafts");
const trashHref = url("/trash");

const fakeResult: SearchResult[] = [
	{
		url: url("/"),
		meta: {
			title: "This Is a Fake Search Result",
		},
		excerpt:
			"Because the search cannot work in the <mark>dev</mark> environment.",
	},
	{
		url: url("/"),
		meta: {
			title: "If You Want to Test the Search",
		},
		excerpt: "Try running <mark>npm build && npm preview</mark> instead.",
	},
];

const togglePanel = () => {
	const panel = document.getElementById("search-panel");
	panel?.classList.toggle("float-panel-closed");
};

const setPanelVisibility = (show: boolean, isDesktop: boolean): void => {
	const panel = document.getElementById("search-panel");
	if (!panel || !isDesktop) return;

	if (show) {
		panel.classList.remove("float-panel-closed");
	} else {
		panel.classList.add("float-panel-closed");
	}
};

const getCjkFallbackKeyword = (keyword: string): string | null => {
	const normalized = keyword.trim().replace(/\s+/g, " ");
	if (!normalized || normalized.includes(" ")) return null;
	if (!cjkRegex.test(normalized)) return null;
	return Array.from(normalized).join(" ");
};

const refreshDeveloperMode = () => {
	developerModeEnabled = getDeveloperModeEnabled();
};

const normalizeSearchResultUrl = (rawUrl: string): string => {
	if (!rawUrl) return rawUrl;

	const normalizedFallback = rawUrl.replace(/^\/client(?=\/posts\/)/i, "");

	if (typeof window === "undefined") {
		return normalizedFallback;
	}

	try {
		const parsed = new URL(rawUrl, window.location.origin);
		const normalizedPath = parsed.pathname.replace(/^\/client(?=\/posts\/)/i, "");
		return `${normalizedPath}${parsed.search}${parsed.hash}`;
	} catch {
		return normalizedFallback;
	}
};

const search = async (keyword: string, isDesktop: boolean): Promise<void> => {
	if (!keyword) {
		setPanelVisibility(false, isDesktop);
		result = [];
		return;
	}

	if (!initialized) {
		return;
	}

	isSearching = true;

	try {
		let searchResults: SearchResult[] = [];

		if (import.meta.env.PROD && pagefindLoaded && window.pagefind) {
			const normalizedKeyword = keyword.trim();
			const response = await window.pagefind.search(normalizedKeyword);
			searchResults = await Promise.all(
				response.results.map((item) => item.data()),
			);
			searchResults = searchResults.map((item) => ({
				...item,
				url: normalizeSearchResultUrl(item.url),
			}));

			if (searchResults.length === 0) {
				const fallbackKeyword = getCjkFallbackKeyword(normalizedKeyword);
				if (fallbackKeyword) {
					const fallbackResponse =
						await window.pagefind.search(fallbackKeyword);
					searchResults = await Promise.all(
						fallbackResponse.results.map((item) => item.data()),
					);
					searchResults = searchResults.map((item) => ({
						...item,
						url: normalizeSearchResultUrl(item.url),
					}));
				}
			}
		} else if (import.meta.env.DEV) {
			searchResults = fakeResult;
		} else {
			searchResults = [];
			console.error("Pagefind is not available in production environment.");
		}

		result = searchResults;
		setPanelVisibility(result.length > 0, isDesktop);
	} catch (error) {
		console.error("Search error:", error);
		result = [];
		setPanelVisibility(false, isDesktop);
	} finally {
		isSearching = false;
	}
};

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

	const initializeSearch = () => {
		initialized = true;
		pagefindLoaded =
			typeof window !== "undefined" &&
			!!window.pagefind &&
			typeof window.pagefind.search === "function";
		console.log("Pagefind status on init:", pagefindLoaded);
		if (keywordDesktop) search(keywordDesktop, true);
		if (keywordMobile) search(keywordMobile, false);
	};

	refreshDeveloperMode();
	window.addEventListener(
		"developer-mode-change",
		handleDeveloperModeChange as EventListener,
	);
	window.addEventListener("focus", handleFocus);
	document.addEventListener("visibilitychange", handleVisibility);

	let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
	const handlePagefindReady = () => {
		console.log("Pagefind ready event received.");
		initializeSearch();
	};
	const handlePagefindLoadError = () => {
		console.warn(
			"Pagefind load error event received. Search functionality will be limited.",
		);
		initializeSearch();
	};

	if (import.meta.env.DEV) {
		console.log(
			"Pagefind is not available in development mode. Using mock data.",
		);
		initializeSearch();
	} else {
		document.addEventListener("pagefindready", handlePagefindReady);
		document.addEventListener("pagefindloaderror", handlePagefindLoadError);

		// Fallback in case events are not caught or pagefind is already loaded by the time this script runs
		fallbackTimer = setTimeout(() => {
			if (!initialized) {
				console.log("Fallback: Initializing search after timeout.");
				initializeSearch();
			}
		}, 2000); // Adjust timeout as needed
	}

	return () => {
		window.removeEventListener(
			"developer-mode-change",
			handleDeveloperModeChange as EventListener,
		);
		window.removeEventListener("focus", handleFocus);
		document.removeEventListener("visibilitychange", handleVisibility);
		document.removeEventListener("pagefindready", handlePagefindReady);
		document.removeEventListener("pagefindloaderror", handlePagefindLoadError);
		if (fallbackTimer) {
			clearTimeout(fallbackTimer);
		}
	};
});

$: if (initialized && keywordDesktop) {
	(async () => {
		await search(keywordDesktop, true);
	})();
}

$: if (initialized && keywordMobile) {
	(async () => {
		await search(keywordMobile, false);
	})();
}
</script>

{#if developerModeEnabled}
    <a
       href={editorHref}
       data-no-swup
       aria-label="Open Editor"
       class="nav-icon-btn hidden lg:!inline-flex h-11 w-11 active:scale-90 mr-2"
       data-tooltip="文章"
    >
        <Icon icon="fa6-solid:pen" class="text-[1rem]"></Icon>
    </a>
    <a
       href={draftsHref}
       data-no-swup
       aria-label="Open Drafts"
       class="nav-icon-btn hidden lg:!inline-flex h-11 w-11 active:scale-90 mr-2"
       data-tooltip="草稿"
    >
        <Icon icon="fa6-solid:box-archive" class="text-[1rem]"></Icon>
    </a>
    <a
       href={trashHref}
       data-no-swup
       aria-label="Open Trash"
       class="nav-icon-btn nav-icon-btn-danger hidden lg:!inline-flex h-11 w-11 active:scale-90 mr-2"
       data-tooltip="垃圾桶"
    >
        <Icon
           icon="material-symbols:delete-outline-rounded"
           class="text-[1.25rem] !text-red-500"
        ></Icon>
    </a>
{/if}

<!-- search bar for desktop view -->
<div id="search-bar" class="menu-item-search hidden lg:flex transition-all items-center h-11 mr-2 rounded-lg
      bg-black/[0.04] hover:bg-black/[0.06] focus-within:bg-black/[0.06]
      dark:bg-white/5 dark:hover:bg-white/10 dark:focus-within:bg-white/10
">
    <Icon icon="material-symbols:search" class="absolute text-[1.25rem] pointer-events-none ml-3 transition my-auto text-black/30 dark:text-white/30"></Icon>
    <input placeholder="{i18n(I18nKey.search)}" bind:value={keywordDesktop} on:focus={() => search(keywordDesktop, true)}
           class="transition-all pl-10 text-sm bg-transparent outline-0
         h-full w-40 active:w-60 focus:w-60 text-black/50 dark:text-white/50"
    >
</div>

<!-- toggle btn for phone/tablet view -->
<button on:click={togglePanel} aria-label="Search Panel" id="search-switch"
        class="menu-item-search btn-plain scale-animation lg:!hidden rounded-lg w-11 h-11 active:scale-90">
    <Icon icon="material-symbols:search" class="text-[1.25rem]"></Icon>
</button>

<!-- search panel -->
<div id="search-panel" class="menu-item-search float-panel float-panel-closed search-panel absolute md:w-[30rem]
top-20 left-4 md:left-[unset] right-4 shadow-2xl rounded-2xl p-2">

    <!-- search bar inside panel for phone/tablet -->
    <div id="search-bar-inside" class="menu-item-search flex relative lg:hidden transition-all items-center h-11 rounded-xl
      bg-black/[0.04] hover:bg-black/[0.06] focus-within:bg-black/[0.06]
      dark:bg-white/5 dark:hover:bg-white/10 dark:focus-within:bg-white/10
  ">
        <Icon icon="material-symbols:search" class="absolute text-[1.25rem] pointer-events-none ml-3 transition my-auto text-black/30 dark:text-white/30"></Icon>
        <input placeholder="Search" bind:value={keywordMobile}
               class="pl-10 absolute inset-0 text-sm bg-transparent outline-0
               focus:w-60 text-black/50 dark:text-white/50"
        >
    </div>

    <!-- search results -->
    {#each result as item}
        <a href={item.url}
           class="transition first-of-type:mt-2 lg:first-of-type:mt-0 group block
       rounded-xl text-lg px-3 py-2 hover:bg-[var(--btn-plain-bg-hover)] active:bg-[var(--btn-plain-bg-active)]">
            <div class="transition text-90 inline-flex font-bold group-hover:text-[var(--primary)]">
                {item.meta.title}<Icon icon="fa6-solid:chevron-right" class="transition text-[0.75rem] translate-x-1 my-auto text-[var(--primary)]"></Icon>
            </div>
            <div class="transition text-sm text-50">
                {@html item.excerpt}
            </div>
        </a>
    {/each}
</div>

<style>
  input:focus {
    outline: 0;
  }
  .search-panel {
    max-height: calc(100vh - 100px);
    overflow-y: auto;
  }
</style>

