<script lang="ts">
import DevConfirmDialog from "@components/editor/DevConfirmDialog.svelte";
import { readStoredDevCredential } from "@utils/dev-auth-client";
import {
	DEV_DRAFT_TRASH_UPDATED_EVENT,
	type DevDraft,
	type DevDraftTrashItem,
	listDraftTrash,
	removeDraftTrash,
	restoreDraftFromTrash,
} from "@utils/dev-draft-utils";
import { getDeveloperModeEnabled } from "@utils/setting-utils";
import { onMount } from "svelte";

type TrashedPost = {
	id: string;
	slug: string;
	title: string;
	published: string;
	trashedAt: string;
};

type PendingDialogAction =
	| {
			kind: "post";
			action: "restore" | "delete";
			item: TrashedPost;
	  }
	| {
			kind: "post-bulk";
			action: "delete";
			items: TrashedPost[];
	  }
	| {
			kind: "draft";
			action: "restore" | "delete";
			item: DevDraftTrashItem;
	  }
	| {
			kind: "draft-bulk";
			action: "delete";
			items: DevDraftTrashItem[];
	  }
	| null;

let posts: TrashedPost[] = [];
let draftTrashItems: DevDraftTrashItem[] = [];
let isLocked = true;
let developerCodeMissing = false;
let loading = false;
let busyActionId = "";
let notice = "";
let noticeType: "info" | "success" | "error" = "info";
let postLoadError = "";
let pendingDialogAction: PendingDialogAction = null;
let deferredRefreshWhileDialogOpen = false;
let selectedPostIds: string[] = [];
let selectedDraftIds: string[] = [];

function showNotice(message: string, type: "info" | "success" | "error") {
	notice = message;
	noticeType = type;
	if (type === "error") {
		return;
	}
	window.setTimeout(() => {
		if (notice === message) {
			notice = "";
		}
	}, 3000);
}

function readDevCode(): string {
	return readStoredDevCredential();
}

function refreshAccess() {
	const enabled = getDeveloperModeEnabled();
	isLocked = !enabled;
	developerCodeMissing = enabled && !readDevCode();
	if (!enabled) {
		pendingDialogAction = null;
		selectedPostIds = [];
		selectedDraftIds = [];
	}
}

function formatDate(value: string | number): string {
	if (!value) return "未知";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	return date.toLocaleString();
}

function excerpt(content: string): string {
	return content.replace(/\s+/g, " ").trim().slice(0, 120) || "(空内容)";
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}

function getEffectiveDraftSlug(
	draft: Pick<DevDraft, "slug" | "title">,
): string {
	return slugify((draft.slug || "").trim() || (draft.title || "").trim());
}

function getPostTitle(item: TrashedPost): string {
	return item.title || "未命名文章";
}

function getDraftTitle(item: DevDraftTrashItem | DevDraft): string {
	return item.title || "未命名草稿";
}

function isPostSelected(id: string): boolean {
	return selectedPostIds.includes(id);
}

function isDraftSelected(id: string): boolean {
	return selectedDraftIds.includes(id);
}

function togglePostSelection(id: string) {
	selectedPostIds = isPostSelected(id)
		? selectedPostIds.filter((item) => item !== id)
		: [...selectedPostIds, id];
}

function toggleDraftSelection(id: string) {
	selectedDraftIds = isDraftSelected(id)
		? selectedDraftIds.filter((item) => item !== id)
		: [...selectedDraftIds, id];
}

function toggleAllPosts() {
	if (busyActionId || posts.length === 0) return;
	selectedPostIds =
		selectedPostIds.length === posts.length ? [] : posts.map((item) => item.id);
}

function toggleAllDrafts() {
	if (busyActionId || draftTrashItems.length === 0) return;
	selectedDraftIds =
		selectedDraftIds.length === draftTrashItems.length
			? []
			: draftTrashItems.map((item) => item.id);
}

function getSelectedPosts(): TrashedPost[] {
	const selected = new Set(selectedPostIds);
	return posts.filter((item) => selected.has(item.id));
}

function getSelectedDrafts(): DevDraftTrashItem[] {
	const selected = new Set(selectedDraftIds);
	return draftTrashItems.filter((item) => selected.has(item.id));
}

async function loadPosts(showLoading = true) {
	refreshAccess();
	if (isLocked) {
		posts = [];
		postLoadError = "";
		selectedPostIds = [];
		return;
	}

	const devCodeHash = readDevCode();
	if (!devCodeHash) {
		developerCodeMissing = true;
		posts = [];
		postLoadError = "";
		selectedPostIds = [];
		return;
	}

	postLoadError = "";

	if (showLoading) {
		loading = true;
	}

	try {
		const response = await fetch("/api/dev/trash", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action: "list",
				devCodeHash,
			}),
		});
		const payload = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			message?: string;
			posts?: TrashedPost[];
		};
		if (!response.ok || !payload.ok) {
			throw new Error(payload.message || "加载文章垃圾桶失败");
		}
		posts = Array.isArray(payload.posts) ? payload.posts : [];
		selectedPostIds = selectedPostIds.filter((id) =>
			posts.some((item) => item.id === id),
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "加载文章垃圾桶失败";
		postLoadError = message;
		posts = [];
		selectedPostIds = [];
	} finally {
		loading = false;
	}
}

function loadDraftTrashItems() {
	refreshAccess();
	if (isLocked) {
		draftTrashItems = [];
		selectedDraftIds = [];
		return;
	}
	draftTrashItems = listDraftTrash();
	selectedDraftIds = selectedDraftIds.filter((id) =>
		draftTrashItems.some((item) => item.id === id),
	);
}

function requestPassiveRefresh() {
	if (pendingDialogAction) {
		deferredRefreshWhileDialogOpen = true;
		return;
	}
	void loadPosts(false);
	loadDraftTrashItems();
}

function flushDeferredRefresh() {
	if (!deferredRefreshWhileDialogOpen) return;
	deferredRefreshWhileDialogOpen = false;
	void loadPosts(false);
	loadDraftTrashItems();
}

async function requestPostAction(
	action: "restore" | "delete",
	item: TrashedPost,
) {
	if (busyActionId) return;
	const devCodeHash = readDevCode();
	if (!devCodeHash) {
		showNotice("缺少开发者口令，请重新解锁开发者模式", "error");
		return;
	}

	busyActionId = `post:${action}:${item.id}`;
	try {
		const response = await fetch("/api/dev/trash", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action,
				postId: item.id,
				devCodeHash,
			}),
		});
		const payload = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			message?: string;
		};
		if (!response.ok || !payload.ok) {
			throw new Error(payload.message || "操作失败");
		}
		window.dispatchEvent(new CustomEvent("trash-posts-updated"));
		showNotice(
			action === "restore"
				? `已恢复文章：${getPostTitle(item)}`
				: `已彻底删除文章：${getPostTitle(item)}`,
			"success",
		);
		await loadPosts(false);
	} catch (error) {
		const message = error instanceof Error ? error.message : "操作失败";
		showNotice(message, "error");
	} finally {
		busyActionId = "";
	}
}

async function requestBulkPostDelete(items: TrashedPost[]) {
	if (busyActionId || items.length < 1) return;
	const devCodeHash = readDevCode();
	if (!devCodeHash) {
		showNotice("缺少开发者口令，请重新解锁开发者模式", "error");
		return;
	}

	busyActionId = "post:delete:bulk";
	try {
		const response = await fetch("/api/dev/trash", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action: "delete",
				postIds: items.map((item) => item.id),
				devCodeHash,
			}),
		});
		const payload = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			message?: string;
			count?: number;
		};
		if (!response.ok || !payload.ok) {
			throw new Error(payload.message || "操作失败");
		}
		selectedPostIds = [];
		window.dispatchEvent(new CustomEvent("trash-posts-updated"));
		showNotice(`已彻底删除 ${payload.count || items.length} 篇文章`, "success");
		await loadPosts(false);
	} catch (error) {
		const message = error instanceof Error ? error.message : "操作失败";
		showNotice(message, "error");
	} finally {
		busyActionId = "";
	}
}

function requestDraftAction(
	action: "restore" | "delete",
	item: DevDraftTrashItem,
) {
	if (busyActionId) return;

	busyActionId = `draft:${action}:${item.id}`;
	try {
		if (action === "restore") {
			const restoredDraft = restoreDraftFromTrash(item.id);
			if (!restoredDraft) {
				throw new Error("这篇草稿已经不存在，无法恢复");
			}
			showNotice(`已恢复草稿：${getDraftTitle(restoredDraft)}`, "success");
		} else {
			const removed = removeDraftTrash(item.id);
			if (!removed) {
				throw new Error("这篇草稿已经不存在，无需重复删除");
			}
			showNotice(`已彻底删除草稿：${getDraftTitle(item)}`, "success");
		}
		loadDraftTrashItems();
	} catch (error) {
		const message = error instanceof Error ? error.message : "操作失败";
		showNotice(message, "error");
	} finally {
		busyActionId = "";
	}
}

function requestBulkDraftDelete(items: DevDraftTrashItem[]) {
	if (busyActionId || items.length < 1) return;

	busyActionId = "draft:delete:bulk";
	try {
		let removedCount = 0;
		for (const item of items) {
			if (removeDraftTrash(item.id)) {
				removedCount += 1;
			}
		}
		if (removedCount < 1) {
			throw new Error("没有成功删除任何草稿");
		}
		selectedDraftIds = [];
		showNotice(`已彻底删除 ${removedCount} 篇草稿`, "success");
		loadDraftTrashItems();
	} catch (error) {
		const message = error instanceof Error ? error.message : "操作失败";
		showNotice(message, "error");
	} finally {
		busyActionId = "";
	}
}

function restorePost(item: TrashedPost) {
	if (busyActionId) return;
	pendingDialogAction = {
		kind: "post",
		action: "restore",
		item,
	};
}

function deleteForever(item: TrashedPost) {
	if (busyActionId) return;
	pendingDialogAction = {
		kind: "post",
		action: "delete",
		item,
	};
}

function restoreDraft(item: DevDraftTrashItem) {
	if (busyActionId) return;
	pendingDialogAction = {
		kind: "draft",
		action: "restore",
		item,
	};
}

function deleteDraftForever(item: DevDraftTrashItem) {
	if (busyActionId) return;
	pendingDialogAction = {
		kind: "draft",
		action: "delete",
		item,
	};
}

function deleteSelectedPosts() {
	if (busyActionId) return;
	const items = getSelectedPosts();
	if (items.length < 1) return;
	pendingDialogAction = {
		kind: "post-bulk",
		action: "delete",
		items,
	};
}

function deleteSelectedDrafts() {
	if (busyActionId) return;
	const items = getSelectedDrafts();
	if (items.length < 1) return;
	pendingDialogAction = {
		kind: "draft-bulk",
		action: "delete",
		items,
	};
}

function closePendingDialog() {
	if (busyActionId) return;
	pendingDialogAction = null;
	flushDeferredRefresh();
}

function confirmPendingDialog() {
	if (!pendingDialogAction || busyActionId) return;
	const nextAction = pendingDialogAction;
	pendingDialogAction = null;
	deferredRefreshWhileDialogOpen = false;
	if (nextAction.kind === "post") {
		void requestPostAction(nextAction.action, nextAction.item);
		return;
	}
	if (nextAction.kind === "post-bulk") {
		void requestBulkPostDelete(nextAction.items);
		return;
	}
	if (nextAction.kind === "draft-bulk") {
		requestBulkDraftDelete(nextAction.items);
		return;
	}
	requestDraftAction(nextAction.action, nextAction.item);
}

function getDialogLabel(): string {
	if (!pendingDialogAction) return "";
	if (pendingDialogAction.kind === "post-bulk") {
		return "批量彻底删除";
	}
	if (pendingDialogAction.kind === "draft-bulk") {
		return "批量删除草稿";
	}
	if (pendingDialogAction.kind === "draft") {
		return pendingDialogAction.action === "delete" ? "删除草稿" : "恢复草稿";
	}
	return pendingDialogAction.action === "delete" ? "彻底删除" : "恢复文章";
}

function getDialogTitle(): string {
	if (!pendingDialogAction) return "";
	if (pendingDialogAction.kind === "post-bulk") {
		return `确认彻底删除选中的 ${pendingDialogAction.items.length} 篇文章吗？`;
	}
	if (pendingDialogAction.kind === "draft-bulk") {
		return `确认彻底删除选中的 ${pendingDialogAction.items.length} 篇草稿吗？`;
	}
	if (pendingDialogAction.kind === "draft") {
		return pendingDialogAction.action === "delete"
			? `确认彻底删除《${getDraftTitle(pendingDialogAction.item)}》吗？`
			: `确认恢复《${getDraftTitle(pendingDialogAction.item)}》吗？`;
	}
	return pendingDialogAction.action === "delete"
		? `确认彻底删除《${getPostTitle(pendingDialogAction.item)}》吗？`
		: `确认恢复《${getPostTitle(pendingDialogAction.item)}》吗？`;
}

function getDialogDescription(): string {
	if (!pendingDialogAction) return "";
	if (pendingDialogAction.kind === "post-bulk") {
		return "删除后这些文章会从垃圾桶中永久消失，不再保留任何备份。";
	}
	if (pendingDialogAction.kind === "draft-bulk") {
		return "删除后这些本地草稿会从当前浏览器的垃圾桶中永久移除，不再保留恢复入口。";
	}
	if (pendingDialogAction.kind === "draft") {
		return pendingDialogAction.action === "delete"
			? "删除后会从当前浏览器的本地草稿垃圾桶中永久移除，不再保留恢复入口。"
			: "恢复后草稿会回到草稿箱，可以继续编辑、保存或再次移入垃圾桶。";
	}
	return pendingDialogAction.action === "delete"
		? "删除后文章会从垃圾桶中永久消失，不再保留任何备份。"
		: "恢复后文章会重新回到正常列表中。";
}

function getDialogNote(): string {
	if (!pendingDialogAction) return "";
	if (
		pendingDialogAction.kind === "post-bulk" ||
		pendingDialogAction.kind === "draft-bulk"
	) {
		return "";
	}
	if (
		pendingDialogAction.kind === "draft" &&
		pendingDialogAction.action === "restore"
	) {
		return "如果只是误删，现在恢复就能继续接着写。";
	}
	if (
		pendingDialogAction.kind === "post" &&
		pendingDialogAction.action === "restore"
	) {
		return "如果只是误删，现在恢复就可以。";
	}
	return "";
}

function getDialogWarning(): string {
	if (!pendingDialogAction) return "";
	if (pendingDialogAction.action !== "delete") return "";
	if (
		pendingDialogAction.kind === "post-bulk" ||
		pendingDialogAction.kind === "draft-bulk"
	) {
		return "批量彻底删除后无法恢复，请确认当前选择无误。";
	}
	return pendingDialogAction.kind === "draft"
		? "彻底删除后不会再进入任何垃圾桶，也无法恢复。"
		: "此操作不可恢复，请再确认一次。";
}

function getDialogConfirmLabel(): string {
	if (!pendingDialogAction) return "确认";
	if (
		pendingDialogAction.kind === "post-bulk" ||
		pendingDialogAction.kind === "draft-bulk"
	) {
		return "确认批量删除";
	}
	return pendingDialogAction.action === "delete" ? "确认删除" : "确认恢复";
}

function getDialogTone(): "primary" | "danger" {
	return pendingDialogAction?.action === "delete" ? "danger" : "primary";
}

onMount(() => {
	void loadPosts();
	loadDraftTrashItems();

	const handleModeChange = () => {
		void loadPosts(false);
		loadDraftTrashItems();
	};
	const handleTrashUpdated = () => {
		if (pendingDialogAction) {
			deferredRefreshWhileDialogOpen = true;
			return;
		}
		void loadPosts(false);
	};
	const handleDraftTrashUpdated = () => {
		if (pendingDialogAction) {
			deferredRefreshWhileDialogOpen = true;
			return;
		}
		loadDraftTrashItems();
	};
	const handleStorage = (event: StorageEvent) => {
		if (
			!event.key ||
			event.key.includes("dev-editor-draft") ||
			event.key === "devEditorEnabled" ||
			event.key === "devEditorCredential" ||
			event.key === "devEditorCode" ||
			event.key === "devEditorAutoLockAt"
		) {
			requestPassiveRefresh();
		}
	};

	window.addEventListener("developer-mode-change", handleModeChange);
	window.addEventListener("trash-posts-updated", handleTrashUpdated);
	window.addEventListener(
		DEV_DRAFT_TRASH_UPDATED_EVENT,
		handleDraftTrashUpdated,
	);
	window.addEventListener("storage", handleStorage);

	return () => {
		window.removeEventListener("developer-mode-change", handleModeChange);
		window.removeEventListener("trash-posts-updated", handleTrashUpdated);
		window.removeEventListener(
			DEV_DRAFT_TRASH_UPDATED_EVENT,
			handleDraftTrashUpdated,
		);
		window.removeEventListener("storage", handleStorage);
	};
});
</script>

<div class="trash-root">
	<div class="trash-head">
		<div>
			<h1 class="text-xl font-bold text-[var(--btn-content)]">垃圾桶</h1>
			<p class="mt-1 text-sm text-neutral-400">
				已删除的文章和本地草稿会先进入这里
			</p>
		</div>
		<button
			class="reload-btn"
			on:click={() => {
				void loadPosts();
				loadDraftTrashItems();
				// 顶部统一的刷新按钮同时刷新随笔垃圾桶
				window.dispatchEvent(new CustomEvent("trash-posts-updated"));
			}}
			disabled={loading || isLocked}
		>
			{loading ? "刷新中..." : "刷新"}
		</button>
	</div>

	{#if isLocked}
		<div class="empty-tip">开发者模式未开启，请先在背景设置中解锁。</div>
	{:else}
		<div class="trash-sections">
			<section class="trash-section">
				<div class="section-head">
					<div>
						<div class="section-title">文章垃圾桶</div>
						<p class="section-desc">支持多选后批量彻底删除</p>
					</div>
					{#if posts.length > 0}
						<div class="section-toolbar">
							<label class="select-toggle">
								<input
									type="checkbox"
									checked={posts.length > 0 && selectedPostIds.length === posts.length}
									disabled={Boolean(busyActionId)}
									on:change={toggleAllPosts}
								/>
								<span>{selectedPostIds.length === posts.length ? "取消全选" : "全选"}</span>
							</label>
							<div class="section-actions">
								<span class="section-count">
									{selectedPostIds.length > 0
										? `已选 ${selectedPostIds.length} 项`
										: `共 ${posts.length} 项`}
								</span>
								<button
									class="action-btn danger soft"
									disabled={!selectedPostIds.length || Boolean(busyActionId)}
									on:click={deleteSelectedPosts}
								>
									{busyActionId === "post:delete:bulk" ? "批量删除中..." : "批量彻底删除"}
								</button>
							</div>
						</div>
					{/if}
				</div>
				{#if developerCodeMissing}
					<div class="empty-tip">缺少开发者口令，文章垃圾桶暂时不可用，请重新解锁开发者模式。</div>
				{:else if loading && posts.length === 0}
					<div class="empty-tip">正在加载文章垃圾桶...</div>
				{:else if !postLoadError && posts.length === 0}
					<div class="empty-tip">文章垃圾桶是空的。</div>
				{:else}
					<div class="trash-list">
						{#each posts as item}
							<div class="trash-item">
								<label class="trash-select">
									<input
										type="checkbox"
										checked={isPostSelected(item.id)}
										disabled={Boolean(busyActionId)}
										aria-label={`选择文章 ${getPostTitle(item)}`}
										on:change={() => togglePostSelection(item.id)}
									/>
								</label>
								<div class="trash-main">
									<div class="trash-title">{getPostTitle(item)}</div>
									<div class="trash-meta">
										<span>Slug: {item.slug || "(空)"}</span>
										<span>发布时间: {formatDate(item.published)}</span>
										<span>移入时间: {formatDate(item.trashedAt)}</span>
									</div>
								</div>
								<div class="trash-actions">
									<button
										class="action-btn"
										disabled={Boolean(busyActionId)}
										on:click={() => restorePost(item)}
									>
										{busyActionId === `post:restore:${item.id}` ? "恢复中..." : "恢复"}
									</button>
									<button
										class="action-btn danger"
										disabled={Boolean(busyActionId)}
										on:click={() => deleteForever(item)}
									>
										{busyActionId === `post:delete:${item.id}` ? "删除中..." : "彻底删除"}
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<section class="trash-section">
				<div class="section-head">
					<div>
						<div class="section-title">本地草稿垃圾桶</div>
						<p class="section-desc">支持多选后批量彻底删除</p>
					</div>
					{#if draftTrashItems.length > 0}
						<div class="section-toolbar">
							<label class="select-toggle">
								<input
									type="checkbox"
									checked={draftTrashItems.length > 0 && selectedDraftIds.length === draftTrashItems.length}
									disabled={Boolean(busyActionId)}
									on:change={toggleAllDrafts}
								/>
								<span>{selectedDraftIds.length === draftTrashItems.length ? "取消全选" : "全选"}</span>
							</label>
							<div class="section-actions">
								<span class="section-count">
									{selectedDraftIds.length > 0
										? `已选 ${selectedDraftIds.length} 项`
										: `共 ${draftTrashItems.length} 项`}
								</span>
								<button
									class="action-btn danger soft"
									disabled={!selectedDraftIds.length || Boolean(busyActionId)}
									on:click={deleteSelectedDrafts}
								>
									{busyActionId === "draft:delete:bulk" ? "批量删除中..." : "批量彻底删除"}
								</button>
							</div>
						</div>
					{/if}
				</div>
				{#if draftTrashItems.length === 0}
					<div class="empty-tip">本地草稿垃圾桶是空的。</div>
				{:else}
					<div class="trash-list">
						{#each draftTrashItems as item}
							<div class="trash-item draft-trash-item">
								<label class="trash-select">
									<input
										type="checkbox"
										checked={isDraftSelected(item.id)}
										disabled={Boolean(busyActionId)}
										aria-label={`选择草稿 ${getDraftTitle(item)}`}
										on:change={() => toggleDraftSelection(item.id)}
									/>
								</label>
								<div class="trash-main">
									<div class="trash-title">{getDraftTitle(item)}</div>
									<div class="trash-meta">
										<span>Slug: {getEffectiveDraftSlug(item) || "(待生成)"}</span>
										<span>最近保存: {formatDate(item.updatedAt)}</span>
										<span>移入时间: {formatDate(item.trashedAt)}</span>
									</div>
									<div class="trash-excerpt">{excerpt(item.content)}</div>
								</div>
								<div class="trash-actions">
									<button
										class="action-btn"
										disabled={Boolean(busyActionId)}
										on:click={() => restoreDraft(item)}
									>
										{busyActionId === `draft:restore:${item.id}` ? "恢复中..." : "恢复"}
									</button>
									<button
										class="action-btn danger"
										disabled={Boolean(busyActionId)}
										on:click={() => deleteDraftForever(item)}
									>
										{busyActionId === `draft:delete:${item.id}` ? "删除中..." : "彻底删除"}
									</button>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>
		</div>
	{/if}

	{#if notice || postLoadError}
		<div class={`notice ${notice ? noticeType : "error"}`}>
			{notice || postLoadError}
		</div>
	{/if}
</div>

<DevConfirmDialog
	open={Boolean(pendingDialogAction)}
	label={getDialogLabel()}
	title={getDialogTitle()}
	description={getDialogDescription()}
	note={getDialogNote()}
	warning={getDialogWarning()}
	confirmLabel={getDialogConfirmLabel()}
	cancelLabel="取消"
	tone={getDialogTone()}
	on:cancel={closePendingDialog}
	on:confirm={confirmPendingDialog}
/>

<style lang="stylus">
.trash-head
  display flex
  align-items flex-start
  justify-content space-between
  gap 1rem
  margin-bottom 1rem

.reload-btn
  border 1px solid var(--primary)
  border-radius 0.68rem
  padding 0.45rem 0.8rem
  color var(--btn-content)
  font-weight 700

  &:disabled
    opacity 0.6
    cursor not-allowed

.trash-sections
  display grid
  gap 0.85rem

.trash-section
  display grid
  gap 0.55rem

.section-head
  display grid
  gap 0.18rem

.section-title
  font-size 1rem
  font-weight 700
  color var(--btn-content)

.section-desc
  margin 0
  font-size 0.84rem
  color rgba(148, 163, 184, 0.95)

.section-toolbar
  display flex
  align-items center
  justify-content space-between
  gap 0.75rem
  flex-wrap wrap

.section-actions
  display flex
  align-items center
  gap 0.75rem
  flex-wrap wrap

.select-toggle
  display inline-flex
  align-items center
  gap 0.5rem
  font-size 0.84rem
  color var(--btn-content)
  cursor pointer

  input
    width 1rem
    height 1rem
    accent-color var(--primary)

.section-count
  font-size 0.8rem
  color rgba(148, 163, 184, 0.94)

.empty-tip
  border 1px dashed var(--btn-regular-bg-hover)
  border-radius 0.9rem
  padding 1rem
  color var(--btn-content)

.error-tip
  border-style solid
  background rgba(254, 226, 226, 0.96)
  color rgb(244, 71, 71)
  border-color rgba(244, 71, 71, 0.56)
  box-shadow 0 0.8rem 2rem rgba(244, 71, 71, 0.12)

:global(html.dark) .error-tip
  background rgba(244, 71, 71, 0.16)
  color rgb(255, 170, 170)
  border-color rgba(244, 71, 71, 0.64)
  box-shadow 0 1rem 2.2rem rgba(244, 71, 71, 0.16)

.trash-list
  display grid
  gap 0.9rem

.trash-item
  border 1px solid unquote('color-mix(in oklab, var(--primary) 16%, var(--btn-regular-bg-hover))')
  border-radius 0.95rem
  padding 0.92rem 1rem
  display grid
  grid-template-columns auto minmax(0, 1fr) auto
  align-items flex-start
  gap 0.9rem
  background unquote('color-mix(in oklab, var(--card-bg) 94%, var(--btn-plain-bg-hover))')
  box-shadow 0 14px 30px -24px rgba(15, 23, 42, 0.34)

.draft-trash-item
  border-color unquote('color-mix(in oklab, var(--primary) 20%, var(--btn-regular-bg-hover))')

.trash-main
  min-width 0
  display grid
  gap 0.3rem

.trash-select
  display inline-flex
  align-items flex-start
  justify-content center
  padding-top 0.15rem

  input
    width 1rem
    height 1rem
    accent-color var(--primary)
    cursor pointer

.trash-title
  font-size 1.02rem
  font-weight 700
  line-height 1.3
  letter-spacing 0.01em
  color var(--btn-content)

.trash-meta
  display flex
  flex-wrap wrap
  gap 0.7rem
  font-size 0.78rem
  color rgba(148, 163, 184, 0.94)

.trash-meta span
  display inline
  min-height auto
  padding 0
  border none
  border-radius 0
  background none

.trash-excerpt
  font-size 0.88rem
  line-height 1.55
  color var(--btn-content)
  word-break break-word

.trash-actions
  display inline-flex
  align-self start
  gap 0.55rem
  padding-top 0.08rem

.action-btn
  border 1px solid var(--primary)
  border-radius 0.6rem
  padding 0.42rem 0.8rem
  color var(--btn-content)
  font-weight 700
  white-space nowrap
  transition transform 0.18s ease, border-color 0.18s ease, background 0.18s ease

  &:disabled
    opacity 0.58
    cursor not-allowed

  &:hover:not(:disabled)
    transform translateY(-1px)

.action-btn.danger
  border-color rgba(239, 68, 68, 0.75)
  color rgba(239, 68, 68, 0.95)

.action-btn.soft
  background rgba(239, 68, 68, 0.08)

.notice
  margin-top 0.75rem
  border-radius 0.65rem
  padding 0.55rem 0.75rem
  font-size 0.88rem
  border 1px solid transparent

.notice.info
  background rgba(71, 85, 105, 0.25)

.notice.success
  background rgba(22, 163, 74, 0.2)

.notice.error
  background rgba(254, 226, 226, 0.96) !important
  color rgb(244, 71, 71) !important
  border-color rgba(244, 71, 71, 0.56) !important
  box-shadow 0 0.8rem 2rem rgba(244, 71, 71, 0.12)

:global(html.dark) .notice.error
  background rgba(244, 71, 71, 0.16) !important
  color rgb(255, 170, 170) !important
  border-color rgba(244, 71, 71, 0.64) !important
  box-shadow 0 1rem 2.2rem rgba(244, 71, 71, 0.16)

@media (max-width: 760px)
  .section-toolbar
    width 100%
    align-items stretch

  .section-actions
    width 100%
    justify-content space-between

  .trash-item
    grid-template-columns auto 1fr

  .trash-actions
    grid-column 1 / -1
    width 100%
    padding-left 1.9rem

  .action-btn
    flex 1
    text-align center
</style>
