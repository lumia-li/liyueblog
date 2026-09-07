<script lang="ts">
import DevConfirmDialog from "@components/editor/DevConfirmDialog.svelte";
import { readStoredDevCredential } from "@utils/dev-auth-client";
import { getDeveloperModeEnabled } from "@utils/setting-utils";
import { onMount } from "svelte";

type TrashedThought = {
	id: string;
	slug: string;
	title: string;
	published: string;
	trashedAt: string;
};

type PendingDialogAction =
	| {
			action: "restore" | "delete";
			item: TrashedThought;
	  }
	| {
			action: "delete-bulk";
			items: TrashedThought[];
	  }
	| null;

let thoughts: TrashedThought[] = [];
let isLocked = true;
let developerCodeMissing = false;
let loading = false;
let busyActionId = "";
let notice = "";
let noticeType: "info" | "success" | "error" = "info";
let loadError = "";
let pendingDialogAction: PendingDialogAction = null;
let deferredRefreshWhileDialogOpen = false;
let selectedThoughtIds: string[] = [];

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

function getTitle(item: TrashedThought): string {
	return item.title || "未命名随笔";
}

function formatDate(value: string | number): string {
	if (!value) return "未知";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return String(value);
	return date.toLocaleString();
}

function refreshAccess() {
	const enabled = getDeveloperModeEnabled();
	isLocked = !enabled;
	developerCodeMissing = enabled && !readDevCode();
	if (!enabled) {
		pendingDialogAction = null;
		selectedThoughtIds = [];
	}
}

function isSelected(id: string): boolean {
	return selectedThoughtIds.includes(id);
}

function toggleSelection(id: string) {
	selectedThoughtIds = isSelected(id)
		? selectedThoughtIds.filter((item) => item !== id)
		: [...selectedThoughtIds, id];
}

function toggleAll() {
	if (busyActionId || thoughts.length === 0) return;
	selectedThoughtIds =
		selectedThoughtIds.length === thoughts.length
			? []
			: thoughts.map((item) => item.id);
}

function getSelectedThoughts(): TrashedThought[] {
	const selected = new Set(selectedThoughtIds);
	return thoughts.filter((item) => selected.has(item.id));
}

async function loadThoughts(showLoading = true) {
	refreshAccess();
	if (isLocked) {
		thoughts = [];
		loadError = "";
		selectedThoughtIds = [];
		return;
	}

	const devCodeHash = readDevCode();
	if (!devCodeHash) {
		developerCodeMissing = true;
		thoughts = [];
		loadError = "";
		selectedThoughtIds = [];
		return;
	}

	loadError = "";
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
				kind: "thought",
				devCodeHash,
			}),
		});
		const payload = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			message?: string;
			posts?: TrashedThought[];
		};
		if (!response.ok || !payload.ok) {
			throw new Error(payload.message || "加载随笔垃圾桶失败");
		}
		thoughts = Array.isArray(payload.posts) ? payload.posts : [];
		selectedThoughtIds = selectedThoughtIds.filter((id) =>
			thoughts.some((item) => item.id === id),
		);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "加载随笔垃圾桶失败";
		loadError = message;
		thoughts = [];
		selectedThoughtIds = [];
	} finally {
		loading = false;
	}
}

function requestPassiveRefresh() {
	if (pendingDialogAction) {
		deferredRefreshWhileDialogOpen = true;
		return;
	}
	void loadThoughts(false);
}

function flushDeferredRefresh() {
	if (!deferredRefreshWhileDialogOpen) return;
	deferredRefreshWhileDialogOpen = false;
	void loadThoughts(false);
}

async function requestAction(
	action: "restore" | "delete",
	item: TrashedThought,
) {
	if (busyActionId) return;
	const devCodeHash = readDevCode();
	if (!devCodeHash) {
		showNotice("缺少开发者口令，请重新解锁开发者模式", "error");
		return;
	}

	busyActionId = `${action}:${item.id}`;
	try {
		const response = await fetch("/api/dev/trash", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action,
				kind: "thought",
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
				? `已恢复随笔：${getTitle(item)}`
				: `已彻底删除随笔：${getTitle(item)}`,
			"success",
		);
		await loadThoughts(false);
	} catch (error) {
		const message = error instanceof Error ? error.message : "操作失败";
		showNotice(message, "error");
	} finally {
		busyActionId = "";
	}
}

async function requestBulkDelete(items: TrashedThought[]) {
	if (busyActionId || items.length < 1) return;
	const devCodeHash = readDevCode();
	if (!devCodeHash) {
		showNotice("缺少开发者口令，请重新解锁开发者模式", "error");
		return;
	}

	busyActionId = "delete:bulk";
	try {
		const response = await fetch("/api/dev/trash", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				action: "delete",
				kind: "thought",
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
		selectedThoughtIds = [];
		window.dispatchEvent(new CustomEvent("trash-posts-updated"));
		showNotice(
			`已彻底删除 ${payload.count || items.length} 条随笔`,
			"success",
		);
		await loadThoughts(false);
	} catch (error) {
		const message = error instanceof Error ? error.message : "操作失败";
		showNotice(message, "error");
	} finally {
		busyActionId = "";
	}
}

function askRestore(item: TrashedThought) {
	if (busyActionId) return;
	pendingDialogAction = { action: "restore", item };
}

function askDeleteForever(item: TrashedThought) {
	if (busyActionId) return;
	pendingDialogAction = { action: "delete", item };
}

function askDeleteSelected() {
	if (busyActionId) return;
	const items = getSelectedThoughts();
	if (items.length < 1) return;
	pendingDialogAction = { action: "delete-bulk", items };
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
	if (nextAction.action === "delete-bulk") {
		void requestBulkDelete(nextAction.items);
		return;
	}
	void requestAction(nextAction.action, nextAction.item);
}

function getDialogLabel(): string {
	if (!pendingDialogAction) return "";
	if (pendingDialogAction.action === "delete-bulk") {
		return "批量彻底删除";
	}
	return pendingDialogAction.action === "delete"
		? "彻底删除随笔"
		: "恢复随笔";
}

function getDialogTitle(): string {
	if (!pendingDialogAction) return "";
	if (pendingDialogAction.action === "delete-bulk") {
		return `确认彻底删除选中的 ${pendingDialogAction.items.length} 条随笔吗？`;
	}
	const item = pendingDialogAction.item;
	return pendingDialogAction.action === "delete"
		? `确认彻底删除《${getTitle(item)}》吗？`
		: `确认恢复《${getTitle(item)}》吗？`;
}

function getDialogDescription(): string {
	if (!pendingDialogAction) return "";
	if (pendingDialogAction.action === "delete-bulk") {
		return "删除后这些随笔会从垃圾桶中永久消失，不再保留任何备份。";
	}
	return pendingDialogAction.action === "delete"
		? "删除后随笔会从垃圾桶中永久消失，不再保留任何备份。"
		: "恢复后随笔会重新回到随笔列表中。";
}

function getDialogNote(): string {
	if (!pendingDialogAction || pendingDialogAction.action !== "restore") {
		return "";
	}
	return "如果只是误删，现在恢复就可以。";
}

function getDialogWarning(): string {
	if (!pendingDialogAction) return "";
	if (pendingDialogAction.action !== "delete") return "";
	if (pendingDialogAction.action === "delete-bulk") {
		return "批量彻底删除后无法恢复，请确认当前选择无误。";
	}
	return "此操作不可恢复，请再确认一次。";
}

function getDialogConfirmLabel(): string {
	if (!pendingDialogAction) return "确认";
	if (pendingDialogAction.action === "delete-bulk") {
		return "确认批量删除";
	}
	return pendingDialogAction.action === "delete" ? "确认删除" : "确认恢复";
}

function getDialogTone(): "primary" | "danger" {
	return pendingDialogAction?.action === "delete" ? "danger" : "primary";
}

onMount(() => {
	void loadThoughts();

	const handleModeChange = () => {
		void loadThoughts(false);
	};
	const handleTrashUpdated = () => {
		if (pendingDialogAction) {
			deferredRefreshWhileDialogOpen = true;
			return;
		}
		void loadThoughts(false);
	};

	window.addEventListener("developer-mode-change", handleModeChange);
	window.addEventListener("trash-posts-updated", handleTrashUpdated);

	return () => {
		window.removeEventListener("developer-mode-change", handleModeChange);
		window.removeEventListener("trash-posts-updated", handleTrashUpdated);
	};
});
</script>

<section class="thought-trash-section">
	<div>
		<h2 class="section-title">随笔垃圾桶</h2>
		<p class="section-desc">
			已删除的随笔会先进入这里，可恢复或彻底删除
		</p>
	</div>

	{#if isLocked}
		<div class="empty-tip">开发者模式未开启，请先在背景设置中解锁。</div>
	{:else}
		{#if thoughts.length > 0}
			<div class="trash-toolbar">
				<label class="select-toggle">
					<input
						type="checkbox"
						checked={thoughts.length > 0 && selectedThoughtIds.length === thoughts.length}
						disabled={Boolean(busyActionId)}
						on:change={toggleAll}
					/>
					<span>{selectedThoughtIds.length === thoughts.length ? "取消全选" : "全选"}</span>
				</label>
				<div class="toolbar-actions">
					<span class="section-count">
						{selectedThoughtIds.length > 0
							? `已选 ${selectedThoughtIds.length} 项`
							: `共 ${thoughts.length} 项`}
					</span>
					<button
						class="action-btn danger soft"
						disabled={!selectedThoughtIds.length || Boolean(busyActionId)}
						on:click={askDeleteSelected}
					>
						{busyActionId === "delete:bulk" ? "批量删除中..." : "批量彻底删除"}
					</button>
				</div>
			</div>
		{/if}

		{#if developerCodeMissing}
			<div class="empty-tip">
				缺少开发者口令，随笔垃圾桶暂时不可用，请重新解锁开发者模式。
			</div>
		{:else if loading && thoughts.length === 0}
			<div class="empty-tip">正在加载随笔垃圾桶...</div>
		{:else if !loadError && thoughts.length === 0}
			<div class="empty-tip">随笔垃圾桶是空的。</div>
		{:else if loadError}
			<div class="empty-tip error-tip">{loadError}</div>
		{:else}
			<div class="trash-list">
				{#each thoughts as item}
					<div class="trash-item">
						<label class="trash-select">
							<input
								type="checkbox"
								checked={isSelected(item.id)}
								disabled={Boolean(busyActionId)}
								aria-label={`选择随笔 ${getTitle(item)}`}
								on:change={() => toggleSelection(item.id)}
							/>
						</label>
						<div class="trash-main">
							<div class="trash-item-title">{getTitle(item)}</div>
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
								on:click={() => askRestore(item)}
							>
								{busyActionId === `restore:${item.id}` ? "恢复中..." : "恢复"}
							</button>
							<button
								class="action-btn danger"
								disabled={Boolean(busyActionId)}
								on:click={() => askDeleteForever(item)}
							>
								{busyActionId === `delete:${item.id}` ? "删除中..." : "彻底删除"}
							</button>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	{/if}

	{#if notice || loadError}
		<div class={`notice ${notice ? noticeType : "error"}`}>
			{notice || loadError}
		</div>
	{/if}
</section>

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
.thought-trash-section
  display grid
  gap 0.55rem

.section-title
  font-size 1rem
  font-weight 700
  color var(--btn-content)

.section-desc
  margin 0
  font-size 0.84rem
  color rgba(148, 163, 184, 0.95)

.trash-toolbar
  display flex
  align-items center
  justify-content space-between
  gap 0.75rem
  flex-wrap wrap

.toolbar-actions
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

.trash-main
  min-width 0
  display grid
  gap 0.3rem

.trash-item-title
  font-size 1.02rem
  font-weight 700
  line-height 1.3
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
  background none

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
</style>
