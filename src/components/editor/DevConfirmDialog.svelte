<script lang="ts">
import { createEventDispatcher, onMount, tick } from "svelte";
import { cubicOut } from "svelte/easing";
import { fade, scale } from "svelte/transition";

type ConfirmEventDetail = {
	rememberChoice: boolean;
};

const dispatch = createEventDispatcher<{
	cancel: void;
	confirm: ConfirmEventDetail;
	alternate: ConfirmEventDetail;
}>();

export let open = false;
export let label = "";
export let title = "";
export let description = "";
export let note = "";
export let noteTone: "default" | "danger" = "default";
export let warning = "";
export let confirmLabel = "确认";
export let cancelLabel = "取消";
export let alternateLabel = "";
export let rememberChoice = false;
export let allowRememberChoice = false;
export let rememberChoiceLabel = "不再提醒";
export let rememberChoiceHint = "";
export let tone: "primary" | "danger" | "warning" = "primary";
export let alternateTone: "primary" | "danger" | "warning" = "warning";
export let busy = false;

let portalHost: HTMLDivElement | null = null;
let confirmButton: HTMLButtonElement | null = null;
let ignoreNextBackdropClick = false;

async function focusConfirmButton() {
	if (!open) return;
	await tick();
	confirmButton?.focus();
}

$: if (open) {
	void focusConfirmButton();
}

$: if (typeof document !== "undefined") {
	document.body.classList.toggle("dev-confirm-dialog-active", open);
}

$: if (!open) {
	ignoreNextBackdropClick = false;
}

function handleCancel() {
	if (busy) return;
	dispatch("cancel");
}

function handleBackdropClick() {
	if (busy) return;
	if (ignoreNextBackdropClick) {
		ignoreNextBackdropClick = false;
		return;
	}
	handleCancel();
}

function handleConfirm() {
	if (busy) return;
	dispatch("confirm", { rememberChoice });
}

function handleAlternate() {
	if (busy) return;
	dispatch("alternate", { rememberChoice });
}

function handleWindowKeydown(event: KeyboardEvent) {
	if (!open || busy) return;
	if (event.key !== "Escape") return;
	event.preventDefault();
	handleCancel();
}

function handleWindowBlur() {
	if (!open) return;
	ignoreNextBackdropClick = true;
}

function handleDocumentVisibilityChange() {
	if (!open || typeof document === "undefined") return;
	if (document.hidden) {
		ignoreNextBackdropClick = true;
	}
}

onMount(() => {
	if (portalHost && typeof document !== "undefined") {
		document.body.appendChild(portalHost);
	}

	return () => {
		if (typeof document !== "undefined") {
			document.body.classList.remove("dev-confirm-dialog-active");
		}
		if (portalHost?.parentNode) {
			portalHost.parentNode.removeChild(portalHost);
		}
	};
});
</script>

<svelte:window on:keydown={handleWindowKeydown} on:blur={handleWindowBlur} />
<svelte:document on:visibilitychange={handleDocumentVisibilityChange} />

<div bind:this={portalHost}>
	{#if open}
		<div
			class="dev-confirm-root"
			role="presentation"
			on:click={handleBackdropClick}
			transition:fade={{ duration: 160 }}
		>
			<div
				class="dev-confirm-panel"
				role="dialog"
				aria-modal="true"
				aria-label={title || label || "确认操作"}
				tabindex="-1"
				on:click|stopPropagation
				on:keydown|stopPropagation={() => {}}
				transition:scale={{ duration: 190, easing: cubicOut, start: 0.96 }}
			>
				{#if label}
					<div class="dev-confirm-label">{label}</div>
				{/if}

				{#if title}
					<h3 class="dev-confirm-title">{title}</h3>
				{/if}

				{#if description}
					<p class="dev-confirm-description">{description}</p>
				{/if}

				{#if note}
					<p class:danger={noteTone === "danger"} class="dev-confirm-note">{note}</p>
				{/if}

				{#if warning}
					<p class="dev-confirm-warning">{warning}</p>
				{/if}

				{#if allowRememberChoice}
					<label class="dev-confirm-remember">
						<input
							type="checkbox"
							bind:checked={rememberChoice}
							disabled={busy}
						/>
						<span>{rememberChoiceLabel}</span>
					</label>

					{#if rememberChoiceHint}
						<p class="dev-confirm-remember-hint">{rememberChoiceHint}</p>
					{/if}
				{/if}

				<div class="dev-confirm-actions">
					<button
						type="button"
						class="dev-confirm-btn secondary"
						disabled={busy}
						on:click={handleCancel}
					>
						{cancelLabel}
					</button>
					{#if alternateLabel}
						<button
							type="button"
							class={`dev-confirm-btn ${alternateTone}`}
							disabled={busy}
							on:click={handleAlternate}
						>
							{alternateLabel}
						</button>
					{/if}
					<button
						type="button"
						class={`dev-confirm-btn ${tone}`}
						disabled={busy}
						on:click={handleConfirm}
						bind:this={confirmButton}
					>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	{/if}
</div>

<style lang="stylus">
.dev-confirm-root
  position fixed
  inset 0
  z-index 120
  display flex
  align-items center
  justify-content center
  padding 1rem

.dev-confirm-panel
  width unquote('min(31rem, calc(100vw - 1.5rem))')
  max-width unquote('min(31rem, calc(100vw - 1.5rem))')
  border-radius calc(var(--radius-large) + 0.35rem)
  border 1px solid unquote('color-mix(in oklab, var(--primary) 24%, var(--btn-regular-bg-hover))')
  background unquote('linear-gradient(165deg, color-mix(in oklab, var(--card-bg) 96%, transparent) 0%, color-mix(in oklab, var(--btn-regular-bg) 94%, var(--card-bg)) 100%)')
  box-shadow unquote('0 1.5rem 4rem rgba(15, 23, 42, 0.18), 0 0 0 1px color-mix(in oklab, var(--card-bg) 72%, transparent) inset')
  backdrop-filter blur(18px)
  padding 1.15rem
  color var(--btn-content)
  overflow hidden

.dev-confirm-label
  display inline-flex
  align-items center
  gap 0.45rem
  font-size 0.72rem
  font-weight 700
  letter-spacing 0.08em
  text-transform uppercase
  color unquote('color-mix(in oklab, var(--primary) 78%, var(--btn-content))')

  &::before
    content ""
    width 0.65rem
    height 0.2rem
    border-radius 999px
    background var(--primary)

.dev-confirm-title
  margin 0.7rem 0 0
  font-size 1.18rem
  line-height 1.45
  font-weight 800
  color unquote('color-mix(in oklab, var(--btn-content) 92%, black 8%)')

.dev-confirm-description
  margin 0.65rem 0 0
  font-size 0.94rem
  line-height 1.65
  color unquote('color-mix(in oklab, var(--btn-content) 82%, transparent)')

.dev-confirm-note
  margin 0.7rem 0 0
  padding 0.75rem 0.85rem
  border-radius 0.95rem
  background unquote('color-mix(in oklab, var(--btn-regular-bg) 90%, transparent)')
  border 1px solid unquote('color-mix(in oklab, var(--primary) 16%, var(--btn-regular-bg-hover))')
  font-size 0.86rem
  line-height 1.55
  color unquote('color-mix(in oklab, var(--btn-content) 78%, transparent)')
  max-width 100%
  white-space pre-wrap
  word-break break-all
  max-height 5.8rem
  overflow-y auto
  overflow-x hidden
  scrollbar-width none
  -ms-overflow-style none

.dev-confirm-note::-webkit-scrollbar
  width 0
  height 0
  display none

.dev-confirm-note.danger
  border-color rgba(244, 114, 182, 0.28)
  background rgba(244, 114, 182, 0.08)
  color unquote('color-mix(in oklab, var(--btn-content) 88%, rgba(190, 24, 93, 0.85))')

:global(html.dark) .dev-confirm-note.danger
  border-color rgba(244, 114, 182, 0.3)
  background rgba(131, 24, 67, 0.28)
  color rgba(251, 207, 232, 0.96)

.dev-confirm-warning
  margin 0.7rem 0 0
  padding 0.78rem 0.85rem
  border-radius 0.95rem
  border 1px solid rgba(239, 68, 68, 0.26)
  background rgba(239, 68, 68, 0.08)
  font-size 0.86rem
  line-height 1.55
  color rgba(220, 38, 38, 0.96)
  max-width 100%
  white-space pre-wrap
  word-break break-all
  max-height 5.8rem
  overflow-y auto
  overflow-x hidden
  scrollbar-width none
  -ms-overflow-style none

.dev-confirm-warning::-webkit-scrollbar
  width 0
  height 0
  display none

:global(html.dark) .dev-confirm-warning
  border-color rgba(248, 113, 113, 0.28)
  background rgba(127, 29, 29, 0.34)
  color rgba(254, 202, 202, 0.96)

.dev-confirm-remember
  display flex
  align-items flex-start
  gap 0.7rem
  margin-top 0.9rem
  font-size 0.9rem
  line-height 1.55
  color var(--btn-content)
  cursor pointer

  input
    margin-top 0.15rem
    width 1rem
    height 1rem
    accent-color var(--primary)
    flex-shrink 0

.dev-confirm-remember-hint
  margin 0.42rem 0 0
  padding-left 1.72rem
  font-size 0.8rem
  line-height 1.55
  color rgba(148, 163, 184, 0.95)

.dev-confirm-actions
  display flex
  justify-content flex-end
  gap 0.6rem
  margin-top 1rem

.dev-confirm-btn
  min-width 6.25rem
  height 2.65rem
  padding 0 1rem
  border-radius 0.9rem
  font-size 0.9rem
  font-weight 700
  transition transform 0.18s ease, background 0.18s ease, border-color 0.18s ease, opacity 0.18s ease

  &:hover:not(:disabled)
    transform translateY(-1px)

  &:disabled
    opacity 0.58
    cursor not-allowed

.dev-confirm-btn.secondary
  border 1px solid var(--btn-regular-bg-hover)
  background var(--btn-regular-bg)
  color var(--btn-content)

.dev-confirm-btn.primary
  border 1px solid var(--primary)
  background var(--primary)
  color #fff

.dev-confirm-btn.warning
  border 1px solid rgba(245, 158, 11, 0.86)
  background rgba(245, 158, 11, 0.92)
  color #fff

.dev-confirm-btn.danger
  border 1px solid rgba(239, 68, 68, 0.82)
  background rgba(239, 68, 68, 0.92)
  color #fff

:global(#top-row),
:global(#banner-wrapper),
:global(#main-grid),
:global(#toc-wrapper),
:global(#back-to-top-btn)
  transition filter 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 240ms cubic-bezier(0.22, 1, 0.36, 1), transform 240ms cubic-bezier(0.22, 1, 0.36, 1)

:global(body.dev-confirm-dialog-active #top-row),
:global(body.dev-confirm-dialog-active #banner-wrapper),
:global(body.dev-confirm-dialog-active #main-grid),
:global(body.dev-confirm-dialog-active #toc-wrapper),
:global(body.dev-confirm-dialog-active #back-to-top-btn)
  filter grayscale(0.28) saturate(0.82) brightness(0.82)

@media (max-width: 640px)
  .dev-confirm-root
    padding 0.85rem

  .dev-confirm-panel
    width calc(100vw - 1rem)
    padding 1rem

  .dev-confirm-actions
    flex-direction column-reverse

  .dev-confirm-btn
    width 100%
</style>
