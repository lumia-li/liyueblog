<script lang="ts">
import DevConfirmDialog from "@components/editor/DevConfirmDialog.svelte";
import ToastUiEditor from "@toast-ui/editor";
import { readStoredDevCredential } from "@utils/dev-auth-client";
import {
	getDraftById,
	listDrafts,
	listDraftTrash,
	migrateLegacyDraft,
	removeDraft,
	saveDraft,
} from "@utils/dev-draft-utils";
import {
	clearDeveloperModeAutoLock,
	getDeveloperModeEnabled,
	scheduleDeveloperModeAutoLock,
} from "@utils/setting-utils";
import { onMount, tick } from "svelte";
import { cubicOut } from "svelte/easing";
import { fade, scale } from "svelte/transition";
import "@toast-ui/editor/dist/i18n/zh-cn";
import "@toast-ui/editor/dist/toastui-editor.css";

const AUTO_SAVE_INTERVAL = 12000;
const DEV_EDITOR_MARKDOWN_ONLY_STORAGE_KEY = "devEditorMarkdownOnlyMode";
const EDITOR_HEIGHT_RATIO = 0.68;
const EDITOR_MIN_HEIGHT = 520;
const EDITOR_MAX_HEIGHT = 820;

type EditorInstance = {
	getMarkdown: () => string;
	setMarkdown: (content: string) => void;
	on: (event: string, handler: () => void) => void;
	exec?: (name: string, payload?: Record<string, unknown>) => void;
	isMarkdownMode?: () => boolean;
	getSelection?: () => [number, number] | unknown;
	setSelection?: (start: number, end?: number) => void;
	replaceSelection?: (text: string, start?: number, end?: number) => void;
	setHeight?: (height: string) => void;
	changeMode?: (mode: "markdown" | "wysiwyg", withoutFocus?: boolean) => void;
	focus?: () => void;
	destroy: () => void;
};

let editorHost: HTMLDivElement | null = null;
let editor: EditorInstance | null = null;
let autoSaveTimer: ReturnType<typeof setInterval> | null = null;
let markdownFileInputElement: HTMLInputElement | null = null;
let modeSwitchElement: HTMLDivElement | null = null;
let modeSwitchIndicatorTranslateX = 0;
let modeSwitchIndicatorWidth = 0;
let modeSwitchDragging = false;
let modeSwitchDragStartPointerX = 0;
let modeSwitchDragStartTranslateX = 0;
let modeSwitchDragTranslateX = 0;

let mode: "post" | "thought" = "post";
let title = "";
let slug = "";
let originalSlug = "";
let description = "";
let tags = "";
let category = "";
let image = "";
let draft = false;
let published = "";
let coverUploadBusy = false;
let coverFileInputElement: HTMLInputElement | null = null;

function triggerCoverUpload() {
	if (coverUploadBusy) return;
	coverFileInputElement?.click();
}

async function handleCoverFileChange(event: Event) {
	const input = event.currentTarget as HTMLInputElement | null;
	const file = input?.files?.[0];
	if (!file || coverUploadBusy) return;
	try {
		coverUploadBusy = true;
		statusText = "封面上传中...";
		const devCodeHash = getStoredDevCredentialValue();
		if (!devCodeHash) {
			throw new Error("缺少开发者口令，请重新解锁开发者模式");
		}
		const formData = new FormData();
		formData.append("file", file, file.name);
		formData.append("devCodeHash", devCodeHash);
		formData.append("slugBase", slug || title || "cover");
		const response = await fetch("/api/dev/upload-cover", {
			method: "POST",
			body: formData,
		});
		const result = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			message?: string;
			fileName?: string;
		};
		if (!response.ok || !result.ok || !result.fileName) {
			throw new Error(result.message || "封面上传失败");
		}
		image = result.fileName;
		markDirty();
		statusText = "封面已上传";
		showNotice(`封面已上传：${result.fileName}`, "success");
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "封面上传失败";
		showNotice(message, "error");
		statusText = "封面上传失败";
	} finally {
		coverUploadBusy = false;
		if (input) {
			input.value = "";
		}
	}
}

let isLocked = true;
let isSubmitting = false;
let statusText = "等待输入";
let notice = "";
let noticeType: "info" | "success" | "error" = "info";
let localSlugConflictMessage = "";
let dirty = false;
let userTouchedSlug = false;
let editorInitError = "";
let activeDraftId = "";
let pendingDraftToLoad: ReturnType<typeof getDraftById> = null;
let showLoadDraftPrompt = false;
let editorFocused = false;
let markdownOnlyMode = false;
let toolbarIconObserver: MutationObserver | null = null;
let taskToolbarButtonElement: HTMLButtonElement | null = null;
let taskBubbleElement: HTMLDivElement | null = null;
let editorWorkspaceElement: HTMLDivElement | null = null;
let taskBubbleVisible = false;
let taskBubbleSelected = false;
let taskBubbleAnchorX = 0;
let taskBubbleAnchorY = 0;
let taskBubbleHideTimer: ReturnType<typeof setTimeout> | null = null;
let isSanitizingDataImageMarkdown = false;
let pendingImageUploads = 0;
let dataImageSanitizeTimer: ReturnType<typeof setTimeout> | null = null;
let imageUploadQueue: Promise<void> = Promise.resolve();

const TOOLBAR_ICON_STROKE_WIDTH = "2.05";
const DETAILS_PLACEHOLDER_TAG = "details-placeholder";
const MARKDOWN_ONLY_TAB_CLASS = "dev-markdown-only-tab";
const EDITOR_LINK_URL_INPUT_ID = "toastuiLinkUrlInput";
const EDITOR_LINK_TEXT_INPUT_ID = "toastuiLinkTextInput";
const EDITOR_LINK_TOOLTIP_INPUT_ID = "devEditorLinkTooltipInput";
const EDITOR_LINK_POPUP_SELECTOR = ".toastui-editor-popup-add-link";
const URL_HAS_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;
const IMAGE_PREVIEW_MIN_SCALE = 0.2;
const IMAGE_PREVIEW_MAX_SCALE = 6;
const IMAGE_PREVIEW_WHEEL_STEP = 0.12;
const IMAGE_PREVIEW_INITIAL_SCALE = 0.86;
const DOMAIN_LIKE_URL_PATTERN =
	/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#].*)?$/i;
const IMAGE_PREVIEW_HEADING_PREFIX = "图片预览：";
const BROKEN_IMAGE_FALLBACK_ALT = "图片坏掉啦呜呜呜";
const DATA_IMAGE_SANITIZE_DEBOUNCE_MS = 650;
const IMAGE_UPLOAD_MAX_RETRIES = 3;
const IMAGE_UPLOAD_RETRY_BASE_DELAY_MS = 450;
const IMAGE_URL_VERIFY_RETRIES = 6;
const IMAGE_URL_VERIFY_DELAY_MS = 150;
const TASK_BUBBLE_HIDE_DELAY_MS = 130;
const CODE_COPY_BUTTON_CLASS = "dev-code-copy-btn";
const CODE_COPY_BLOCK_CLASS = "dev-code-block-with-copy";
const CODE_COPY_RESET_DELAY_MS = 1200;
const CODE_COPY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>`;
const CODE_CHECK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;

let imagePreviewVisible = false;
let imagePreviewSrc = "";
let imagePreviewAlt = "";
let imagePreviewScale = 1;
let lastLinkPopupSelectionOffsets: [number, number] | null = null;
let linkConfirmVisible = false;
let pendingLinkUrl = "";
let pendingLinkText = "";
let imageDeleteConfirmVisible = false;
let imageDeleteBusy = false;
let pendingDeleteImageSrc = "";
let pendingDeleteImageAlt = "";
let pendingDeleteImageRepoPath = "";
let contextMenuVisible = false;
let contextMenuX = 0;
let contextMenuY = 0;
let contextMenuType: "text" | "image" = "text";
let contextMenuImageSrc = "";
let contextMenuImageAlt = "";
let contextMenuImageElement: HTMLImageElement | null = null;
let contextMenuElement: HTMLDivElement | null = null;
type ContextMenuTextEffectKey =
	| "bold"
	| "italic"
	| "strike"
	| "code"
	| "codeBlock";
type ContextMenuTextEffectState = Record<ContextMenuTextEffectKey, boolean>;
const DEFAULT_CONTEXT_MENU_TEXT_EFFECT_STATE: ContextMenuTextEffectState = {
	bold: false,
	italic: false,
	strike: false,
	code: false,
	codeBlock: false,
};
let contextMenuTextEffectState: ContextMenuTextEffectState = {
	...DEFAULT_CONTEXT_MENU_TEXT_EFFECT_STATE,
};
let isAppleDevice = false;
let imageEditVisible = false;
let imageEditSrc = "";
let imageEditAlt = "";
let captionEditVisible = false;
let captionEditSrc = "";
let captionEditValue = "";
let imageEditStageElement: HTMLDivElement | null = null;
let imageEditPreviewImageElement: HTMLImageElement | null = null;
let imageEditZoom = 1;
let imageEditPanX = 0;
let imageEditPanY = 0;
let imageEditPanning = false;
let imageEditPanStartX = 0;
let imageEditPanStartY = 0;
let imageEditPanBaseX = 0;
let imageEditPanBaseY = 0;
let imageEditNaturalWidth = 0;
let imageEditNaturalHeight = 0;
let imageEditCropX = 0;
let imageEditCropY = 0;
let imageEditCropWidth = 0;
let imageEditCropHeight = 0;
let imageEditPreviewOffsetX = 0;
let imageEditPreviewOffsetY = 0;
let imageEditSourceX = 0;
let imageEditSourceY = 0;
let imageEditSourceWidth = 0;
let imageEditSourceHeight = 0;
let imageEditLockSquare = false;
type ImageEditResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
let imageEditResizing = false;
let imageEditResizeHandle: ImageEditResizeHandle | null = null;
let imageEditResizeBaseX = 0;
let imageEditResizeBaseY = 0;
let imageEditResizeBaseWidth = 0;
let imageEditResizeBaseHeight = 0;
let imageEditMoving = false;
let imageEditMoveStartPointerX = 0;
let imageEditMoveStartPointerY = 0;
let imageEditMoveBaseX = 0;
let imageEditMoveBaseY = 0;
let imageEditMoveBaseWidth = 0;
let imageEditMoveBaseHeight = 0;
let imageEditDragging = false;
let imageEditDragStartX = 0;
let imageEditDragStartY = 0;
let imageEditCropEnabled = false;
const dataImageUploadCache = new Map<string, string>();
const IMAGE_EDIT_HUGE_IMAGE_THRESHOLD = 2400;

function detectAppleDevice(): boolean {
	if (typeof navigator === "undefined") return false;
	const platformCandidate =
		(navigator as Navigator & { userAgentData?: { platform?: string } })
			.userAgentData?.platform ||
		navigator.platform ||
		navigator.userAgent;
	return /mac|iphone|ipad|ipod/i.test(platformCandidate);
}

function markDirty() {
	if (showLoadDraftPrompt) {
		pendingDraftToLoad = null;
		showLoadDraftPrompt = false;
	}
	dirty = true;
	statusText = "编辑中...";
}

function toSafeMarkdownFileName(value: string): string {
	const base = slugify(value || "") || "post";
	return `${base}.md`;
}

function toYamlScalar(value: string): string {
	const text = (value || "").replace(/\r\n/g, "\n");
	if (!text) return '""';
	return JSON.stringify(text);
}

function buildExportMarkdownContent(): string {
	const normalizedContent = getEditorMarkdownNormalized().trim();
	const publishedValue =
		(published || "").trim() || new Date().toISOString().slice(0, 10);
	if (mode === "thought") {
		return `---
title: ${toYamlScalar(title)}
published: ${publishedValue}
description: ${toYamlScalar(description)}
---

${normalizedContent}\n`;
	}
	const tagItems = tags
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	const tagLines = tagItems.length
		? tagItems.map((item) => `  - ${toYamlScalar(item)}`).join("\n")
		: "  - ";
	return `---
title: ${toYamlScalar(title)}
published: ${publishedValue}
description: ${toYamlScalar(description)}
image: ${toYamlScalar(image)}
tags:
${tagLines}
category: ${toYamlScalar(category)}
draft: ${draft ? "true" : "false"}
---

${normalizedContent}\n`;
}

function exportMarkdownFile(): void {
	if (!editor) {
		showNotice("编辑器还没加载完成，请稍等", "error");
		return;
	}
	const filename = toSafeMarkdownFileName(slug || title || "post");
	const content = buildExportMarkdownContent();
	const blob = new Blob([content], {
		type: "text/markdown;charset=utf-8",
	});
	const objectUrl = URL.createObjectURL(blob);
	try {
		const link = document.createElement("a");
		link.href = objectUrl;
		link.download = filename;
		link.rel = "noopener";
		document.body.appendChild(link);
		link.click();
		link.remove();
		statusText = "已导出 Markdown";
		showNotice(`已导出 ${filename}`, "success");
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

function triggerMarkdownImport(): void {
	if (!editor) {
		showNotice("编辑器还没加载完成，请稍等", "error");
		return;
	}
	markdownFileInputElement?.click();
}

function unquoteYamlValue(input: string): string {
	const value = input.trim();
	if (!value) return "";
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		const inner = value.slice(1, -1);
		if (value.startsWith('"')) {
			return inner
				.replace(/\\n/g, "\n")
				.replace(/\\"/g, '"')
				.replace(/\\\\/g, "\\");
		}
		return inner.replace(/''/g, "'");
	}
	return value;
}

type ImportedFrontmatter = {
	title?: string;
	slug?: string;
	description?: string;
	image?: string;
	tags?: string[];
	category?: string;
	published?: string;
	draft?: boolean;
};

function parseFrontmatterBlock(source: string): {
	frontmatter: ImportedFrontmatter;
	content: string;
} {
	const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n)?/);
	if (!match) {
		return { frontmatter: {}, content: source };
	}
	const block = match[1] || "";
	const content = source.slice(match[0].length);
	const lines = block.split(/\r?\n/);
	const frontmatter: ImportedFrontmatter = {};
	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index] || "";
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const kvMatch = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
		if (!kvMatch) continue;
		const key = kvMatch[1].toLowerCase();
		const rawValue = kvMatch[2] || "";
		if (key === "tags") {
			const parsedTags: string[] = [];
			const inline = unquoteYamlValue(rawValue);
			if (inline.startsWith("[") && inline.endsWith("]")) {
				const body = inline.slice(1, -1);
				for (const item of body.split(",")) {
					const value = unquoteYamlValue(item);
					if (value) parsedTags.push(value);
				}
			} else if (inline) {
				for (const item of inline.split(",")) {
					const value = unquoteYamlValue(item);
					if (value) parsedTags.push(value);
				}
			}
			while (index + 1 < lines.length) {
				const next = lines[index + 1] || "";
				const bullet = next.match(/^\s*-\s*(.+)\s*$/);
				if (!bullet) break;
				const value = unquoteYamlValue(bullet[1] || "");
				if (value) parsedTags.push(value);
				index += 1;
			}
			frontmatter.tags = parsedTags;
			continue;
		}
		const value = unquoteYamlValue(rawValue);
		if (key === "title") frontmatter.title = value;
		if (key === "slug") frontmatter.slug = value;
		if (key === "description") frontmatter.description = value;
		if (key === "image") frontmatter.image = value;
		if (key === "category") frontmatter.category = value;
		if (key === "published") frontmatter.published = value;
		if (key === "draft") {
			frontmatter.draft = /^(true|1|yes)$/i.test(value);
		}
	}
	return { frontmatter, content };
}

async function handleMarkdownFileUpload(event: Event): Promise<void> {
	if (!editor) {
		showNotice("编辑器还没加载完成，请稍等", "error");
		return;
	}
	const input = event.currentTarget as HTMLInputElement | null;
	const file = input?.files?.[0];
	if (!file) return;
	try {
		const source = await file.text();
		const parsed = parseFrontmatterBlock(source.replace(/^\uFEFF/, ""));
		const nextMarkdown = normalizeEditorUploadImageUrls(
			cleanupLegacyDetailsArtifacts(
				parsed.content.replace(/\r\n/g, "\n").trim(),
			),
		);
		if (!nextMarkdown) {
			showNotice("上传的 Markdown 内容为空", "error");
			return;
		}
		if (parsed.frontmatter.title !== undefined)
			title = parsed.frontmatter.title;
		if (parsed.frontmatter.slug !== undefined) {
			slug = parsed.frontmatter.slug;
			userTouchedSlug = true;
		}
		if (parsed.frontmatter.description !== undefined) {
			description = parsed.frontmatter.description;
		}
		if (parsed.frontmatter.image !== undefined)
			image = parsed.frontmatter.image;
		if (parsed.frontmatter.tags !== undefined) {
			tags = parsed.frontmatter.tags.join(", ");
		}
		if (parsed.frontmatter.category !== undefined) {
			category = parsed.frontmatter.category;
		}
		if (parsed.frontmatter.published !== undefined) {
			published = parsed.frontmatter.published;
		}
		if (parsed.frontmatter.draft !== undefined) {
			draft = parsed.frontmatter.draft;
		}
		editor.setMarkdown(nextMarkdown);
		markDirty();
		statusText = "已导入 Markdown";
		showNotice(`已导入 ${file.name}`, "success");
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "读取 Markdown 失败";
		showNotice(message, "error");
	} finally {
		if (input) {
			input.value = "";
		}
	}
}

function buildToolbarSvg(paths: string): string {
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${TOOLBAR_ICON_STROKE_WIDTH}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

const TOOLBAR_SVG_ICON_MAP: Record<string, string> = {
	heading: buildToolbarSvg('<path d="M8 6v12M16 6v12M8 12h8"></path>'),
	bold: buildToolbarSvg(
		'<path d="M14 12a4 4 0 0 0 0-8H8v8M15 20a4 4 0 0 0 0-8H8v8"></path>',
	),
	italic: buildToolbarSvg('<path d="M19 4h-9M14 20H5M15 4 9 20"></path>'),
	strike: buildToolbarSvg(
		'<path d="M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16"></path>',
	),
	hrline: buildToolbarSvg(
		'<path d="M5 12h14M5 9h2M17 9h2M5 15h2M17 15h2"></path>',
	),
	quote: buildToolbarSvg(
		'<path d="M9 9H5v5h4l2-3V9Zm10 0h-4v5h4l2-3V9Z"></path>',
	),
	"bullet-list": buildToolbarSvg(
		'<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"></path>',
	),
	"ordered-list": buildToolbarSvg(
		'<path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"></path>',
	),
	"task-list": buildToolbarSvg(
		'<path d="M10 6h10M10 12h10M10 18h10M3.5 6.2l1.2 1.2 2.3-2.3M3.5 12.2l1.2 1.2 2.3-2.3M3.5 18.2l1.2 1.2 2.3-2.3"></path>',
	),
	indent: buildToolbarSvg(
		'<path d="M4 6h16M8 12h12M4 18h16M10 9l3 3-3 3"></path>',
	),
	outdent: buildToolbarSvg(
		'<path d="M4 6h16M4 12h12M4 18h16M10 9 7 12l3 3"></path>',
	),
	table: buildToolbarSvg(
		'<rect x="3.5" y="5" width="17" height="14" rx="1"></rect><path d="M3.5 10h17M9 5v14M15 5v14"></path>',
	),
	link: buildToolbarSvg(
		'<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>',
	),
	image: buildToolbarSvg(
		'<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="9" cy="9" r="2"></circle><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"></path>',
	),
	code: buildToolbarSvg('<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"></path>'),
	codeblock: buildToolbarSvg(
		'<path d="m9 9-3 3 3 3M15 9l3 3-3 3M4 5h16M4 19h16"></path>',
	),
	more: buildToolbarSvg('<path d="M6 12h.01M12 12h.01M18 12h.01"></path>'),
};

type HtmlToken = {
	type: "openTag" | "closeTag" | "html" | "text";
	tagName?: string;
	content?: string;
	attributes?: Record<string, string>;
	outerNewLine?: boolean;
};

type CustomHtmlNode = {
	wysiwygNode?: boolean;
	literal?: string | null;
	attrs?: Record<string, string>;
	childrenHTML?: string;
};

function renderLiteralHtmlToken(
	node: CustomHtmlNode,
	outerNewLine = false,
): HtmlToken {
	return {
		type: "html",
		content: typeof node.literal === "string" ? node.literal : "",
		...(outerNewLine ? { outerNewLine: true } : {}),
	};
}

function renderWysiwygHtmlBlockTokens(
	tagName: string,
	node: CustomHtmlNode,
	outerNewLine = false,
): HtmlToken[] {
	const tokens: HtmlToken[] = [
		{
			type: "openTag",
			tagName,
			attributes: node.attrs || {},
			...(outerNewLine ? { outerNewLine: true } : {}),
		},
	];
	if (node.childrenHTML) {
		tokens.push({
			type: "html",
			content: node.childrenHTML,
		});
	}
	tokens.push({
		type: "closeTag",
		tagName,
		...(outerNewLine ? { outerNewLine: true } : {}),
	});
	return tokens;
}

const CUSTOM_DETAILS_HTML_RENDERER = {
	htmlBlock: {
		details: (node: CustomHtmlNode): HtmlToken | HtmlToken[] => {
			if (!node.wysiwygNode) {
				return renderLiteralHtmlToken(node, true);
			}
			return renderWysiwygHtmlBlockTokens("details", node, true);
		},
	},
};

function getToolbarIconName(button: Element): string | null {
	for (const className of button.classList) {
		if (
			className !== "toastui-editor-toolbar-icons" &&
			className !== "active"
		) {
			return className;
		}
	}
	return null;
}

function applyToolbarSvgIcons() {
	if (!editorHost) return;
	const buttons = editorHost.querySelectorAll<HTMLButtonElement>(
		".toastui-editor-defaultUI-toolbar .toastui-editor-toolbar-icons",
	);
	for (const button of buttons) {
		const iconName = getToolbarIconName(button);
		if (!iconName) continue;
		const iconSvg = TOOLBAR_SVG_ICON_MAP[iconName];
		if (!iconSvg) continue;
		if (button.dataset.svgIconName === iconName) continue;
		button.innerHTML = iconSvg;
		button.dataset.svgIconName = iconName;
	}
}

function syncToolbarSvgIconsSoon() {
	window.requestAnimationFrame(() => {
		applyToolbarSvgIcons();
	});
}

function startToolbarIconObserver() {
	if (!editorHost) return;
	const toolbar = editorHost.querySelector<HTMLElement>(
		".toastui-editor-defaultUI-toolbar",
	);
	if (!toolbar) return;
	if (toolbarIconObserver) {
		toolbarIconObserver.disconnect();
	}
	toolbarIconObserver = new MutationObserver(() => {
		syncToolbarSvgIconsSoon();
	});
	toolbarIconObserver.observe(toolbar, {
		childList: true,
		subtree: true,
	});
}

function stopToolbarIconObserver() {
	if (!toolbarIconObserver) return;
	toolbarIconObserver.disconnect();
	toolbarIconObserver = null;
}

function markdownPosToOffset(markdown: string, pos: unknown): number | null {
	if (!Array.isArray(pos) || pos.length < 2) return null;
	const [lineRaw, columnRaw] = pos;
	if (!Number.isInteger(lineRaw) || !Number.isInteger(columnRaw)) return null;
	const line = Number(lineRaw);
	const column = Number(columnRaw);
	if (line < 1 || column < 1) return null;
	const lines = markdown.split("\n");
	if (line > lines.length) return markdown.length;
	let offset = 0;
	for (let i = 0; i < line - 1; i += 1) {
		offset += lines[i].length + 1;
	}
	const lineText = lines[line - 1] || "";
	return offset + Math.min(column - 1, lineText.length);
}

function getEditorSelectionOffsets(): [number, number] | null {
	if (!editor) return null;
	const selection = editor.getSelection?.();
	if (!selection) return null;
	if (
		Array.isArray(selection) &&
		selection.length >= 2 &&
		Number.isInteger(selection[0]) &&
		Number.isInteger(selection[1])
	) {
		const from = Number(selection[0]);
		const to = Number(selection[1]);
		return from <= to ? [from, to] : [to, from];
	}
	if (
		Array.isArray(selection) &&
		selection.length >= 2 &&
		Array.isArray(selection[0]) &&
		Array.isArray(selection[1])
	) {
		const markdown = editor.getMarkdown();
		const from = markdownPosToOffset(markdown, selection[0]);
		const to = markdownPosToOffset(markdown, selection[1]);
		if (from === null || to === null) return null;
		return from <= to ? [from, to] : [to, from];
	}
	return null;
}

function tryToggleMarkdownInlineMark(command: "bold" | "italic"): boolean {
	if (!editor?.isMarkdownMode?.()) return false;
	const range = getEditorSelectionOffsets();
	if (!range) return false;
	const token = command === "bold" ? "**" : "*";
	const tokenLength = token.length;
	const [rawFrom, rawTo] = range;
	const markdown = editor.getMarkdown();
	if (rawFrom < 0 || rawTo > markdown.length) return false;

	const hasOuterTokenWrap =
		rawFrom >= tokenLength &&
		rawTo + tokenLength <= markdown.length &&
		markdown.slice(rawFrom - tokenLength, rawFrom) === token &&
		markdown.slice(rawTo, rawTo + tokenLength) === token;
	if (hasOuterTokenWrap) {
		const inner = markdown.slice(rawFrom, rawTo);
		editor.replaceSelection?.(
			inner,
			rawFrom - tokenLength,
			rawTo + tokenLength,
		);
		editor.setSelection?.(rawFrom - tokenLength, rawTo - tokenLength);
		return true;
	}

	const selected = markdown.slice(rawFrom, rawTo);
	if (
		selected.length >= tokenLength * 2 &&
		selected.startsWith(token) &&
		selected.endsWith(token)
	) {
		const inner = selected.slice(tokenLength, selected.length - tokenLength);
		editor.replaceSelection?.(inner, rawFrom, rawTo);
		editor.setSelection?.(rawFrom, rawFrom + inner.length);
		return true;
	}

	return false;
}

function tryToggleMarkdownStrike(): boolean {
	if (!editor?.isMarkdownMode?.()) return false;
	const range = getEditorSelectionOffsets();
	if (!range) return false;
	const token = "~~";
	const tokenLength = token.length;
	const [rawFrom, rawTo] = range;
	const markdown = editor.getMarkdown();
	if (rawFrom < 0 || rawTo > markdown.length) return false;

	if (rawFrom === rawTo) {
		const inserted = `${token}${token}`;
		editor.replaceSelection?.(inserted, rawFrom, rawTo);
		editor.setSelection?.(rawFrom + tokenLength, rawFrom + tokenLength);
		return true;
	}

	const hasOuterTokenWrap =
		rawFrom >= tokenLength &&
		rawTo + tokenLength <= markdown.length &&
		markdown.slice(rawFrom - tokenLength, rawFrom) === token &&
		markdown.slice(rawTo, rawTo + tokenLength) === token;
	if (hasOuterTokenWrap) {
		const inner = markdown.slice(rawFrom, rawTo);
		editor.replaceSelection?.(
			inner,
			rawFrom - tokenLength,
			rawTo + tokenLength,
		);
		editor.setSelection?.(rawFrom - tokenLength, rawTo - tokenLength);
		return true;
	}

	const selected = markdown.slice(rawFrom, rawTo);
	if (
		selected.length >= tokenLength * 2 &&
		selected.startsWith(token) &&
		selected.endsWith(token)
	) {
		const inner = selected.slice(tokenLength, selected.length - tokenLength);
		editor.replaceSelection?.(inner, rawFrom, rawTo);
		editor.setSelection?.(rawFrom, rawFrom + inner.length);
		return true;
	}

	editor.replaceSelection?.(`${token}${selected}${token}`, rawFrom, rawTo);
	editor.setSelection?.(
		rawFrom + tokenLength,
		rawFrom + tokenLength + selected.length,
	);
	return true;
}

type MarkdownListCommand = "ul" | "ol";

function stripMarkdownListMarker(line: string): {
	indent: string;
	content: string;
	isUnordered: boolean;
	isOrdered: boolean;
} {
	const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
	if (unorderedMatch) {
		return {
			indent: unorderedMatch[1] || "",
			content: unorderedMatch[2] || "",
			isUnordered: true,
			isOrdered: false,
		};
	}
	const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
	if (orderedMatch) {
		return {
			indent: orderedMatch[1] || "",
			content: orderedMatch[2] || "",
			isUnordered: false,
			isOrdered: true,
		};
	}
	const rawMatch = line.match(/^(\s*)(.*)$/);
	return {
		indent: rawMatch?.[1] || "",
		content: rawMatch?.[2] || "",
		isUnordered: false,
		isOrdered: false,
	};
}

function tryToggleMarkdownList(command: MarkdownListCommand): boolean {
	if (!editor?.isMarkdownMode?.()) return false;
	const range = getEditorSelectionOffsets();
	if (!range) return false;
	const [rawFrom, rawTo] = range;
	const markdown = editor.getMarkdown();
	if (rawFrom < 0 || rawTo > markdown.length) return false;

	const blockStart = markdown.lastIndexOf("\n", Math.max(0, rawFrom - 1)) + 1;
	let blockEnd = markdown.indexOf("\n", rawTo);
	if (blockEnd === -1) blockEnd = markdown.length;
	const selectedBlock = markdown.slice(blockStart, blockEnd);
	const lines = selectedBlock.split("\n");
	const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
	if (!nonEmptyLines.length) return false;

	const allUnordered = nonEmptyLines.every((line) =>
		/^(\s*)[-*+]\s+/.test(line),
	);
	const allOrdered = nonEmptyLines.every((line) => /^(\s*)\d+\.\s+/.test(line));

	let orderedCounter = 1;
	const transformed = lines.map((line) => {
		if (!line.trim()) return line;
		const normalized = stripMarkdownListMarker(line);
		if (command === "ul") {
			if (allUnordered) {
				return `${normalized.indent}${normalized.content}`;
			}
			return `${normalized.indent}- ${normalized.content}`;
		}
		if (allOrdered) {
			return `${normalized.indent}${normalized.content}`;
		}
		const next = `${normalized.indent}${orderedCounter}. ${normalized.content}`;
		orderedCounter += 1;
		return next;
	});

	const replaced = transformed.join("\n");
	editor.replaceSelection?.(replaced, blockStart, blockEnd);
	editor.setSelection?.(blockStart, blockStart + replaced.length);
	return true;
}

function bindToolbarInlineMarkCoexistence(host: HTMLElement): () => void {
	void host;
	return () => {};
}

function clearTaskBubbleHideTimer(): void {
	if (!taskBubbleHideTimer) return;
	clearTimeout(taskBubbleHideTimer);
	taskBubbleHideTimer = null;
}

function hideTaskToolbarBubble(): void {
	clearTaskBubbleHideTimer();
	taskBubbleVisible = false;
	taskToolbarButtonElement = null;
}

function scheduleTaskToolbarBubbleHide(): void {
	clearTaskBubbleHideTimer();
	taskBubbleHideTimer = setTimeout(() => {
		hideTaskToolbarBubble();
	}, TASK_BUBBLE_HIDE_DELAY_MS);
}

function syncTaskBubblePosition(): void {
	if (
		!taskBubbleVisible ||
		!taskToolbarButtonElement ||
		!editorWorkspaceElement
	) {
		return;
	}
	const buttonRect = taskToolbarButtonElement.getBoundingClientRect();
	const workspaceRect = editorWorkspaceElement.getBoundingClientRect();
	taskBubbleAnchorX =
		buttonRect.left - workspaceRect.left + buttonRect.width / 2;
	taskBubbleAnchorY = buttonRect.bottom - workspaceRect.top + 8;
}

function showTaskToolbarBubble(button: HTMLButtonElement): void {
	taskToolbarButtonElement = button;
	taskBubbleSelected = readTaskCheckedStateFromEditorSelection();
	taskBubbleVisible = true;
	clearTaskBubbleHideTimer();
	syncTaskBubblePosition();
}

function readTaskCheckedStateFromEditorSelection(): boolean {
	if (!editor) return false;
	const range = getEditorSelectionOffsets();
	if (!range) return false;
	const markdown = editor.getMarkdown();
	let [from, to] = range;
	if (from < 0 || to < 0 || from > markdown.length || to > markdown.length) {
		return false;
	}
	if (from > to) {
		[from, to] = [to, from];
	}
	if (from === to) {
		const lineStart = markdown.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
		let lineEnd = markdown.indexOf("\n", from);
		if (lineEnd === -1) lineEnd = markdown.length;
		const line = markdown.slice(lineStart, lineEnd);
		const marker = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+/);
		return marker ? marker[1].toLowerCase() === "x" : false;
	}
	const selection = markdown.slice(from, to);
	const marker = selection.match(/^\s*[-*+]\s+\[( |x|X)\]\s+/m);
	return marker ? marker[1].toLowerCase() === "x" : false;
}

function buildTaskMarkdownByState(source: string, checked: boolean): string {
	const normalizedText = source.replace(/\r\n/g, "\n");
	const lines = normalizedText.split("\n");
	const contentLines = lines.some((line) => line.trim().length > 0)
		? lines
		: [checked ? "已选择" : "未选择"];
	return contentLines
		.map((line) => {
			if (!line.trim()) return line;
			const clean = line.replace(/^\s*[-*+]\s+\[(?: |x|X)\]\s+/, "").trim();
			return `- [${checked ? "x" : " "}] ${clean || (checked ? "已选择" : "未选择")}`;
		})
		.join("\n");
}

function insertTaskFromBubble(checked: boolean): void {
	const selected = readEditorSelectionText();
	const taskMarkdown = buildTaskMarkdownByState(selected, checked);
	const inserted = insertTextIntoActiveEditor(taskMarkdown);
	showNotice(
		inserted
			? `任务项已设为${checked ? "已选择" : "未选择"}`
			: "请先把光标放到编辑区",
		inserted ? "success" : "error",
	);
	if (inserted) {
		taskBubbleSelected = checked;
	}
	hideTaskToolbarBubble();
}

function handleTaskBubblePointerEnter(): void {
	clearTaskBubbleHideTimer();
}

function handleTaskBubblePointerLeave(): void {
	scheduleTaskToolbarBubbleHide();
}

function bindTaskToolbarBubble(host: HTMLElement): () => void {
	const toolbar = host.querySelector<HTMLElement>(
		".toastui-editor-defaultUI-toolbar",
	);
	if (!toolbar) {
		return () => {};
	}

	const findTaskButton = (
		target: EventTarget | null,
	): HTMLButtonElement | null => {
		if (!(target instanceof Element)) return null;
		const button = target.closest(
			[
				"button.toastui-editor-toolbar-icons.task",
				"button.toastui-editor-toolbar-icons.task-list",
				"button.toastui-editor-toolbar-icons[data-svg-icon-name='task-list']",
			].join(","),
		);
		return button instanceof HTMLButtonElement ? button : null;
	};

	const handleToolbarMouseOver = (event: MouseEvent) => {
		const taskButton = findTaskButton(event.target);
		if (!taskButton) return;
		showTaskToolbarBubble(taskButton);
	};

	const handleToolbarMouseOut = (event: MouseEvent) => {
		const taskButton = findTaskButton(event.target);
		if (!taskButton) return;
		const next = event.relatedTarget;
		if (
			next instanceof Node &&
			(taskButton.contains(next) || taskBubbleElement?.contains(next))
		) {
			return;
		}
		scheduleTaskToolbarBubbleHide();
	};

	const handleToolbarFocusIn = (event: FocusEvent) => {
		const taskButton = findTaskButton(event.target);
		if (!taskButton) return;
		showTaskToolbarBubble(taskButton);
	};

	const handleToolbarFocusOut = (event: FocusEvent) => {
		const taskButton = findTaskButton(event.target);
		if (!taskButton) return;
		const next = event.relatedTarget;
		if (
			next instanceof Node &&
			(taskButton.contains(next) || taskBubbleElement?.contains(next))
		) {
			return;
		}
		scheduleTaskToolbarBubbleHide();
	};

	const handleWindowResize = () => {
		syncTaskBubblePosition();
	};

	const handleWindowScroll = () => {
		syncTaskBubblePosition();
	};

	toolbar.addEventListener("mouseover", handleToolbarMouseOver, true);
	toolbar.addEventListener("mouseout", handleToolbarMouseOut, true);
	toolbar.addEventListener("focusin", handleToolbarFocusIn, true);
	toolbar.addEventListener("focusout", handleToolbarFocusOut, true);
	window.addEventListener("resize", handleWindowResize);
	window.addEventListener("scroll", handleWindowScroll, true);

	return () => {
		toolbar.removeEventListener("mouseover", handleToolbarMouseOver, true);
		toolbar.removeEventListener("mouseout", handleToolbarMouseOut, true);
		toolbar.removeEventListener("focusin", handleToolbarFocusIn, true);
		toolbar.removeEventListener("focusout", handleToolbarFocusOut, true);
		window.removeEventListener("resize", handleWindowResize);
		window.removeEventListener("scroll", handleWindowScroll, true);
		hideTaskToolbarBubble();
	};
}

function normalizeInsertedLinkUrl(input: string): string {
	const value = input.trim();
	if (!value) return "";
	if (value.startsWith("/") || value.startsWith("#")) {
		return value;
	}
	if (value.startsWith("//")) {
		return `https:${value}`;
	}
	if (URL_HAS_SCHEME_PATTERN.test(value)) {
		return value;
	}
	if (value.startsWith("www.") || DOMAIN_LIKE_URL_PATTERN.test(value)) {
		return `https://${value}`;
	}
	return value;
}

function normalizeLinkPopupInputValue(scope: ParentNode): void {
	const input = scope.querySelector<HTMLInputElement>(
		`#${EDITOR_LINK_URL_INPUT_ID}`,
	);
	if (!input) return;
	const normalizedUrl = normalizeInsertedLinkUrl(input.value);
	if (!normalizedUrl || normalizedUrl === input.value) return;
	input.value = normalizedUrl;
}

function normalizeLinkTooltipText(input: string): string {
	return input.replace(/\s+/g, " ").trim();
}

function escapeMarkdownLinkText(input: string): string {
	return input.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
}

function escapeMarkdownLinkTitle(input: string): string {
	return input.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function getSelectionAnchorElement(): HTMLAnchorElement | null {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return null;
	const anchorNode = selection.anchorNode;
	if (!anchorNode) return null;
	if (anchorNode instanceof HTMLAnchorElement) return anchorNode;
	const anchorElement =
		anchorNode instanceof Element ? anchorNode : anchorNode.parentElement;
	if (!anchorElement) return null;
	const nearestLink = anchorElement.closest("a[href]");
	return nearestLink instanceof HTMLAnchorElement ? nearestLink : null;
}

function applyTooltipToRecentWysiwygLink(
	host: HTMLElement,
	linkUrl: string,
	tooltip: string,
): void {
	const normalizeForCompare = (value: string): string => {
		const resolved = resolveEditorLinkUrl(value);
		if (!resolved) return value.trim();
		try {
			const parsed = new URL(resolved);
			const normalizedPath = parsed.pathname.replace(/\/+$/, "") || "/";
			return `${parsed.protocol}//${parsed.host}${normalizedPath}${parsed.search}${parsed.hash}`;
		} catch {
			return resolved;
		}
	};

	const normalizedTarget = normalizeForCompare(linkUrl);
	const fromSelection = getSelectionAnchorElement();
	if (fromSelection && host.contains(fromSelection)) {
		fromSelection.setAttribute("title", tooltip);
		return;
	}
	const links = host.querySelectorAll<HTMLAnchorElement>(
		".toastui-editor-ww-container .toastui-editor-contents a[href]",
	);
	for (let i = links.length - 1; i >= 0; i -= 1) {
		const candidate = links[i];
		const hrefValue = candidate.getAttribute("href") || candidate.href || "";
		const normalizedHref = normalizeForCompare(hrefValue);
		if (
			hrefValue === linkUrl ||
			normalizedHref === normalizedTarget ||
			resolveEditorLinkUrl(hrefValue) === linkUrl
		) {
			candidate.setAttribute("title", tooltip);
			return;
		}
	}
	const fallback = links[links.length - 1];
	if (fallback) {
		fallback.setAttribute("title", tooltip);
	}
}

function ensureLinkPopupTooltipInput(
	host: HTMLElement,
	resetValue = false,
): HTMLInputElement | null {
	const popup = host.querySelector<HTMLElement>(EDITOR_LINK_POPUP_SELECTOR);
	if (!popup) return null;
	const popupBody = popup.querySelector<HTMLElement>(
		".toastui-editor-popup-body",
	);
	if (!popupBody) return null;

	let tooltipInput = popupBody.querySelector<HTMLInputElement>(
		`#${EDITOR_LINK_TOOLTIP_INPUT_ID}`,
	);
	if (!tooltipInput) {
		const buttonContainer = popupBody.querySelector<HTMLElement>(
			".toastui-editor-button-container",
		);
		const popupBodyInner = buttonContainer?.parentElement;
		if (!buttonContainer || !popupBodyInner) {
			return null;
		}
		const tooltipLabel = document.createElement("label");
		tooltipLabel.htmlFor = EDITOR_LINK_TOOLTIP_INPUT_ID;
		tooltipLabel.textContent = "悬浮提示";
		tooltipInput = document.createElement("input");
		tooltipInput.id = EDITOR_LINK_TOOLTIP_INPUT_ID;
		tooltipInput.type = "text";
		tooltipInput.placeholder = "可选，鼠标悬停时显示";
		tooltipInput.autocomplete = "off";
		popupBodyInner.insertBefore(tooltipLabel, buttonContainer);
		popupBodyInner.insertBefore(tooltipInput, buttonContainer);
	}

	const urlInput = popupBody.querySelector<HTMLInputElement>(
		`#${EDITOR_LINK_URL_INPUT_ID}`,
	);
	const linkTextInput = popupBody.querySelector<HTMLInputElement>(
		`#${EDITOR_LINK_TEXT_INPUT_ID}`,
	);
	if (urlInput && !urlInput.placeholder) {
		urlInput.placeholder = "请输入链接地址";
	}
	if (linkTextInput && !linkTextInput.placeholder) {
		linkTextInput.placeholder = "请输入链接文本";
	}
	if (resetValue) {
		tooltipInput.value = "";
	}
	return tooltipInput;
}

function removeDuplicatePlainLinkAfterTooltipInsert(
	markdownLink: string,
	plainMarkdownLink: string,
	startOffset: number,
): void {
	if (!editor) return;
	const currentMarkdown = editor.getMarkdown();
	const insertedIndex = currentMarkdown.indexOf(markdownLink, startOffset);
	if (insertedIndex < 0) return;
	const duplicateIndex = insertedIndex + markdownLink.length;
	if (
		currentMarkdown.slice(
			duplicateIndex,
			duplicateIndex + plainMarkdownLink.length,
		) !== plainMarkdownLink
	) {
		return;
	}
	const dedupedMarkdown =
		currentMarkdown.slice(0, duplicateIndex) +
		currentMarkdown.slice(duplicateIndex + plainMarkdownLink.length);
	editor.setMarkdown(dedupedMarkdown);
	editor.setSelection?.(duplicateIndex, duplicateIndex);
	markDirty();
}

function scheduleDuplicateLinkCleanup(
	markdownLink: string,
	plainMarkdownLink: string,
	startOffset: number,
): void {
	const retryDelays = [0, 24, 80, 180, 320];
	for (const delay of retryDelays) {
		window.setTimeout(() => {
			removeDuplicatePlainLinkAfterTooltipInsert(
				markdownLink,
				plainMarkdownLink,
				startOffset,
			);
		}, delay);
	}
}

function insertLinkWithTooltipFromPopup(host: HTMLElement): boolean {
	if (!editor) return false;
	const popup = host.querySelector<HTMLElement>(EDITOR_LINK_POPUP_SELECTOR);
	if (!popup) return false;

	const urlInput = popup.querySelector<HTMLInputElement>(
		`#${EDITOR_LINK_URL_INPUT_ID}`,
	);
	const textInput = popup.querySelector<HTMLInputElement>(
		`#${EDITOR_LINK_TEXT_INPUT_ID}`,
	);
	const tooltipInput = ensureLinkPopupTooltipInput(host, false);
	if (!urlInput || !tooltipInput) return false;

	const normalizedUrl = normalizeInsertedLinkUrl(urlInput.value);
	const tooltip = normalizeLinkTooltipText(tooltipInput.value);
	const currentText = textInput?.value?.trim() || "";

	if (!normalizedUrl) {
		urlInput.classList.add("wrong");
		urlInput.focus();
		return false;
	}
	urlInput.value = normalizedUrl;
	urlInput.classList.remove("wrong");

	if (!tooltip) {
		return false;
	}

	editor.focus?.();
	if (editor.isMarkdownMode?.()) {
		const markdown = editor.getMarkdown();
		const range = getEditorSelectionOffsets() ||
			lastLinkPopupSelectionOffsets || [markdown.length, markdown.length];
		const [rawFrom, rawTo] = range;
		const selectedText = markdown.slice(rawFrom, rawTo).trim();
		const linkText = currentText || selectedText || normalizedUrl;
		const escapedLinkText = escapeMarkdownLinkText(linkText);
		const markdownLink = `[${escapeMarkdownLinkText(linkText)}](${normalizedUrl} "${escapeMarkdownLinkTitle(tooltip)}")`;
		editor.replaceSelection?.(markdownLink, rawFrom, rawTo);
		editor.setSelection?.(rawFrom, rawFrom + markdownLink.length);
		const plainMarkdownLink = `[${escapedLinkText}](${normalizedUrl})`;
		scheduleDuplicateLinkCleanup(markdownLink, plainMarkdownLink, rawFrom);
		markDirty();
		return true;
	}

	const wwLinkText =
		currentText || readEditorSelectionText().trim() || normalizedUrl;
	editor.exec?.("addLink", {
		linkUrl: normalizedUrl,
		linkText: wwLinkText,
	});
	window.setTimeout(() => {
		applyTooltipToRecentWysiwygLink(host, normalizedUrl, tooltip);
	}, 0);
	markDirty();
	return true;
}

function closeLinkPopupByButton(scope: ParentNode): void {
	lastLinkPopupSelectionOffsets = null;
	const closeButton = scope.querySelector<HTMLButtonElement>(
		`${EDITOR_LINK_POPUP_SELECTOR} .toastui-editor-close-button`,
	);
	closeButton?.click();
}

function scheduleEnsureLinkPopupTooltipInput(
	host: HTMLElement,
	resetValue = false,
): void {
	const retryDelays = [0, 40, 120, 260];
	for (const delay of retryDelays) {
		window.setTimeout(() => {
			ensureLinkPopupTooltipInput(host, resetValue);
		}, delay);
	}
}

function bindEditorLinkTooltip(host: HTMLElement): () => void {
	let activeLink: HTMLAnchorElement | null = null;
	let tooltipElement: HTMLDivElement | null = null;
	let hideTimer: ReturnType<typeof setTimeout> | null = null;

	const ensureTooltipElement = (): HTMLDivElement => {
		if (tooltipElement && document.body.contains(tooltipElement)) {
			return tooltipElement;
		}
		tooltipElement = document.createElement("div");
		tooltipElement.className = "dev-editor-link-tooltip";
		tooltipElement.setAttribute("role", "tooltip");
		document.body.appendChild(tooltipElement);
		return tooltipElement;
	};

	const syncTooltipTheme = () => {
		const shell = host.closest(".editor-shell");
		if (!shell || !tooltipElement) return;
		const style = window.getComputedStyle(shell);
		tooltipElement.style.setProperty(
			"--dev-link-tooltip-bg",
			style.getPropertyValue("--editor-tooltip-bg").trim(),
		);
		tooltipElement.style.setProperty(
			"--dev-link-tooltip-text",
			style.getPropertyValue("--editor-tooltip-text").trim(),
		);
		tooltipElement.style.setProperty(
			"--dev-link-tooltip-border",
			style.getPropertyValue("--editor-tooltip-border").trim(),
		);
		tooltipElement.style.setProperty(
			"--dev-link-tooltip-shadow",
			style.getPropertyValue("--editor-tooltip-shadow").trim(),
		);
	};

	const restoreLinkTitle = (link: HTMLAnchorElement | null) => {
		if (!link) return;
		const cached = link.dataset.devEditorTooltipTitle;
		if (!cached) return;
		link.setAttribute("title", cached);
		delete link.dataset.devEditorTooltipTitle;
	};

	const hideTooltip = () => {
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
		restoreLinkTitle(activeLink);
		activeLink = null;
		if (tooltipElement) {
			tooltipElement.classList.remove("visible");
			tooltipElement.textContent = "";
		}
	};

	const queueHideTooltip = () => {
		if (hideTimer) {
			clearTimeout(hideTimer);
		}
		hideTimer = setTimeout(() => {
			hideTooltip();
		}, 30);
	};

	const positionTooltip = (
		anchorRect: DOMRect,
		clientX?: number,
		clientY?: number,
	) => {
		if (!tooltipElement) return;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const tooltipRect = tooltipElement.getBoundingClientRect();
		const preferredCenterX =
			typeof clientX === "number"
				? clientX
				: anchorRect.left + anchorRect.width / 2;
		const preferredTop = anchorRect.top - tooltipRect.height - 14;
		const clampedLeft = Math.min(
			viewportWidth - tooltipRect.width - 12,
			Math.max(12, preferredCenterX - tooltipRect.width / 2),
		);
		const placeAbove = preferredTop >= 12;
		const top = placeAbove
			? preferredTop
			: Math.min(
					viewportHeight - tooltipRect.height - 12,
					anchorRect.bottom + 14,
				);
		const arrowLeft = Math.min(
			tooltipRect.width - 16,
			Math.max(16, preferredCenterX - clampedLeft),
		);
		tooltipElement.style.left = `${clampedLeft}px`;
		tooltipElement.style.top = `${top}px`;
		tooltipElement.dataset.side = placeAbove ? "top" : "bottom";
		tooltipElement.style.setProperty(
			"--dev-link-tooltip-arrow-left",
			`${arrowLeft}px`,
		);
		if (typeof clientY === "number") {
			tooltipElement.style.setProperty(
				"--dev-link-tooltip-pointer-y",
				`${clientY}px`,
			);
		}
	};

	const showTooltip = (
		link: HTMLAnchorElement,
		options: { clientX?: number; clientY?: number } = {},
	) => {
		const rawTitle =
			link.dataset.devEditorTooltipTitle || link.getAttribute("title") || "";
		const title = rawTitle.trim();
		if (!title) {
			hideTooltip();
			return;
		}
		if (hideTimer) {
			clearTimeout(hideTimer);
			hideTimer = null;
		}
		if (activeLink && activeLink !== link) {
			restoreLinkTitle(activeLink);
		}
		activeLink = link;
		if (!link.dataset.devEditorTooltipTitle) {
			link.dataset.devEditorTooltipTitle = title;
		}
		link.removeAttribute("title");
		const nextTooltip = ensureTooltipElement();
		syncTooltipTheme();
		nextTooltip.textContent = title;
		nextTooltip.classList.add("visible");
		positionTooltip(
			link.getBoundingClientRect(),
			options.clientX,
			options.clientY,
		);
	};

	const resolveTooltipLink = (
		target: EventTarget | null,
	): HTMLAnchorElement | null => {
		if (!(target instanceof Element)) return null;
		const link = target.closest("a[href]");
		if (!(link instanceof HTMLAnchorElement) || !host.contains(link)) {
			return null;
		}
		const title =
			link.dataset.devEditorTooltipTitle || link.getAttribute("title") || "";
		return title.trim() ? link : null;
	};

	const handleMouseOver = (event: MouseEvent) => {
		const link = resolveTooltipLink(event.target);
		if (!link) return;
		showTooltip(link, { clientX: event.clientX, clientY: event.clientY });
	};

	const handleMouseMove = (event: MouseEvent) => {
		if (!activeLink || !tooltipElement?.classList.contains("visible")) return;
		positionTooltip(
			activeLink.getBoundingClientRect(),
			event.clientX,
			event.clientY,
		);
	};

	const handleMouseOut = (event: MouseEvent) => {
		const link = resolveTooltipLink(event.target);
		if (!link || link !== activeLink) return;
		const related = event.relatedTarget;
		if (related instanceof Node && link.contains(related)) return;
		queueHideTooltip();
	};

	const handleFocusIn = (event: FocusEvent) => {
		const link = resolveTooltipLink(event.target);
		if (!link) return;
		showTooltip(link);
	};

	const handleFocusOut = (event: FocusEvent) => {
		const link = resolveTooltipLink(event.target);
		if (!link || link !== activeLink) return;
		queueHideTooltip();
	};

	const handleScrollOrResize = () => {
		if (!activeLink || !tooltipElement?.classList.contains("visible")) return;
		positionTooltip(activeLink.getBoundingClientRect());
	};

	host.addEventListener("mouseover", handleMouseOver, true);
	host.addEventListener("mousemove", handleMouseMove, true);
	host.addEventListener("mouseout", handleMouseOut, true);
	host.addEventListener("focusin", handleFocusIn, true);
	host.addEventListener("focusout", handleFocusOut, true);
	window.addEventListener("scroll", handleScrollOrResize, true);
	window.addEventListener("resize", handleScrollOrResize);

	return () => {
		host.removeEventListener("mouseover", handleMouseOver, true);
		host.removeEventListener("mousemove", handleMouseMove, true);
		host.removeEventListener("mouseout", handleMouseOut, true);
		host.removeEventListener("focusin", handleFocusIn, true);
		host.removeEventListener("focusout", handleFocusOut, true);
		window.removeEventListener("scroll", handleScrollOrResize, true);
		window.removeEventListener("resize", handleScrollOrResize);
		hideTooltip();
		tooltipElement?.remove();
		tooltipElement = null;
	};
}

function bindLinkPopupUrlNormalization(host: HTMLElement): () => void {
	const shouldInterceptLinkPopupConfirm = (): boolean => {
		const tooltipInput = ensureLinkPopupTooltipInput(host, false);
		return Boolean(
			tooltipInput && normalizeLinkTooltipText(tooltipInput.value),
		);
	};

	const handleLinkPopupPointerDownCapture = (event: PointerEvent) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const okButton = target.closest(
			`${EDITOR_LINK_POPUP_SELECTOR} .toastui-editor-ok-button`,
		);
		if (!okButton || !shouldInterceptLinkPopupConfirm()) return;
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
	};

	const handleLinkPopupClickCapture = (event: MouseEvent) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		if (
			target.closest(
				[
					"button.toastui-editor-toolbar-icons.link",
					"button.toastui-editor-toolbar-icons[data-svg-icon-name='link']",
				].join(","),
			)
		) {
			lastLinkPopupSelectionOffsets = getEditorSelectionOffsets();
			scheduleEnsureLinkPopupTooltipInput(host, true);
			return;
		}
		const okButton = target.closest(
			`${EDITOR_LINK_POPUP_SELECTOR} .toastui-editor-ok-button`,
		);
		if (okButton) {
			normalizeLinkPopupInputValue(host);
			ensureLinkPopupTooltipInput(host, false);
			if (!insertLinkWithTooltipFromPopup(host)) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			event.stopImmediatePropagation();
			closeLinkPopupByButton(host);
			return;
		}
		if (target.closest(EDITOR_LINK_POPUP_SELECTOR)) {
			ensureLinkPopupTooltipInput(host, false);
		}
	};

	const handleLinkInputEnterCapture = (event: KeyboardEvent) => {
		const isLinkShortcut =
			(event.ctrlKey || event.metaKey) &&
			!event.shiftKey &&
			!event.altKey &&
			event.key.toLowerCase() === "k";
		if (isLinkShortcut) {
			lastLinkPopupSelectionOffsets = getEditorSelectionOffsets();
			scheduleEnsureLinkPopupTooltipInput(host, true);
		}
		if (event.key !== "Enter") return;
		const target = event.target;
		if (!(target instanceof HTMLInputElement)) return;
		if (!target.closest(EDITOR_LINK_POPUP_SELECTOR)) return;
		if (target.id === EDITOR_LINK_URL_INPUT_ID) {
			const normalizedUrl = normalizeInsertedLinkUrl(target.value);
			if (normalizedUrl && normalizedUrl !== target.value) {
				target.value = normalizedUrl;
			}
		}
		if (
			target.id !== EDITOR_LINK_URL_INPUT_ID &&
			target.id !== EDITOR_LINK_TEXT_INPUT_ID &&
			target.id !== EDITOR_LINK_TOOLTIP_INPUT_ID
		) {
			return;
		}
		ensureLinkPopupTooltipInput(host, false);
		if (!insertLinkWithTooltipFromPopup(host)) return;
		event.preventDefault();
		event.stopPropagation();
		event.stopImmediatePropagation();
		closeLinkPopupByButton(host);
	};

	host.addEventListener("pointerdown", handleLinkPopupPointerDownCapture, true);
	host.addEventListener("click", handleLinkPopupClickCapture, true);
	host.addEventListener("keydown", handleLinkInputEnterCapture, true);

	return () => {
		host.removeEventListener(
			"pointerdown",
			handleLinkPopupPointerDownCapture,
			true,
		);
		host.removeEventListener("click", handleLinkPopupClickCapture, true);
		host.removeEventListener("keydown", handleLinkInputEnterCapture, true);
	};
}

function setImagePreviewPageLock(_locked: boolean): void {
	document.documentElement.classList.toggle("editor-image-preview-open", false);
}

function clampImagePreviewScale(value: number): number {
	if (!Number.isFinite(value)) {
		return 1;
	}
	return Math.min(
		IMAGE_PREVIEW_MAX_SCALE,
		Math.max(IMAGE_PREVIEW_MIN_SCALE, value),
	);
}

function openImagePreview(imageElement: HTMLImageElement): void {
	const previewSrc = imageElement.currentSrc || imageElement.src || "";
	if (!previewSrc) return;
	imagePreviewSrc = previewSrc;
	imagePreviewAlt = (imageElement.getAttribute("alt") || "").trim();
	imagePreviewScale = IMAGE_PREVIEW_INITIAL_SCALE;
	imagePreviewVisible = true;
	setImagePreviewPageLock(true);
}

function closeImagePreview(): void {
	if (!imagePreviewVisible && !imagePreviewSrc) return;
	imagePreviewVisible = false;
	imagePreviewSrc = "";
	imagePreviewAlt = "";
	imagePreviewScale = IMAGE_PREVIEW_INITIAL_SCALE;
	setImagePreviewPageLock(false);
}

function closeLinkConfirmDialog(): void {
	linkConfirmVisible = false;
	pendingLinkUrl = "";
	pendingLinkText = "";
}

function openImageDeleteConfirmDialog(src: string, altText = ""): void {
	pendingDeleteImageSrc = src;
	pendingDeleteImageAlt = altText.trim();
	pendingDeleteImageRepoPath = normalizeEditorUploadRepoPathFromUrl(src);
	imageDeleteConfirmVisible = true;
}

function closeImageDeleteConfirmDialog(): void {
	if (imageDeleteBusy) return;
	imageDeleteConfirmVisible = false;
	pendingDeleteImageSrc = "";
	pendingDeleteImageAlt = "";
	pendingDeleteImageRepoPath = "";
}

function formatLinkPreviewText(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return "";
	if (trimmed.length <= 96) return trimmed;
	return `${trimmed.slice(0, 93)}...`;
}

function resolveEditorLinkUrl(rawHref: string): string | null {
	const href = rawHref.trim();
	if (!href) return null;
	if (/^(?:javascript|data|vbscript|file):/i.test(href)) {
		return null;
	}
	try {
		const resolved = new URL(href, window.location.href);
		const protocol = resolved.protocol.toLowerCase();
		if (
			protocol !== "http:" &&
			protocol !== "https:" &&
			protocol !== "mailto:" &&
			protocol !== "tel:"
		) {
			return null;
		}
		return resolved.href;
	} catch {
		return null;
	}
}

function askOpenEditorLink(
	linkElement: HTMLAnchorElement,
): "allow" | "confirm" | "blocked" {
	const candidateHref =
		linkElement.getAttribute("href") || linkElement.href || "";
	const resolvedUrl = resolveEditorLinkUrl(candidateHref);
	if (!resolvedUrl) {
		showNotice("该链接不支持直接打开", "error");
		return "blocked";
	}
	const parsedUrl = new URL(resolvedUrl);
	if (
		(parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
		parsedUrl.origin === window.location.origin
	) {
		return "allow";
	}
	pendingLinkUrl = resolvedUrl;
	pendingLinkText = formatLinkPreviewText(linkElement.textContent || "");
	linkConfirmVisible = true;
	return "confirm";
}

function confirmOpenEditorLink(): void {
	if (!pendingLinkUrl) {
		closeLinkConfirmDialog();
		return;
	}
	const nextUrl = pendingLinkUrl;
	closeLinkConfirmDialog();
	window.open(nextUrl, "_blank", "noopener,noreferrer");
}

function adjustImagePreviewScale(delta: number): void {
	imagePreviewScale = clampImagePreviewScale(imagePreviewScale + delta);
}

function handleImagePreviewWheel(event: WheelEvent): void {
	if (!imagePreviewVisible) return;
	const target = event.target;
	if (!(target instanceof Element)) return;
	if (!target.closest(".image-preview-frame")) return;
	event.preventDefault();
	const wheelDelta = event.deltaY;
	const step = event.ctrlKey
		? IMAGE_PREVIEW_WHEEL_STEP * 1.4
		: IMAGE_PREVIEW_WHEEL_STEP;
	if (wheelDelta < 0) {
		adjustImagePreviewScale(step);
		return;
	}
	adjustImagePreviewScale(-step);
}

function handleImagePreviewOverlayClick(event: MouseEvent): void {
	if (event.target !== event.currentTarget) return;
	closeImagePreview();
}

function handleImagePreviewOverlayKeydown(event: KeyboardEvent): void {
	if (event.key === "Escape") {
		event.preventDefault();
		closeImagePreview();
		return;
	}
	if (
		(event.key === "Enter" || event.key === " ") &&
		event.target === event.currentTarget
	) {
		event.preventDefault();
		closeImagePreview();
	}
}

function bindEditorImagePreview(host: HTMLElement): () => void {
	const applyBrokenImageFallback = (image: HTMLImageElement) => {
		if (!host.contains(image)) return;
		if (!image.closest(".toastui-editor-contents")) return;
		const currentAlt = (image.getAttribute("alt") || "").trim();
		if (currentAlt) return;
		if (!image.complete || image.naturalWidth > 0) return;
		image.setAttribute("alt", BROKEN_IMAGE_FALLBACK_ALT);
	};

	const handleEditorContentClickCapture = (event: MouseEvent) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		if (imagePreviewVisible || linkConfirmVisible || imageDeleteConfirmVisible)
			return;
		const contentRoot = target.closest(".toastui-editor-contents");
		if (!contentRoot) return;

		const image = target.closest("img");
		if (image instanceof HTMLImageElement && host.contains(image)) {
			event.preventDefault();
			event.stopPropagation();
			openImagePreview(image);
			return;
		}

		const link = target.closest("a[href]");
		if (link instanceof HTMLAnchorElement && host.contains(link)) {
			const action = askOpenEditorLink(link);
			if (action === "allow") return;
			event.preventDefault();
			event.stopPropagation();
		}
	};

	const handleEscapeToClosePreview = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		if (imageEditVisible) {
			closeImageEditDialog();
			return;
		}
		if (captionEditVisible) {
			closeImageCaptionDialog();
			return;
		}
		if (linkConfirmVisible) {
			closeLinkConfirmDialog();
			return;
		}
		if (imageDeleteConfirmVisible) {
			closeImageDeleteConfirmDialog();
			return;
		}
		closeImagePreview();
	};

	const handleEditorImageLoadErrorCapture = (event: Event) => {
		const target = event.target;
		if (!(target instanceof HTMLImageElement)) return;
		applyBrokenImageFallback(target);
	};

	for (const image of host.querySelectorAll<HTMLImageElement>(
		".toastui-editor-contents img",
	)) {
		applyBrokenImageFallback(image);
	}

	host.addEventListener("click", handleEditorContentClickCapture, true);
	host.addEventListener("error", handleEditorImageLoadErrorCapture, true);
	window.addEventListener("keydown", handleEscapeToClosePreview);

	return () => {
		host.removeEventListener("click", handleEditorContentClickCapture, true);
		host.removeEventListener("error", handleEditorImageLoadErrorCapture, true);
		window.removeEventListener("keydown", handleEscapeToClosePreview);
	};
}

function bindEditorSaveShortcut(host: HTMLElement): () => void {
	const shell = host.closest(".editor-shell");
	const handleSaveShortcutCapture = (event: KeyboardEvent) => {
		if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
		const key = event.key.toLowerCase();
		const target = event.target;
		const inEditorHost = target instanceof Node ? host.contains(target) : false;
		const inEditorShell =
			target instanceof Node && shell instanceof HTMLElement
				? shell.contains(target)
				: false;
		if (
			(event.code === "KeyS" || key === "s") &&
			(inEditorHost || inEditorShell)
		) {
			event.preventDefault();
			event.stopPropagation();
			persistDraft(false, true);
			return;
		}
		if ((event.code === "KeyZ" || key === "z") && inEditorHost) {
			event.preventDefault();
			event.stopPropagation();
			if (event.shiftKey) {
				editor?.exec?.("redo");
				return;
			}
			editor?.exec?.("undo");
			return;
		}
		if ((event.code === "KeyY" || key === "y") && inEditorHost) {
			event.preventDefault();
			event.stopPropagation();
			editor?.exec?.("redo");
		}
	};

	window.addEventListener("keydown", handleSaveShortcutCapture, true);
	return () => {
		window.removeEventListener("keydown", handleSaveShortcutCapture, true);
	};
}

function closeEditorContextMenu() {
	contextMenuVisible = false;
	contextMenuImageSrc = "";
	contextMenuImageAlt = "";
	contextMenuImageElement = null;
	contextMenuTextEffectState = { ...DEFAULT_CONTEXT_MENU_TEXT_EFFECT_STATE };
}

function closeImageEditDialog() {
	imageEditVisible = false;
	imageEditSrc = "";
	imageEditAlt = "";
	imageEditStageElement = null;
	imageEditPreviewImageElement = null;
	imageEditZoom = 1;
	imageEditPanX = 0;
	imageEditPanY = 0;
	imageEditPanning = false;
	imageEditPanStartX = 0;
	imageEditPanStartY = 0;
	imageEditPanBaseX = 0;
	imageEditPanBaseY = 0;
	imageEditNaturalWidth = 0;
	imageEditNaturalHeight = 0;
	imageEditCropX = 0;
	imageEditCropY = 0;
	imageEditCropWidth = 0;
	imageEditCropHeight = 0;
	imageEditPreviewOffsetX = 0;
	imageEditPreviewOffsetY = 0;
	imageEditSourceX = 0;
	imageEditSourceY = 0;
	imageEditSourceWidth = 0;
	imageEditSourceHeight = 0;
	imageEditLockSquare = false;
	imageEditResizing = false;
	imageEditResizeHandle = null;
	imageEditResizeBaseX = 0;
	imageEditResizeBaseY = 0;
	imageEditResizeBaseWidth = 0;
	imageEditResizeBaseHeight = 0;
	imageEditMoving = false;
	imageEditMoveStartPointerX = 0;
	imageEditMoveStartPointerY = 0;
	imageEditMoveBaseX = 0;
	imageEditMoveBaseY = 0;
	imageEditMoveBaseWidth = 0;
	imageEditMoveBaseHeight = 0;
	imageEditDragging = false;
	imageEditCropEnabled = false;
}

function openImageEditDialog(imageElement: HTMLImageElement | null) {
	const src =
		imageElement?.currentSrc || imageElement?.src || contextMenuImageSrc;
	if (!src) {
		showNotice("未找到图片地址", "error");
		return;
	}
	imageEditSrc = src;
	imageEditAlt = (
		imageElement?.getAttribute("alt") ||
		contextMenuImageAlt ||
		""
	).trim();
	imageEditVisible = true;
	imageEditZoom = 1;
	imageEditPanX = 0;
	imageEditPanY = 0;
	imageEditPanning = false;
	imageEditPanStartX = 0;
	imageEditPanStartY = 0;
	imageEditPanBaseX = 0;
	imageEditPanBaseY = 0;
	imageEditNaturalWidth = 0;
	imageEditNaturalHeight = 0;
	imageEditCropEnabled = false;
	imageEditCropX = 0;
	imageEditCropY = 0;
	imageEditCropWidth = 0;
	imageEditCropHeight = 0;
	imageEditPreviewOffsetX = 0;
	imageEditPreviewOffsetY = 0;
	imageEditSourceX = 0;
	imageEditSourceY = 0;
	imageEditSourceWidth = 0;
	imageEditSourceHeight = 0;
	imageEditLockSquare = false;
	imageEditResizing = false;
	imageEditResizeHandle = null;
	imageEditResizeBaseX = 0;
	imageEditResizeBaseY = 0;
	imageEditResizeBaseWidth = 0;
	imageEditResizeBaseHeight = 0;
	imageEditMoving = false;
	imageEditMoveStartPointerX = 0;
	imageEditMoveStartPointerY = 0;
	imageEditMoveBaseX = 0;
	imageEditMoveBaseY = 0;
	imageEditMoveBaseWidth = 0;
	imageEditMoveBaseHeight = 0;
}

function normalizeComparableImageUrl(raw: string): string {
	const value = (raw || "").trim();
	if (!value) return "";
	try {
		const parsed = new URL(value, window.location.origin);
		return decodeURIComponent(`${parsed.pathname}${parsed.search}`).trim();
	} catch {
		try {
			return decodeURIComponent(value).trim();
		} catch {
			return value;
		}
	}
}

function toEditorSafeImageUrl(raw: string): string {
	const value = (raw || "").trim();
	if (!value || typeof window === "undefined") return value;
	try {
		const parsed = new URL(value, window.location.origin);
		const isSameOrigin = parsed.origin === window.location.origin;
		if (!isSameOrigin || !parsed.pathname.startsWith("/uploads/editor/")) {
			return value;
		}
		const decodedPath = decodeURIComponent(parsed.pathname);
		return `${decodedPath}${parsed.search}${parsed.hash}`;
	} catch {
		return value;
	}
}

function normalizeEditorUploadRepoPathFromUrl(raw: string): string {
	const value = (raw || "").trim();
	if (!value || typeof window === "undefined") return "";
	let pathname = value;
	try {
		const parsed = new URL(value, window.location.origin);
		pathname = parsed.pathname;
	} catch {
		pathname = value;
	}
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// Keep raw value when decode fails.
	}
	if (pathname.includes("..")) return "";
	const embeddedPublicMarker = "/public/uploads/editor/";
	const embeddedPublicIndex = pathname.indexOf(embeddedPublicMarker);
	if (embeddedPublicIndex >= 0) {
		return pathname.slice(embeddedPublicIndex + 1);
	}
	if (pathname.startsWith("public/uploads/editor/")) return pathname;
	if (pathname.startsWith("/uploads/editor/")) return `public${pathname}`;
	return "";
}

function normalizeEditorUploadImageUrls(markdown: string): string {
	if (!markdown) return markdown;
	let next = markdown.replace(
		/!\[([^\]]*)\]\((?:<)?([^)\s>]+)(?:>)?(\s+["'][^"']*["'])?\)/gi,
		(full, altText = "", imageSrc = "", titlePart = "") => {
			const safeSrc = toEditorSafeImageUrl(String(imageSrc));
			if (!safeSrc || safeSrc === imageSrc) return full;
			const safeTitle = typeof titlePart === "string" ? titlePart : "";
			return `![${altText}](${safeSrc}${safeTitle})`;
		},
	);
	next = next.replace(
		/<img\b([^>]*?)\bsrc=(["'])(.*?)\2([^>]*)>/gi,
		(full, prefix = "", quote = '"', imageSrc = "", suffix = "") => {
			const safeSrc = toEditorSafeImageUrl(String(imageSrc));
			if (!safeSrc || safeSrc === imageSrc) return full;
			return `<img${prefix}src=${quote}${safeSrc}${quote}${suffix}>`;
		},
	);
	return next;
}

function isSameImageSource(a: string, b: string): boolean {
	const left = normalizeComparableImageUrl(a);
	const right = normalizeComparableImageUrl(b);
	if (!left || !right) return false;
	return left === right;
}

function replaceImageSourceInMarkdown(
	targetSrc: string,
	nextSrc: string,
): boolean {
	if (!editor || !targetSrc || !nextSrc) return false;
	const markdown = editor.getMarkdown();
	const escapedTargetSrc = escapeRegex(targetSrc);
	const markdownImagePattern = new RegExp(
		`!\\[([^\\]]*)\\]\\((?:<)?${escapedTargetSrc}(?:>)?(\\s+["'][^"']*["'])?\\)`,
		"i",
	);
	const htmlImagePattern = new RegExp(
		`<img\\b([^>]*?)\\bsrc=(["'])${escapedTargetSrc}\\2([^>]*)>`,
		"i",
	);
	let next = markdown.replace(
		markdownImagePattern,
		(_full, altText = "", titlePart = "") => {
			const safeTitle = typeof titlePart === "string" ? titlePart : "";
			return `![${altText}](${nextSrc}${safeTitle})`;
		},
	);
	if (next === markdown) {
		next = markdown.replace(
			htmlImagePattern,
			(_full, prefix = "", quote = '"', suffix = "") => {
				return `<img${prefix}src=${quote}${nextSrc}${quote}${suffix}>`;
			},
		);
	}
	if (next === markdown) {
		let replaced = false;
		next = markdown.replace(
			/!\[([^\]]*)\]\((?:<)?([^)\s>]+)(?:>)?(\s+["'][^"']*["'])?\)/gi,
			(full, altText = "", imageSrc = "", titlePart = "") => {
				if (replaced || !isSameImageSource(String(imageSrc), targetSrc)) {
					return full;
				}
				replaced = true;
				const safeTitle = typeof titlePart === "string" ? titlePart : "";
				return `![${altText}](${nextSrc}${safeTitle})`;
			},
		);
	}
	if (next === markdown) {
		let replaced = false;
		next = markdown.replace(
			/<img\b([^>]*?)\bsrc=(["'])(.*?)\2([^>]*)>/gi,
			(full, prefix = "", quote = '"', imageSrc = "", suffix = "") => {
				if (replaced || !isSameImageSource(String(imageSrc), targetSrc)) {
					return full;
				}
				replaced = true;
				return `<img${prefix}src=${quote}${nextSrc}${quote}${suffix}>`;
			},
		);
	}
	if (next === markdown) return false;
	editor.setMarkdown(next);
	markDirty();
	return true;
}

function sanitizeImageCaptionText(caption: string): string {
	return caption.trim().replace(/\\/g, "").replace(/"/g, "&quot;");
}

function updateImageCaptionInMarkdown(
	targetSrc: string,
	caption: string,
): boolean {
	if (!editor || !targetSrc) return false;
	const markdown = editor.getMarkdown();
	const escapedTargetSrc = escapeRegex(targetSrc);
	const markdownImagePattern = new RegExp(
		`!\\[([^\\]]*)\\]\\((?:<)?${escapedTargetSrc}(?:>)?(\\s+["'][^"']*["'])?\\)`,
		"i",
	);
	const trimmed = caption.trim();
	if (!trimmed) {
		const removalPattern = new RegExp(
			`(!\\[[^\\]]*\\]\\((?:<)?${escapedTargetSrc}(?:>)?)\\s+["'][^"']*["']?(\\))`,
			"i",
		);
		const next = markdown.replace(removalPattern, "$1$2");
		if (next === markdown) return false;
		editor.setMarkdown(next);
		markDirty();
		return true;
	}
	const safeCaption = sanitizeImageCaptionText(trimmed);
	let changed = false;
	const next = markdown.replace(
		markdownImagePattern,
		(full, altText = "", titlePart = "") => {
			changed = true;
			const existingTitle = typeof titlePart === "string" ? titlePart.trim() : "";
			const desired = ` "${safeCaption}"`;
			if (existingTitle === desired) return full;
			return `![${altText}](${targetSrc}${desired})`;
		},
	);
	if (!changed || next === markdown) return false;
	editor.setMarkdown(next);
	markDirty();
	return true;
}

function syncImageEditPreviewOffsets(imageRect?: DOMRect): void {
	if (!imageEditStageElement || !imageEditPreviewImageElement) {
		imageEditPreviewOffsetX = 0;
		imageEditPreviewOffsetY = 0;
		return;
	}
	const stageRect = imageEditStageElement.getBoundingClientRect();
	const previewRect =
		imageRect || imageEditPreviewImageElement.getBoundingClientRect();
	imageEditPreviewOffsetX = Math.max(0, previewRect.left - stageRect.left);
	imageEditPreviewOffsetY = Math.max(0, previewRect.top - stageRect.top);
}

function initializeImageEditCropSelectionFromSource(): void {
	if (!imageEditPreviewImageElement) return;
	const rect = imageEditPreviewImageElement.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return;
	syncImageEditPreviewOffsets(rect);
	if (
		imageEditNaturalWidth <= 0 ||
		imageEditNaturalHeight <= 0 ||
		imageEditSourceWidth <= 0 ||
		imageEditSourceHeight <= 0
	) {
		imageEditCropEnabled = false;
		return;
	}
	const scaleX = rect.width / imageEditNaturalWidth;
	const scaleY = rect.height / imageEditNaturalHeight;
	imageEditCropX = imageEditSourceX * scaleX;
	imageEditCropY = imageEditSourceY * scaleY;
	imageEditCropWidth = imageEditSourceWidth * scaleX;
	imageEditCropHeight = imageEditSourceHeight * scaleY;
	imageEditCropEnabled = imageEditCropWidth > 0 && imageEditCropHeight > 0;
}

function updateImageEditSourceRectFromDisplay(displayRect?: DOMRect): void {
	if (
		!imageEditPreviewImageElement ||
		imageEditNaturalWidth <= 0 ||
		imageEditNaturalHeight <= 0
	) {
		return;
	}
	const rect =
		displayRect || imageEditPreviewImageElement.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return;
	const scaleX = imageEditNaturalWidth / rect.width;
	const scaleY = imageEditNaturalHeight / rect.height;
	const sx = Math.max(0, Math.round(imageEditCropX * scaleX));
	const sy = Math.max(0, Math.round(imageEditCropY * scaleY));
	const sw = Math.max(1, Math.round(imageEditCropWidth * scaleX));
	const sh = Math.max(1, Math.round(imageEditCropHeight * scaleY));
	imageEditSourceX = Math.min(sx, Math.max(0, imageEditNaturalWidth - 1));
	imageEditSourceY = Math.min(sy, Math.max(0, imageEditNaturalHeight - 1));
	imageEditSourceWidth = Math.min(sw, imageEditNaturalWidth - imageEditSourceX);
	imageEditSourceHeight = Math.min(
		sh,
		imageEditNaturalHeight - imageEditSourceY,
	);
}

function applyImageEditSourceRect(): void {
	const toInt = (value: number, fallback: number) => {
		const next = Number(value);
		if (!Number.isFinite(next)) return fallback;
		return Math.round(next);
	};
	const naturalWidth = Math.max(1, imageEditNaturalWidth);
	const naturalHeight = Math.max(1, imageEditNaturalHeight);

	let sx = Math.max(0, toInt(imageEditSourceX, 0));
	let sy = Math.max(0, toInt(imageEditSourceY, 0));
	let sw = Math.max(1, toInt(imageEditSourceWidth, naturalWidth));
	let sh = Math.max(1, toInt(imageEditSourceHeight, naturalHeight));

	sx = Math.min(sx, naturalWidth - 1);
	sy = Math.min(sy, naturalHeight - 1);
	sw = Math.min(sw, naturalWidth - sx);
	sh = Math.min(sh, naturalHeight - sy);

	imageEditSourceX = sx;
	imageEditSourceY = sy;
	imageEditSourceWidth = sw;
	imageEditSourceHeight = sh;
	initializeImageEditCropSelectionFromSource();
}

function handleImageEditImageLoad(): void {
	if (!imageEditPreviewImageElement) return;
	imageEditNaturalWidth = Math.max(
		1,
		imageEditPreviewImageElement.naturalWidth || 1,
	);
	imageEditNaturalHeight = Math.max(
		1,
		imageEditPreviewImageElement.naturalHeight || 1,
	);
	imageEditLockSquare =
		Math.max(imageEditNaturalWidth, imageEditNaturalHeight) >=
		IMAGE_EDIT_HUGE_IMAGE_THRESHOLD;

	if (imageEditLockSquare) {
		const side = Math.min(imageEditNaturalWidth, imageEditNaturalHeight);
		imageEditSourceX = Math.floor((imageEditNaturalWidth - side) / 2);
		imageEditSourceY = Math.floor((imageEditNaturalHeight - side) / 2);
		imageEditSourceWidth = side;
		imageEditSourceHeight = side;
	} else {
		imageEditSourceX = 0;
		imageEditSourceY = 0;
		imageEditSourceWidth = imageEditNaturalWidth;
		imageEditSourceHeight = imageEditNaturalHeight;
	}
	initializeImageEditCropSelectionFromSource();
}

function clampImageEditPan(): void {
	if (!imageEditStageElement || !imageEditPreviewImageElement) {
		imageEditPanX = 0;
		imageEditPanY = 0;
		return;
	}
	const stageWidth = imageEditStageElement.clientWidth;
	const stageHeight = imageEditStageElement.clientHeight;
	const baseWidth = imageEditPreviewImageElement.offsetWidth;
	const baseHeight = imageEditPreviewImageElement.offsetHeight;
	if (
		stageWidth <= 0 ||
		stageHeight <= 0 ||
		baseWidth <= 0 ||
		baseHeight <= 0
	) {
		imageEditPanX = 0;
		imageEditPanY = 0;
		return;
	}
	const scaledWidth = baseWidth * imageEditZoom;
	const scaledHeight = baseHeight * imageEditZoom;
	const maxPanX = Math.max(0, (scaledWidth - stageWidth) / 2);
	const maxPanY = Math.max(0, (scaledHeight - stageHeight) / 2);
	imageEditPanX = Math.min(maxPanX, Math.max(-maxPanX, imageEditPanX));
	imageEditPanY = Math.min(maxPanY, Math.max(-maxPanY, imageEditPanY));
}

function handleImageEditWheel(event: WheelEvent): void {
	if (!imageEditPreviewImageElement) return;
	const direction = event.deltaY > 0 ? -1 : 1;
	const next = Number((imageEditZoom + direction * 0.08).toFixed(2));
	imageEditZoom = Math.min(5, Math.max(0.2, next));
	void tick().then(() => {
		clampImageEditPan();
		initializeImageEditCropSelectionFromSource();
	});
}

function getImageEditPointerPosition(
	event: PointerEvent,
): { x: number; y: number } | null {
	if (!imageEditPreviewImageElement) return null;
	const rect = imageEditPreviewImageElement.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) return null;
	const x = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
	const y = Math.min(Math.max(0, event.clientY - rect.top), rect.height);
	return { x, y };
}

function handleImageEditResizeHandlePointerDown(
	handle: ImageEditResizeHandle,
	event: PointerEvent,
): void {
	if (!imageEditCropEnabled) return;
	event.preventDefault();
	event.stopPropagation();
	imageEditResizing = true;
	imageEditResizeHandle = handle;
	imageEditResizeBaseX = imageEditCropX;
	imageEditResizeBaseY = imageEditCropY;
	imageEditResizeBaseWidth = imageEditCropWidth;
	imageEditResizeBaseHeight = imageEditCropHeight;
	const target = event.currentTarget;
	if (target instanceof HTMLElement) {
		target.setPointerCapture?.(event.pointerId);
	}
}

function handleImageEditCropBoxPointerDown(event: PointerEvent): void {
	if (!imageEditCropEnabled || !imageEditPreviewImageElement) return;
	const target = event.target;
	if (
		target instanceof HTMLElement &&
		target.classList.contains("image-edit-crop-handle")
	) {
		return;
	}
	event.preventDefault();
	event.stopPropagation();
	const pointer = getImageEditPointerPosition(event);
	if (!pointer) return;
	imageEditMoving = true;
	imageEditMoveStartPointerX = pointer.x;
	imageEditMoveStartPointerY = pointer.y;
	imageEditMoveBaseX = imageEditCropX;
	imageEditMoveBaseY = imageEditCropY;
	imageEditMoveBaseWidth = imageEditCropWidth;
	imageEditMoveBaseHeight = imageEditCropHeight;
	const currentTarget = event.currentTarget;
	if (currentTarget instanceof HTMLElement) {
		currentTarget.setPointerCapture?.(event.pointerId);
	}
}

function handleImageEditResizePointerMove(event: PointerEvent): void {
	if (!imageEditPreviewImageElement) return;
	if (imageEditMoving) {
		event.preventDefault();
		const pointer = getImageEditPointerPosition(event);
		if (!pointer) return;
		const rect = imageEditPreviewImageElement.getBoundingClientRect();
		const nextX = imageEditMoveBaseX + (pointer.x - imageEditMoveStartPointerX);
		const nextY = imageEditMoveBaseY + (pointer.y - imageEditMoveStartPointerY);
		const maxX = Math.max(0, rect.width - imageEditMoveBaseWidth);
		const maxY = Math.max(0, rect.height - imageEditMoveBaseHeight);
		imageEditCropX = Math.min(Math.max(0, nextX), maxX);
		imageEditCropY = Math.min(Math.max(0, nextY), maxY);
		imageEditCropWidth = imageEditMoveBaseWidth;
		imageEditCropHeight = imageEditMoveBaseHeight;
		updateImageEditSourceRectFromDisplay(rect);
		return;
	}
	if (!imageEditResizing || !imageEditResizeHandle) {
		return;
	}
	event.preventDefault();
	const pointer = getImageEditPointerPosition(event);
	if (!pointer) return;
	const rect = imageEditPreviewImageElement.getBoundingClientRect();
	const minSize = 8;
	const baseLeft = imageEditResizeBaseX;
	const baseTop = imageEditResizeBaseY;
	const baseRight = imageEditResizeBaseX + imageEditResizeBaseWidth;
	const baseBottom = imageEditResizeBaseY + imageEditResizeBaseHeight;
	let left = baseLeft;
	let top = baseTop;
	let right = baseRight;
	let bottom = baseBottom;

	if (imageEditResizeHandle.includes("w")) {
		left = Math.min(Math.max(0, pointer.x), baseRight - minSize);
	}
	if (imageEditResizeHandle.includes("e")) {
		right = Math.max(Math.min(rect.width, pointer.x), baseLeft + minSize);
	}
	if (imageEditResizeHandle.includes("n")) {
		top = Math.min(Math.max(0, pointer.y), baseBottom - minSize);
	}
	if (imageEditResizeHandle.includes("s")) {
		bottom = Math.max(Math.min(rect.height, pointer.y), baseTop + minSize);
	}

	imageEditCropX = left;
	imageEditCropY = top;
	imageEditCropWidth = Math.max(minSize, right - left);
	imageEditCropHeight = Math.max(minSize, bottom - top);
	imageEditCropEnabled = true;
	updateImageEditSourceRectFromDisplay(rect);
}

function handleImageEditResizePointerUp(event: PointerEvent): void {
	if (imageEditMoving) {
		imageEditMoving = false;
		const target = event.currentTarget;
		if (target instanceof HTMLElement) {
			target.releasePointerCapture?.(event.pointerId);
		}
		return;
	}
	if (!imageEditResizing) return;
	imageEditResizing = false;
	imageEditResizeHandle = null;
	const target = event.currentTarget;
	if (target instanceof HTMLElement) {
		target.releasePointerCapture?.(event.pointerId);
	}
}

function handleImageEditPointerDown(event: PointerEvent) {
	if (event.button === 2 && imageEditZoom > 1) {
		event.preventDefault();
		imageEditPanning = true;
		imageEditPanStartX = event.clientX;
		imageEditPanStartY = event.clientY;
		imageEditPanBaseX = imageEditPanX;
		imageEditPanBaseY = imageEditPanY;
		const target = event.currentTarget;
		if (target instanceof HTMLElement) {
			target.setPointerCapture?.(event.pointerId);
		}
		return;
	}
	if (imageEditResizing) return;
	const target = event.currentTarget;
	if (!(target instanceof HTMLImageElement)) return;
	const rect = target.getBoundingClientRect();
	syncImageEditPreviewOffsets(rect);
	const x = event.clientX - rect.left;
	const y = event.clientY - rect.top;
	if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
	imageEditDragging = true;
	imageEditCropEnabled = true;
	imageEditDragStartX = x;
	imageEditDragStartY = y;
	imageEditCropX = x;
	imageEditCropY = y;
	imageEditCropWidth = 0;
	imageEditCropHeight = 0;
	target.setPointerCapture?.(event.pointerId);
}

function handleImageEditPointerMove(event: PointerEvent) {
	if (imageEditPanning) {
		event.preventDefault();
		imageEditPanX = imageEditPanBaseX + (event.clientX - imageEditPanStartX);
		imageEditPanY = imageEditPanBaseY + (event.clientY - imageEditPanStartY);
		clampImageEditPan();
		void tick().then(() => {
			initializeImageEditCropSelectionFromSource();
		});
		return;
	}
	if (imageEditResizing) return;
	if (!imageEditDragging || !imageEditPreviewImageElement) return;
	const rect = imageEditPreviewImageElement.getBoundingClientRect();
	syncImageEditPreviewOffsets(rect);
	const currentX = Math.min(Math.max(0, event.clientX - rect.left), rect.width);
	const currentY = Math.min(Math.max(0, event.clientY - rect.top), rect.height);
	let x2 = currentX;
	let y2 = currentY;
	if (imageEditLockSquare) {
		const dx = currentX - imageEditDragStartX;
		const dy = currentY - imageEditDragStartY;
		const signX = dx < 0 ? -1 : 1;
		const signY = dy < 0 ? -1 : 1;
		const maxX =
			signX < 0 ? imageEditDragStartX : rect.width - imageEditDragStartX;
		const maxY =
			signY < 0 ? imageEditDragStartY : rect.height - imageEditDragStartY;
		const desired = Math.max(Math.abs(dx), Math.abs(dy));
		const side = Math.max(1, Math.min(desired, maxX, maxY));
		x2 = imageEditDragStartX + signX * side;
		y2 = imageEditDragStartY + signY * side;
	}
	imageEditCropX = Math.min(imageEditDragStartX, x2);
	imageEditCropY = Math.min(imageEditDragStartY, y2);
	imageEditCropWidth = Math.abs(x2 - imageEditDragStartX);
	imageEditCropHeight = Math.abs(y2 - imageEditDragStartY);
	updateImageEditSourceRectFromDisplay(rect);
}

function handleImageEditPointerUp(event: PointerEvent) {
	if (imageEditPanning) {
		imageEditPanning = false;
		const target = event.currentTarget;
		if (target instanceof HTMLElement) {
			target.releasePointerCapture?.(event.pointerId);
		}
		return;
	}
	if (imageEditResizing) return;
	if (!imageEditDragging) return;
	imageEditDragging = false;
	if (imageEditPreviewImageElement) {
		imageEditPreviewImageElement.releasePointerCapture?.(event.pointerId);
	}
	if (imageEditCropWidth < 8 || imageEditCropHeight < 8) {
		imageEditCropEnabled = false;
		imageEditCropWidth = 0;
		imageEditCropHeight = 0;
	}
}

function clearImageCropSelection() {
	imageEditResizing = false;
	imageEditResizeHandle = null;
	imageEditMoving = false;
	imageEditCropEnabled = false;
	imageEditCropX = 0;
	imageEditCropY = 0;
	imageEditCropWidth = 0;
	imageEditCropHeight = 0;
	imageEditSourceX = 0;
	imageEditSourceY = 0;
	imageEditSourceWidth = 0;
	imageEditSourceHeight = 0;
}

async function cropImageBySelection(
	src: string,
	cropX: number,
	cropY: number,
	cropWidth: number,
	cropHeight: number,
): Promise<Blob> {
	const sourceImage = new Image();
	sourceImage.crossOrigin = "anonymous";
	sourceImage.src = src;
	await sourceImage.decode();
	const sx = Math.max(
		0,
		Math.min(Math.round(cropX), sourceImage.naturalWidth - 1),
	);
	const sy = Math.max(
		0,
		Math.min(Math.round(cropY), sourceImage.naturalHeight - 1),
	);
	const sw = Math.max(
		1,
		Math.min(Math.round(cropWidth), sourceImage.naturalWidth - sx),
	);
	const sh = Math.max(
		1,
		Math.min(Math.round(cropHeight), sourceImage.naturalHeight - sy),
	);
	const canvas = document.createElement("canvas");
	canvas.width = sw;
	canvas.height = sh;
	const context = canvas.getContext("2d");
	if (!context) {
		throw new Error("无法创建裁切画布");
	}
	context.drawImage(sourceImage, sx, sy, sw, sh, 0, 0, sw, sh);
	return await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (!blob) {
					reject(new Error("裁切失败"));
					return;
				}
				resolve(blob);
			},
			"image/png",
			0.95,
		);
	});
}

async function applyImageEditChanges() {
	const src = imageEditSrc || contextMenuImageSrc;
	if (!src) {
		showNotice("未找到图片地址", "error");
		return;
	}
	let didChange = false;
	let currentSrc = src;
	if (
		imageEditCropEnabled &&
		imageEditSourceWidth > 0 &&
		imageEditSourceHeight > 0
	) {
		try {
			statusText = "图片裁切上传中...";
			const blob = await cropImageBySelection(
				src,
				imageEditSourceX,
				imageEditSourceY,
				imageEditSourceWidth,
				imageEditSourceHeight,
			);
			const uploaded = await uploadEditorImage(blob);
			const replaceCandidates = Array.from(
				new Set(
					[
						src,
						currentSrc,
						contextMenuImageSrc,
						contextMenuImageElement?.currentSrc || "",
						contextMenuImageElement?.src || "",
					].filter((value): value is string => Boolean(value)),
				),
			);
			let replaced = false;
			for (const candidate of replaceCandidates) {
				if (replaceImageSourceInMarkdown(candidate, uploaded.url)) {
					replaced = true;
					break;
				}
			}
			didChange = didChange || replaced;
			currentSrc = uploaded.url;
		} catch (error) {
			const message = error instanceof Error ? error.message : "在线裁切失败";
			showNotice(message, "error");
			statusText = "在线裁切失败";
			return;
		} finally {
			statusText = "编辑中...";
		}
	}
	if (!didChange) {
		showNotice("未检测到可应用的改动", "error");
		return;
	}
	contextMenuImageSrc = currentSrc;
	persistDraft(true, true);
	showNotice("图片修改已应用", "success");
	closeImageEditDialog();
}

function openImageCaptionDialog(imageElement: HTMLImageElement | null) {
	const src =
		imageElement?.currentSrc || imageElement?.src || contextMenuImageSrc;
	if (!src) {
		showNotice("未找到图片地址", "error");
		return;
	}
	captionEditSrc = src;
	captionEditValue = (
		imageElement?.getAttribute("title") || ""
	).trim();
	captionEditVisible = true;
}

function closeImageCaptionDialog() {
	captionEditVisible = false;
	captionEditSrc = "";
	captionEditValue = "";
}

function applyImageCaptionDialog() {
	const src = captionEditSrc || contextMenuImageSrc;
	if (!src) {
		showNotice("未找到图片地址", "error");
		return;
	}
	const captionText = captionEditValue.trim();
	const changed = updateImageCaptionInMarkdown(src, captionText);
	if (contextMenuImageElement) {
		if (captionText) {
			contextMenuImageElement.setAttribute("title", captionText);
		} else {
			contextMenuImageElement.removeAttribute("title");
		}
	}
	if (!changed) {
		showNotice("说明内容未变化", "error");
		return;
	}
	persistDraft(true, true);
	showNotice(captionText ? "下方说明已更新" : "下方说明已清除", "success");
	closeImageCaptionDialog();
}

function openEditorContextMenu(
	event: MouseEvent,
	type: "text" | "image",
	host: HTMLElement,
	imageElement: HTMLImageElement | null = null,
	textEffectState: ContextMenuTextEffectState = DEFAULT_CONTEXT_MENU_TEXT_EFFECT_STATE,
) {
	contextMenuType = type;
	contextMenuVisible = true;
	const shell = host.closest(".editor-shell");
	const shellRect =
		shell instanceof HTMLElement ? shell.getBoundingClientRect() : null;
	const offsetLeft = shellRect?.left ?? 0;
	const offsetTop = shellRect?.top ?? 0;
	contextMenuX = event.clientX - offsetLeft;
	contextMenuY = event.clientY - offsetTop;
	contextMenuImageElement = imageElement;
	contextMenuImageSrc = imageElement?.currentSrc || imageElement?.src || "";
	contextMenuImageAlt = (imageElement?.getAttribute("alt") || "").trim();
	contextMenuTextEffectState = { ...textEffectState };
	void tick().then(() => {
		if (!contextMenuVisible || !contextMenuElement) return;
		const bounds = contextMenuElement.getBoundingClientRect();
		const safeRight = (shellRect?.width ?? window.innerWidth) - 8;
		const safeBottom = (shellRect?.height ?? window.innerHeight) - 8;
		contextMenuX = Math.max(8, contextMenuX);
		contextMenuY = Math.max(8, contextMenuY);
		if (contextMenuX + bounds.width > safeRight) {
			contextMenuX = Math.max(8, safeRight - bounds.width);
		}
		if (contextMenuY + bounds.height > safeBottom) {
			contextMenuY = Math.max(8, safeBottom - bounds.height);
		}
	});
}

function getContextMenuTextEffectState(
	target: Element,
	inMarkdownEditor: boolean,
	inWysiwygEditor: boolean,
): ContextMenuTextEffectState {
	const readMarkdownSelectionWrappedByToken = (
		token: string,
		options: { avoidDoubleAsterisk?: boolean } = {},
	): boolean => {
		if (!editor) return false;
		const range = getEditorSelectionOffsets();
		if (!range) return false;
		const [rawFrom, rawTo] = range;
		const markdown = editor.getMarkdown();
		if (rawFrom < 0 || rawTo > markdown.length) return false;
		const tokenLength = token.length;
		const hasOuterWrap =
			rawFrom >= tokenLength &&
			rawTo + tokenLength <= markdown.length &&
			markdown.slice(rawFrom - tokenLength, rawFrom) === token &&
			markdown.slice(rawTo, rawTo + tokenLength) === token;
		if (hasOuterWrap) {
			if (
				options.avoidDoubleAsterisk &&
				token === "*" &&
				((rawFrom >= 2 && markdown.slice(rawFrom - 2, rawFrom) === "**") ||
					markdown.slice(rawTo, rawTo + 2) === "**")
			) {
				return false;
			}
			return true;
		}
		const selected = markdown.slice(rawFrom, rawTo);
		if (
			selected.length >= tokenLength * 2 &&
			selected.startsWith(token) &&
			selected.endsWith(token)
		) {
			if (
				options.avoidDoubleAsterisk &&
				token === "*" &&
				(selected.startsWith("**") || selected.endsWith("**"))
			) {
				return false;
			}
			return true;
		}
		return false;
	};

	const readMarkdownSelectionInCodeBlock = (): boolean => {
		if (!editor) return false;
		const range = getEditorSelectionOffsets();
		if (!range) return false;
		const [rawFrom] = range;
		const markdown = editor.getMarkdown();
		const before = markdown.slice(0, rawFrom);
		const lines = before.split("\n");
		let fence: "```" | "~~~" | null = null;
		for (const line of lines) {
			const trimmed = line.trimStart();
			const marker = trimmed.startsWith("```")
				? "```"
				: trimmed.startsWith("~~~")
					? "~~~"
					: null;
			if (!marker) continue;
			if (!fence) {
				fence = marker;
				continue;
			}
			if (fence === marker) {
				fence = null;
			}
		}
		return fence !== null;
	};

	const readWysiwygInlineStyleState = (
		element: Element,
	): Partial<ContextMenuTextEffectState> => {
		const styleState: Partial<ContextMenuTextEffectState> = {};
		const root = element.closest(".toastui-editor-ww-container");
		let current: Element | null = element;
		while (current) {
			if (current instanceof HTMLElement) {
				const style = window.getComputedStyle(current);
				const weight = Number.parseInt(style.fontWeight, 10);
				if (
					!styleState.bold &&
					(style.fontWeight === "bold" ||
						style.fontWeight === "bolder" ||
						(Number.isFinite(weight) && weight >= 600))
				) {
					styleState.bold = true;
				}
				if (
					!styleState.italic &&
					(style.fontStyle.includes("italic") ||
						style.fontStyle.includes("oblique"))
				) {
					styleState.italic = true;
				}
				if (
					!styleState.strike &&
					style.textDecorationLine.includes("line-through")
				) {
					styleState.strike = true;
				}
				if (!styleState.codeBlock && current.matches("pre")) {
					styleState.codeBlock = true;
				}
				if (
					!styleState.code &&
					(current.matches("code") ||
						style.fontFamily.toLowerCase().includes("monospace"))
				) {
					styleState.code = true;
				}
			}
			if (!root || current === root) break;
			current = current.parentElement;
		}
		if (styleState.codeBlock) {
			styleState.code = false;
		}
		return styleState;
	};

	const state: ContextMenuTextEffectState = {
		...DEFAULT_CONTEXT_MENU_TEXT_EFFECT_STATE,
	};
	if (inMarkdownEditor) {
		state.bold = Boolean(target.closest(".toastui-editor-md-bold"));
		state.italic = Boolean(target.closest(".toastui-editor-md-italic"));
		state.strike = Boolean(target.closest(".toastui-editor-md-strike"));
		state.code = Boolean(
			target.closest(".toastui-editor-md-code") &&
				!target.closest(".toastui-editor-md-code-block"),
		);
		state.codeBlock = Boolean(
			target.closest(
				".toastui-editor-md-code-block, .toastui-editor-md-code-block-line-background",
			),
		);
		state.bold = state.bold || readMarkdownSelectionWrappedByToken("**");
		state.italic =
			state.italic ||
			readMarkdownSelectionWrappedByToken("*", { avoidDoubleAsterisk: true });
		state.strike = state.strike || readMarkdownSelectionWrappedByToken("~~");
		state.code = state.code || readMarkdownSelectionWrappedByToken("`");
		state.codeBlock = state.codeBlock || readMarkdownSelectionInCodeBlock();
		return state;
	}
	if (inWysiwygEditor) {
		state.bold = Boolean(target.closest("strong, b"));
		state.italic = Boolean(target.closest("em, i"));
		state.strike = Boolean(target.closest("del, s, strike"));
		state.codeBlock = Boolean(target.closest("pre"));
		state.code = Boolean(target.closest("code")) && !state.codeBlock;
		const styleState = readWysiwygInlineStyleState(target);
		state.bold = state.bold || Boolean(styleState.bold);
		state.italic = state.italic || Boolean(styleState.italic);
		state.strike = state.strike || Boolean(styleState.strike);
		state.codeBlock = state.codeBlock || Boolean(styleState.codeBlock);
		state.code = (state.code || Boolean(styleState.code)) && !state.codeBlock;
		state.bold = state.bold || readMarkdownSelectionWrappedByToken("**");
		state.italic =
			state.italic ||
			readMarkdownSelectionWrappedByToken("*", { avoidDoubleAsterisk: true });
		state.strike = state.strike || readMarkdownSelectionWrappedByToken("~~");
		state.code =
			(state.code || readMarkdownSelectionWrappedByToken("`")) &&
			!state.codeBlock;
		state.codeBlock = state.codeBlock || readMarkdownSelectionInCodeBlock();
	}
	return state;
}

function getContextMenuCommandLabel(command: ContextMenuTextEffectKey): string {
	const active = contextMenuTextEffectState[command];
	if (command === "bold") {
		return active ? "取消加粗效果" : "加粗";
	}
	if (command === "italic") {
		return active ? "取消斜体效果" : "斜体";
	}
	if (command === "strike") {
		return active ? "取消删除线效果" : "删除线";
	}
	if (command === "code") {
		return active ? "取消行内代码效果" : "行内代码";
	}
	return active ? "取消代码块效果" : "代码块";
}

function runEditorCommand(command: string) {
	if (!editor) return;
	try {
		const active = document.activeElement;
		const editorHasActiveFocus = Boolean(
			editorHost && active instanceof Node && editorHost.contains(active),
		);
		if (!editorHasActiveFocus) {
			editor.focus?.();
		}
		if (command === "strike" && editor.isMarkdownMode?.()) {
			const toggled = tryToggleMarkdownStrike();
			if (!toggled) {
				editor.exec?.(command);
			}
			closeEditorContextMenu();
			return;
		}
		editor.exec?.(command);
	} catch (error) {
		showNotice(
			error instanceof Error ? `操作失败：${error.message}` : "操作失败",
			"error",
		);
	}
	closeEditorContextMenu();
}

function readEditorSelectionText(): string {
	const selectionText = window.getSelection()?.toString() || "";
	if (selectionText) {
		return selectionText;
	}
	const active = document.activeElement;
	if (
		active instanceof HTMLInputElement ||
		active instanceof HTMLTextAreaElement
	) {
		const start = active.selectionStart ?? 0;
		const end = active.selectionEnd ?? 0;
		return active.value.slice(start, end);
	}
	return "";
}

function insertTextIntoActiveEditor(text: string): boolean {
	if (!text) return false;
	if (editor?.replaceSelection) {
		try {
			editor.focus?.();
			editor.replaceSelection(text);
			markDirty();
			return true;
		} catch {
			// Fallback to direct DOM insertion when editor API insertion is unavailable.
		}
	}
	editor?.focus?.();
	const active = document.activeElement;
	if (
		active instanceof HTMLTextAreaElement ||
		active instanceof HTMLInputElement
	) {
		const start = active.selectionStart ?? active.value.length;
		const end = active.selectionEnd ?? start;
		active.setRangeText(text, start, end, "end");
		active.dispatchEvent(new Event("input", { bubbles: true }));
		markDirty();
		return true;
	}
	if (active instanceof HTMLElement && active.isContentEditable) {
		const inserted = document.execCommand("insertText", false, text);
		if (!inserted) {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return false;
			const range = selection.getRangeAt(0);
			range.deleteContents();
			const textNode = document.createTextNode(text);
			range.insertNode(textNode);
			range.setStartAfter(textNode);
			range.collapse(true);
			selection.removeAllRanges();
			selection.addRange(range);
		}
		markDirty();
		return true;
	}
	return false;
}

async function handleTextContextMenuAction(action: "copy" | "paste") {
	if (action === "copy") {
		const selectedText = readEditorSelectionText();
		if (!selectedText) {
			showNotice("未选中文本", "error");
			closeEditorContextMenu();
			return;
		}
		try {
			await navigator.clipboard.writeText(selectedText);
			showNotice("文本已复制", "success");
		} catch {
			showNotice("复制失败，请检查浏览器权限", "error");
		}
		closeEditorContextMenu();
		return;
	}

	try {
		const text = await navigator.clipboard.readText();
		if (!text) {
			showNotice("剪贴板为空", "error");
			closeEditorContextMenu();
			return;
		}
		const inserted = insertTextIntoActiveEditor(text);
		showNotice(
			inserted ? "已粘贴" : "粘贴失败，请先在编辑区定位光标",
			inserted ? "success" : "error",
		);
	} catch {
		showNotice("读取剪贴板失败，请检查浏览器权限", "error");
	}
	closeEditorContextMenu();
}

function removeImageBySrc(targetSrc: string): boolean {
	if (!editor || !targetSrc) return false;
	const markdown = editor.getMarkdown();
	const escapedSrc = escapeRegex(targetSrc);
	const markdownImagePattern = new RegExp(
		`!\\[[^\\]]*\\]\\((?:<)?${escapedSrc}(?:>)?(?:\\s+["'][^"']*["'])?\\)`,
		"i",
	);
	const htmlImagePattern = new RegExp(
		`<img\\b[^>]*\\bsrc=(["'])${escapedSrc}\\1[^>]*>`,
		"i",
	);
	let next = markdown.replace(markdownImagePattern, "");
	if (next === markdown) {
		next = markdown.replace(htmlImagePattern, "");
	}
	if (next === markdown) {
		let removed = false;
		next = markdown.replace(
			/!\[([^\]]*)\]\((?:<)?([^)\s>]+)(?:>)?(\s+["'][^"']*["'])?\)/gi,
			(full, _altText = "", imageSrc = "") => {
				if (removed || !isSameImageSource(String(imageSrc), targetSrc)) {
					return full;
				}
				removed = true;
				return "";
			},
		);
	}
	if (next === markdown) {
		let removed = false;
		next = markdown.replace(
			/<img\b([^>]*?)\bsrc=(["'])(.*?)\2([^>]*)>/gi,
			(full, _prefix = "", _quote = '"', imageSrc = "") => {
				if (removed || !isSameImageSource(String(imageSrc), targetSrc)) {
					return full;
				}
				removed = true;
				return "";
			},
		);
	}
	if (next === markdown) {
		return false;
	}
	const compacted = next.replace(/\n{3,}/g, "\n\n").trimEnd();
	editor.setMarkdown(compacted);
	markDirty();
	return true;
}

function handleImageContextMenuAction(
	action: "preview" | "copy" | "delete" | "edit" | "editCaption" | "deleteFile",
) {
	if (action === "edit") {
		openImageEditDialog(contextMenuImageElement);
		closeEditorContextMenu();
		return;
	}
	if (action === "editCaption") {
		openImageCaptionDialog(contextMenuImageElement);
		closeEditorContextMenu();
		return;
	}
	if (action === "preview") {
		if (contextMenuImageElement) {
			openImagePreview(contextMenuImageElement);
		}
		closeEditorContextMenu();
		return;
	}
	if (action === "copy") {
		const src = contextMenuImageSrc;
		if (!src) {
			showNotice("未找到图片地址", "error");
			closeEditorContextMenu();
			return;
		}
		void navigator.clipboard
			.writeText(src)
			.then(() => {
				showNotice("图片地址已复制", "success");
			})
			.catch(() => {
				showNotice("复制失败，请手动复制", "error");
			});
		closeEditorContextMenu();
		return;
	}
	if (!contextMenuImageSrc) {
		showNotice("未找到图片地址", "error");
		closeEditorContextMenu();
		return;
	}
	if (action === "deleteFile") {
		const repoPath = normalizeEditorUploadRepoPathFromUrl(contextMenuImageSrc);
		if (!repoPath) {
			showNotice("仅支持删除 /uploads/editor/ 下的已上传图片文件", "error");
			closeEditorContextMenu();
			return;
		}
		openImageDeleteConfirmDialog(contextMenuImageSrc, contextMenuImageAlt);
		closeEditorContextMenu();
		return;
	}
	const removed = removeImageBySrc(contextMenuImageSrc);
	showNotice(
		removed ? "图片引用已删除" : "未在内容中找到该图片",
		removed ? "success" : "error",
	);
	closeEditorContextMenu();
}

async function confirmDeleteImageFile(): Promise<void> {
	if (imageDeleteBusy) return;
	if (!pendingDeleteImageSrc) {
		closeImageDeleteConfirmDialog();
		return;
	}
	imageDeleteBusy = true;
	try {
		const result = await requestDeleteEditorImageAsset(pendingDeleteImageSrc);
		const removed = removeImageBySrc(pendingDeleteImageSrc);
		const deletedTargets = [
			result.localDeleted ? "本地" : "",
			result.githubDeleted ? "GitHub" : "",
		].filter(Boolean);
		const targetText = deletedTargets.length
			? deletedTargets.join(" + ")
			: "未检测到可删除文件";
		showNotice(
			removed
				? `已删除图片文件（${targetText}）并移除正文引用`
				: `已删除图片文件（${targetText}），但正文中未找到引用`,
			"success",
		);
		imageDeleteConfirmVisible = false;
		pendingDeleteImageSrc = "";
		pendingDeleteImageAlt = "";
		pendingDeleteImageRepoPath = "";
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "删除图片文件失败";
		showNotice(message, "error");
	} finally {
		imageDeleteBusy = false;
	}
}

function bindEditorImageCaptions(host: HTMLElement): () => void {
	const applyCaptions = () => {
		const images = host.querySelectorAll<HTMLImageElement>(
			".toastui-editor-md-preview img, .toastui-editor-preview img, .toastui-editor-viewer img",
		);
		for (const image of images) {
			const title = (image.getAttribute("title") || "").trim();
			const sibling = image.nextElementSibling;
			const existing =
				sibling instanceof HTMLElement &&
				sibling.classList.contains("dev-img-caption")
					? sibling
					: null;
			if (!title) {
				existing?.remove();
				continue;
			}
			if (existing) {
				if (existing.textContent !== title) existing.textContent = title;
				continue;
			}
			const caption = document.createElement("span");
			caption.className = "dev-img-caption";
			caption.textContent = title;
			image.after(caption);
		}
	};
	let frame = 0;
	const scheduleApply = () => {
		if (frame) cancelAnimationFrame(frame);
		frame = window.requestAnimationFrame(() => {
			frame = 0;
			applyCaptions();
		});
	};
	const observer = new MutationObserver(scheduleApply);
	observer.observe(host, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ["title"],
	});
	scheduleApply();
	return () => {
		observer.disconnect();
		if (frame) cancelAnimationFrame(frame);
	};
}

function getContextMenuPathElements(event: MouseEvent): Element[] {
	return event
		.composedPath()
		.filter((node): node is Element => node instanceof Element);
}

function resolveContextMenuTargetElement(
	host: HTMLElement,
	event: MouseEvent,
	pathElements: Element[],
): Element | null {
	for (const element of pathElements) {
		if (host.contains(element)) {
			return element;
		}
	}
	const pointTarget = document.elementFromPoint(event.clientX, event.clientY);
	if (pointTarget instanceof Element && host.contains(pointTarget)) {
		return pointTarget;
	}
	return null;
}

function resolveContextMenuImageElement(
	host: HTMLElement,
	event: MouseEvent,
	pathElements: Element[],
): HTMLImageElement | null {
	for (const element of pathElements) {
		if (element instanceof HTMLImageElement && host.contains(element)) {
			return element;
		}
	}
	const targetAtPoint = document.elementFromPoint(event.clientX, event.clientY);
	if (!(targetAtPoint instanceof Element)) {
		return null;
	}
	const imageElement = targetAtPoint.closest("img");
	return imageElement instanceof HTMLImageElement && host.contains(imageElement)
		? imageElement
		: null;
}

function bindEditorContextMenu(host: HTMLElement): () => void {
	const handleContextMenuCapture = (event: MouseEvent) => {
		if (
			imagePreviewVisible ||
			linkConfirmVisible ||
			imageDeleteConfirmVisible ||
			imageEditVisible ||
			captionEditVisible
		)
			return;
		const pathElements = getContextMenuPathElements(event);
		const target = resolveContextMenuTargetElement(host, event, pathElements);
		if (!target) return;
		const nearestEditorHost = target.closest(".editor-host");
		if (nearestEditorHost !== host) return;
		if (
			target.closest(
				[
					".toastui-editor-defaultUI-toolbar",
					".toastui-editor-mode-switch",
					".toastui-editor-popup",
					".editor-context-menu",
				].join(","),
			)
		) {
			return;
		}
		const inMarkdownEditor = Boolean(
			target.closest(".toastui-editor-md-container .toastui-editor"),
		);
		const inMarkdownPreview = Boolean(
			target.closest(".toastui-editor-md-container .toastui-editor-md-preview"),
		);
		const inWysiwygEditor = Boolean(
			target.closest(".toastui-editor-ww-container .toastui-editor-contents"),
		);
		const imageElement = resolveContextMenuImageElement(
			host,
			event,
			pathElements,
		);
		if (inMarkdownPreview) {
			if (imageElement instanceof HTMLImageElement) {
				event.preventDefault();
				event.stopPropagation();
				openEditorContextMenu(event, "image", host, imageElement);
				return;
			}
			closeEditorContextMenu();
			return;
		}
		const inEditableEditor = inMarkdownEditor || inWysiwygEditor;
		if (!inEditableEditor) return;
		if (imageElement instanceof HTMLImageElement) {
			event.preventDefault();
			event.stopPropagation();
			openEditorContextMenu(event, "image", host, imageElement);
			return;
		}
		const textEffectState = getContextMenuTextEffectState(
			target,
			inMarkdownEditor,
			inWysiwygEditor,
		);
		event.preventDefault();
		event.stopPropagation();
		openEditorContextMenu(event, "text", host, null, textEffectState);
	};

	const handlePointerDownCapture = (event: PointerEvent) => {
		if (!contextMenuVisible) return;
		const target = event.target;
		if (!(target instanceof Node)) return;
		if (contextMenuElement?.contains(target)) return;
		closeEditorContextMenu();
	};

	const handleWindowKeydownCapture = (event: KeyboardEvent) => {
		if (event.key !== "Escape") return;
		closeEditorContextMenu();
	};

	const handleWindowBlur = () => {
		closeEditorContextMenu();
	};

	window.addEventListener("contextmenu", handleContextMenuCapture, true);
	window.addEventListener("pointerdown", handlePointerDownCapture, true);
	window.addEventListener("keydown", handleWindowKeydownCapture, true);
	window.addEventListener("blur", handleWindowBlur);
	window.addEventListener("resize", closeEditorContextMenu);
	window.addEventListener("scroll", closeEditorContextMenu, true);

	return () => {
		window.removeEventListener("contextmenu", handleContextMenuCapture, true);
		window.removeEventListener("pointerdown", handlePointerDownCapture, true);
		window.removeEventListener("keydown", handleWindowKeydownCapture, true);
		window.removeEventListener("blur", handleWindowBlur);
		window.removeEventListener("resize", closeEditorContextMenu);
		window.removeEventListener("scroll", closeEditorContextMenu, true);
		closeEditorContextMenu();
	};
}

function readMarkdownOnlyModePreference(): boolean {
	const stored = localStorage.getItem(DEV_EDITOR_MARKDOWN_ONLY_STORAGE_KEY);
	return stored === "true";
}

function persistMarkdownOnlyModePreference(enabled: boolean): void {
	localStorage.setItem(
		DEV_EDITOR_MARKDOWN_ONLY_STORAGE_KEY,
		enabled ? "true" : "false",
	);
}

function setMarkdownOnlyMode(enabled: boolean): void {
	markdownOnlyMode = enabled;
	persistMarkdownOnlyModePreference(enabled);
	if (enabled) {
		editor?.changeMode?.("markdown", true);
	}
	window.requestAnimationFrame(() => {
		localizeModeSwitchLabels();
	});
}

function getStoredDevCredentialValue(): string {
	return readStoredDevCredential();
}

function armDeveloperModeAutoLock(): void {
	scheduleDeveloperModeAutoLock();
}

function showNotice(
	message: string,
	type: "info" | "success" | "error" = "info",
) {
	notice = message;
	noticeType = type;
	if (type === "error") {
		return;
	}
	setTimeout(() => {
		if (notice === message) {
			notice = "";
		}
	}, 2800);
}

function sanitizeImagePreviewFileName(input: string): string {
	const trimmed = input.trim();
	if (!trimmed) return "未命名图片";
	return trimmed.replace(/[\r\n]+/g, " ").slice(0, 120);
}

function getImagePreviewFileName(blob: Blob): string {
	if (blob instanceof File && blob.name.trim()) {
		return sanitizeImagePreviewFileName(blob.name);
	}
	const mimeSubtype = blob.type.split("/")[1]?.trim().toLowerCase() || "png";
	const extension = mimeSubtype.replace(/[^a-z0-9.+-]/g, "") || "png";
	return `image-${Date.now()}.${extension}`;
}

type ToastImageHookCallback = (url: string, text?: string) => void;

function toUploadFile(blob: Blob): File {
	if (blob instanceof File && blob.name.trim()) {
		return blob;
	}
	const fallbackName = getImagePreviewFileName(blob);
	return new File([blob], fallbackName, {
		type: blob.type || "application/octet-stream",
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function isRetryableUploadStatus(status: number): boolean {
	return status === 429 || status === 502 || status === 503 || status === 504;
}

function extractUploadErrorMessage(payload: unknown): string {
	if (payload && typeof payload === "object" && "message" in payload) {
		const message = (payload as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) {
			return message;
		}
	}
	return "图片上传失败";
}

function encodeRepoPathForRawUrl(path: string): string {
	return path
		.split("/")
		.map((part) => encodeURIComponent(part))
		.join("/");
}

function buildGitHubRawUrlFromCommit(
	commitUrl: string,
	repoPath: string,
): string | null {
	const normalizedCommitUrl = (commitUrl || "").trim();
	const normalizedRepoPath = (repoPath || "").trim();
	if (!normalizedCommitUrl || !normalizedRepoPath) return null;
	const commitMatch = normalizedCommitUrl.match(
		/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/commit\/([a-f0-9]{7,40})/i,
	);
	if (!commitMatch) return null;
	const owner = commitMatch[1];
	const repo = commitMatch[2];
	const sha = commitMatch[3];
	const encodedPath = encodeRepoPathForRawUrl(normalizedRepoPath);
	return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(sha)}/${encodedPath}`;
}

function resolveUploadedImageUrl(result: unknown): string {
	if (!result || typeof result !== "object") return "";
	const payload = result as {
		url?: unknown;
		rawUrl?: unknown;
		path?: unknown;
		commitUrl?: unknown;
	};
	const rawUrl =
		typeof payload.rawUrl === "string" ? payload.rawUrl.trim() : "";
	if (rawUrl) return rawUrl;
	const url = typeof payload.url === "string" ? payload.url.trim() : "";
	const path = typeof payload.path === "string" ? payload.path.trim() : "";
	const commitUrl =
		typeof payload.commitUrl === "string" ? payload.commitUrl.trim() : "";
	if (url && !url.startsWith("/uploads/editor/")) return url;
	const commitRawUrl = buildGitHubRawUrlFromCommit(commitUrl, path);
	if (commitRawUrl) return commitRawUrl;
	return url;
}

async function requestEditorImageUpload(blob: Blob): Promise<{ url: string }> {
	const devCodeHash = getStoredDevCredentialValue();
	if (!devCodeHash) {
		throw new Error("缺少开发者口令，请重新解锁开发者模式");
	}
	const uploadFile = toUploadFile(blob);
	const formData = new FormData();
	formData.append("file", uploadFile, uploadFile.name);
	formData.append("devCodeHash", devCodeHash);

	const response = await fetch("/api/dev/upload-image", {
		method: "POST",
		body: formData,
	});
	const result = await response.json().catch(() => ({}));
	const ok =
		typeof result === "object" &&
		result !== null &&
		"ok" in result &&
		Boolean((result as { ok?: unknown }).ok);
	const url = resolveUploadedImageUrl(result);

	if (!response.ok || !ok || !url) {
		const message = extractUploadErrorMessage(result);
		const error = new Error(message) as Error & { status?: number };
		error.status = response.status;
		throw error;
	}
	const normalizedUrl = toEditorSafeImageUrl(url);
	return { url: normalizedUrl };
}

type DeleteEditorImageResult = {
	path: string;
	localDeleted: boolean;
	githubDeleted: boolean;
	commitUrl?: string;
};

async function requestDeleteEditorImageAsset(
	src: string,
): Promise<DeleteEditorImageResult> {
	const devCodeHash = getStoredDevCredentialValue();
	if (!devCodeHash) {
		throw new Error("缺少开发者口令，请重新解锁开发者模式");
	}

	const response = await fetch("/api/dev/delete-image", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			src,
			path: normalizeEditorUploadRepoPathFromUrl(src),
			devCodeHash,
		}),
	});

	const result = (await response.json().catch(() => ({}))) as {
		ok?: boolean;
		message?: string;
		path?: string;
		localDeleted?: boolean;
		githubDeleted?: boolean;
		commitUrl?: string;
	};
	if (!response.ok || !result.ok || !result.path) {
		throw new Error(result.message || "删除图片文件失败");
	}

	return {
		path: result.path,
		localDeleted: Boolean(result.localDeleted),
		githubDeleted: Boolean(result.githubDeleted),
		commitUrl: typeof result.commitUrl === "string" ? result.commitUrl : "",
	};
}

async function isUploadedImageReachable(url: string): Promise<boolean> {
	const safeUrl = toEditorSafeImageUrl(url);
	if (!safeUrl) return false;
	try {
		const parsed = new URL(safeUrl, window.location.origin);
		if (parsed.origin !== window.location.origin) {
			// Cross-origin images can be blocked by CORS for fetch checks.
			// Trust backend upload result and let editor render directly.
			return true;
		}
	} catch {
		// Ignore parse errors and fallback to fetch probes.
	}
	for (let i = 0; i < IMAGE_URL_VERIFY_RETRIES; i += 1) {
		try {
			const head = await fetch(safeUrl, {
				method: "HEAD",
				cache: "no-store",
			});
			if (head.ok) return true;
		} catch {}
		try {
			const get = await fetch(safeUrl, {
				method: "GET",
				cache: "no-store",
			});
			if (get.ok) return true;
		} catch {}
		if (i < IMAGE_URL_VERIFY_RETRIES - 1) {
			await sleep(IMAGE_URL_VERIFY_DELAY_MS * (i + 1));
		}
	}
	return false;
}

async function uploadEditorImageWithRetry(
	blob: Blob,
): Promise<{ url: string }> {
	let attempt = 0;
	let lastError: unknown = null;
	while (attempt <= IMAGE_UPLOAD_MAX_RETRIES) {
		try {
			return await requestEditorImageUpload(blob);
		} catch (error) {
			lastError = error;
			const status =
				error && typeof error === "object" && "status" in error
					? Number((error as { status?: unknown }).status)
					: Number.NaN;
			const retryable = Number.isFinite(status)
				? isRetryableUploadStatus(status)
				: true;
			if (attempt >= IMAGE_UPLOAD_MAX_RETRIES || !retryable) {
				throw error;
			}
			const delay = IMAGE_UPLOAD_RETRY_BASE_DELAY_MS * (attempt + 1);
			await sleep(delay);
			attempt += 1;
		}
	}
	throw lastError instanceof Error ? lastError : new Error("图片上传失败");
}

async function uploadEditorImage(blob: Blob): Promise<{ url: string }> {
	const uploadTask = imageUploadQueue.then(() =>
		uploadEditorImageWithRetry(blob),
	);
	imageUploadQueue = uploadTask.then(
		() => undefined,
		() => undefined,
	);
	const uploaded = await uploadTask;
	const reachable = await isUploadedImageReachable(uploaded.url);
	if (!reachable) {
		throw new Error("图片已上传，但当前不可访问，请稍后重试");
	}
	return uploaded;
}

function insertUploadedImage(
	callback: ToastImageHookCallback,
	uploadedUrl: string,
): boolean {
	callback(toEditorSafeImageUrl(uploadedUrl));
	markDirty();
	statusText = "已插入已上传图片";
	return true;
}

function buildImagePreviewHeading(fileName: string): string {
	return `###### ${IMAGE_PREVIEW_HEADING_PREFIX}${sanitizeImagePreviewFileName(fileName)}\n`;
}

function containsEmbeddedDataImage(markdown: string): boolean {
	return /data:image\//i.test(markdown);
}

async function dataUriToBlob(dataUri: string): Promise<Blob> {
	const response = await fetch(dataUri);
	if (!response.ok) {
		throw new Error("解析 data:image 失败");
	}
	return response.blob();
}

async function replaceEmbeddedDataImagesWithUploadedUrls(
	markdown: string,
): Promise<string> {
	const markdownDataImagePattern =
		/!\[([^\]]*)\]\(\s*(data:image\/[^\s)]+)\s*\)/gi;
	const htmlDataImagePattern =
		/<img\b[^>]*\bsrc=(['"])(data:image\/[^'"]+)\1[^>]*>/gi;

	let nextMarkdown = markdown;

	const markdownMatches: Array<{
		full: string;
		altText: string;
		dataUri: string;
	}> = [];
	for (const match of markdown.matchAll(markdownDataImagePattern)) {
		const [full, altText = "", dataUri = ""] = match;
		if (!full || !dataUri) continue;
		markdownMatches.push({ full, altText, dataUri });
	}

	for (const match of markdownMatches) {
		const cachedUrl = dataImageUploadCache.get(match.dataUri);
		const targetUrl = cachedUrl
			? cachedUrl
			: await (async () => {
					const blob = await dataUriToBlob(match.dataUri);
					const uploaded = await uploadEditorImage(blob);
					dataImageUploadCache.set(match.dataUri, uploaded.url);
					return uploaded.url;
				})();
		const replacement = `![${match.altText}](${targetUrl})`;
		nextMarkdown = nextMarkdown.replace(match.full, replacement);
	}

	const htmlMatches: Array<{ full: string; dataUri: string }> = [];
	for (const match of nextMarkdown.matchAll(htmlDataImagePattern)) {
		const [full, _quote = "", dataUri = ""] = match;
		if (!full || !dataUri) continue;
		htmlMatches.push({ full, dataUri });
	}

	let htmlImageIndex = 1;
	for (const match of htmlMatches) {
		const cachedUrl = dataImageUploadCache.get(match.dataUri);
		const targetUrl = cachedUrl
			? cachedUrl
			: await (async () => {
					const blob = await dataUriToBlob(match.dataUri);
					const uploaded = await uploadEditorImage(blob);
					dataImageUploadCache.set(match.dataUri, uploaded.url);
					return uploaded.url;
				})();
		const replacement = `![图片${htmlImageIndex}](${targetUrl})`;
		nextMarkdown = nextMarkdown.replace(match.full, replacement);
		htmlImageIndex += 1;
	}

	return nextMarkdown;
}

function extractFileNameFromAltText(altText: string): string {
	const trimmed = altText.trim();
	if (!trimmed) return "";
	if (trimmed.startsWith(IMAGE_PREVIEW_HEADING_PREFIX)) {
		return trimmed.slice(IMAGE_PREVIEW_HEADING_PREFIX.length).trim();
	}
	return trimmed;
}

function normalizeEmbeddedDataImages(markdown: string): string {
	let unnamedIndex = 1;
	const nextFallbackFileName = (mimeSubtypeRaw?: string): string => {
		const mimeSubtype = (mimeSubtypeRaw || "png").trim().toLowerCase();
		const extension = mimeSubtype.replace(/[^a-z0-9.+-]/g, "") || "png";
		const fileName = `image-${unnamedIndex}.${extension}`;
		unnamedIndex += 1;
		return fileName;
	};

	const markdownImagePattern = /!\[[^\]]*\]\(\s*data:image\/[\s\S]*?\)/gi;
	const markdownBlobImagePattern = /!\[([^\]]*)\]\(\s*blob:[^)]+\)/gi;
	const htmlImagePattern =
		/<img\b[^>]*\bsrc=(['"])data:image\/[\s\S]*?\1[^>]*>/gi;
	const htmlBlobImagePattern = /<img\b[^>]*\bsrc=(['"])blob:[^"']*\1[^>]*>/gi;

	const replacedMarkdownImages = markdown.replace(
		markdownImagePattern,
		(_full, altText: string, mimeSubtype: string) => {
			const fromAlt = extractFileNameFromAltText(altText || "");
			const fileName = fromAlt || nextFallbackFileName(mimeSubtype);
			return buildImagePreviewHeading(fileName);
		},
	);

	const replacedHtmlImages = replacedMarkdownImages.replace(
		htmlImagePattern,
		(_full, _quote: string, mimeSubtype: string) => {
			const fileName = nextFallbackFileName(mimeSubtype);
			return buildImagePreviewHeading(fileName);
		},
	);

	const replacedBlobMarkdownImages = replacedHtmlImages.replace(
		markdownBlobImagePattern,
		(_full, altText: string) => {
			const fromAlt = extractFileNameFromAltText(altText || "");
			const fileName = fromAlt || nextFallbackFileName("png");
			return buildImagePreviewHeading(fileName);
		},
	);

	const replacedBlobHtmlImages = replacedBlobMarkdownImages.replace(
		htmlBlobImagePattern,
		() => buildImagePreviewHeading(nextFallbackFileName("png")),
	);

	return replacedBlobHtmlImages;
}

function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}

function getEffectiveSlugValue(rawSlug: string, rawTitle: string): string {
	return slugify((rawSlug || "").trim() || (rawTitle || "").trim());
}

// 草稿是否属于当前编辑器模式（旧草稿无 type 字段，按文章处理）
function draftMatchesMode(item: { type?: "post" | "thought" }): boolean {
	return (item.type || "post") === mode;
}

function getLocalSlugConflictMessage(): string {
	const currentSlug = getEffectiveSlugValue(slug, title);
	if (!currentSlug) return "";

	const duplicateCount = listDrafts().filter((item) => {
		if (activeDraftId && item.id === activeDraftId) {
			return false;
		}
		if (!draftMatchesMode(item)) {
			return false;
		}
		return getEffectiveSlugValue(item.slug, item.title) === currentSlug;
	}).length;

	if (duplicateCount < 1) return "";
	return `草稿箱中还有 ${duplicateCount} 篇草稿使用 slug "${currentSlug}"`;
}

function createDraftId(): string {
	const base = slugify(slug || title) || "draft";
	const usedIds = new Set([
		...listDrafts().filter(draftMatchesMode).map((item) => item.id),
		...listDraftTrash().filter(draftMatchesMode).map((item) => item.id),
	]);
	if (!usedIds.has(base)) {
		return base;
	}

	let suffix = 2;
	while (usedIds.has(`${base}-${suffix}`)) {
		suffix += 1;
	}
	return `${base}-${suffix}`;
}

function buildDraftId(): string {
	if (activeDraftId) return activeDraftId;
	return createDraftId();
}

function buildDraftPayload() {
	return {
		id: buildDraftId(),
		type: mode,
		title,
		slug,
		originalSlug,
		description,
		tags,
		category,
		image,
		draft,
		content: getEditorMarkdownNormalized(),
		published,
	};
}

function persistDraft(silent = false, manual = false) {
	if (!editor) return;
	const payload = buildDraftPayload();
	activeDraftId = payload.id;
	saveDraft(payload);
	dirty = false;
	statusText = `${manual ? "已手动保存" : "已自动保存"} ${new Date().toLocaleTimeString()}`;
	if (!silent) {
		showNotice(manual ? "草稿已手动保存" : "草稿已自动保存", "success");
	}
}

function applyDraft(payload: ReturnType<typeof getDraftById>) {
	if (!payload) return;
	activeDraftId = payload.id || "";
	mode = payload.type || "post";
	title = payload.title || "";
	slug = payload.slug || "";
	originalSlug = payload.originalSlug || "";
	description = payload.description || "";
	tags = payload.tags || "";
	category = payload.category || "";
	image = payload.image || "";
	draft = Boolean(payload.draft);
	published = payload.published || "";
	if (editor) {
		editor.setMarkdown(
			normalizeEditorUploadImageUrls(
				cleanupLegacyDetailsArtifacts(payload.content || ""),
			),
		);
	}
	dirty = false;
	pendingDraftToLoad = null;
	showLoadDraftPrompt = false;
	statusText = "已加载本地草稿";
}

function loadPendingDraft() {
	if (!pendingDraftToLoad) return;
	applyDraft(pendingDraftToLoad);
}

function skipPendingDraft() {
	pendingDraftToLoad = null;
	showLoadDraftPrompt = false;
	statusText = "已忽略本地草稿";
}

function tryLoadDraft() {
	if (!editor) return;
	const params = new URLSearchParams(window.location.search);
	const draftIdFromQuery = params.get("id");
	if (draftIdFromQuery) {
		const target = getDraftById(draftIdFromQuery);
		if (target) {
			applyDraft(target);
		}
		return;
	}
	const latest = listDrafts().filter(draftMatchesMode)[0] || null;
	if (!latest) return;
	pendingDraftToLoad = latest;
	showLoadDraftPrompt = true;
	statusText = "检测到本地草稿";
}

// 切换文章/随笔模式：先保存当前模式的草稿，再重置表单并加载目标模式的最新草稿
function switchEditorMode(nextMode: "post" | "thought") {
	if (nextMode === mode) return;
	if (editor && dirty) {
		persistDraft(true);
	}
	activeDraftId = "";
	title = "";
	slug = "";
	originalSlug = "";
	description = "";
	tags = "";
	category = "";
	image = "";
	draft = false;
	published = "";
	userTouchedSlug = false;
	mode = nextMode;
	if (editor) {
		editor.setMarkdown("");
	}
	dirty = false;
	const latest = listDrafts().filter(draftMatchesMode)[0] || null;
	if (latest) {
		applyDraft(latest);
		showNotice(`已切换到${nextMode === "thought" ? "随笔" : "文章"}模式`, "info");
	} else {
		statusText = `已切换到${nextMode === "thought" ? "随笔" : "文章"}模式`;
		showNotice(`已切换到${nextMode === "thought" ? "随笔" : "文章"}模式，可以开始创作`, "info");
	}
}

// 根据激活按钮实时定位滑块指示条
function updateModeSwitchIndicator() {
	if (!modeSwitchElement) return;
	const active = modeSwitchElement.querySelector<HTMLButtonElement>(
		"button.active",
	);
	if (!active) return;
	modeSwitchIndicatorTranslateX = active.offsetLeft;
	modeSwitchIndicatorWidth = active.offsetWidth;
}

function getModeSwitchButtonRects(): { left: number; width: number }[] {
	if (!modeSwitchElement) return [];
	return Array.from(
		modeSwitchElement.querySelectorAll<HTMLButtonElement>("button"),
	).map((btn) => ({ left: btn.offsetLeft, width: btn.offsetWidth }));
}

// 按下滑块开始拖拽（同时支持点击）
function handleModeSwitchPointerDown(event: PointerEvent) {
	if (!modeSwitchElement) return;
	if (!(event.target instanceof Node)) return;
	if (!modeSwitchElement.contains(event.target)) return;
	modeSwitchDragging = true;
	modeSwitchDragStartPointerX = event.clientX;
	modeSwitchDragStartTranslateX = modeSwitchIndicatorTranslateX;
	modeSwitchDragTranslateX = modeSwitchIndicatorTranslateX;
	window.addEventListener("pointermove", handleModeSwitchPointerMove);
	window.addEventListener("pointerup", handleModeSwitchPointerUp);
}

// 拖拽中：滑块跟随指针位移，但限制在两端按钮范围内
function handleModeSwitchPointerMove(event: PointerEvent) {
if (!modeSwitchDragging) return;
const rects = getModeSwitchButtonRects();
if (rects.length < 2) return;
const minX = rects[0].left;
const maxX = rects[rects.length - 1].left;
const next =
	modeSwitchDragStartTranslateX + (event.clientX - modeSwitchDragStartPointerX);
modeSwitchDragTranslateX = Math.min(maxX, Math.max(minX, next));
}

// 释放：根据滑块位置判定离哪个模式更近并切换
function handleModeSwitchPointerUp() {
	if (!modeSwitchDragging) return;
	modeSwitchDragging = false;
	window.removeEventListener("pointermove", handleModeSwitchPointerMove);
	window.removeEventListener("pointerup", handleModeSwitchPointerUp);
	const rects = getModeSwitchButtonRects();
	const activeIndex = mode === "post" ? 0 : 1;
	let targetIndex = activeIndex;
	let minDistance = Infinity;
	rects.forEach((rect, index) => {
		const distance = Math.abs(modeSwitchDragTranslateX - rect.left);
		if (distance < minDistance) {
			minDistance = distance;
			targetIndex = index;
		}
	});
	const targetMode: "post" | "thought" = targetIndex === 0 ? "post" : "thought";
	if (targetMode !== mode) {
		switchEditorMode(targetMode);
	} else {
		updateModeSwitchIndicator();
	}
}

function localizeModeSwitchLabels() {
	if (!editorHost) return;
	const modeSwitch = editorHost.querySelector<HTMLElement>(
		".toastui-editor-mode-switch",
	);
	if (!modeSwitch) return;
	const tabs = editorHost.querySelectorAll<HTMLElement>(
		".toastui-editor-mode-switch .tab-item",
	);
	if (tabs.length < 2) return;
	const markdownTab = tabs[0];
	const wwTab = tabs[1];
	if (!markdownTab || !wwTab) return;
	const applyStandardTabSelection = (mode: "markdown" | "wysiwyg") => {
		const markdownActive = mode === "markdown";
		const wwActive = mode === "wysiwyg";
		markdownTab.classList.toggle("active", markdownActive);
		wwTab.classList.toggle("active", wwActive);
		markdownTab.setAttribute(
			"aria-selected",
			markdownActive ? "true" : "false",
		);
		wwTab.setAttribute("aria-selected", wwActive ? "true" : "false");
	};
	markdownTab.textContent = "Markdown";
	markdownTab.setAttribute("aria-label", "Markdown");
	if (!wwTab) return;
	wwTab.textContent = "可视化编辑";
	wwTab.setAttribute("aria-label", "可视化编辑");

	if (!markdownTab.dataset.mdOnlyHooked) {
		markdownTab.dataset.mdOnlyHooked = "true";
		markdownTab.addEventListener("click", () => {
			if (markdownOnlyMode) {
				setMarkdownOnlyMode(false);
			}
			applyStandardTabSelection("markdown");
		});
	}
	if (!wwTab.dataset.mdOnlyHooked) {
		wwTab.dataset.mdOnlyHooked = "true";
		wwTab.addEventListener("click", () => {
			if (markdownOnlyMode) {
				setMarkdownOnlyMode(false);
			}
			applyStandardTabSelection("wysiwyg");
		});
	}

	let markdownOnlyTab = modeSwitch.querySelector<HTMLElement>(
		`.tab-item.${MARKDOWN_ONLY_TAB_CLASS}`,
	);
	if (!markdownOnlyTab) {
		const cloned = markdownTab.cloneNode(false);
		if (!(cloned instanceof HTMLElement)) {
			return;
		}
		markdownOnlyTab = cloned;
		markdownOnlyTab.classList.add(MARKDOWN_ONLY_TAB_CLASS);
		markdownOnlyTab.classList.remove("active");
		markdownOnlyTab.removeAttribute("data-type");
		markdownOnlyTab.textContent = "纯编辑";
		markdownOnlyTab.setAttribute("aria-label", "纯编辑");
		markdownOnlyTab.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			setMarkdownOnlyMode(true);
		});
		modeSwitch.append(markdownOnlyTab);
	}

	markdownOnlyTab.textContent = "纯编辑";
	markdownOnlyTab.setAttribute("aria-label", "纯编辑");
	markdownOnlyTab.classList.toggle("active", markdownOnlyMode);
	markdownOnlyTab.setAttribute(
		"aria-selected",
		markdownOnlyMode ? "true" : "false",
	);
	if (markdownOnlyMode) {
		markdownTab.classList.remove("active");
		wwTab.classList.remove("active");
		markdownTab.setAttribute("aria-selected", "false");
		wwTab.setAttribute("aria-selected", "false");
		editor?.changeMode?.("markdown", true);
		return;
	}

	markdownOnlyTab.classList.remove("active");
	markdownOnlyTab.setAttribute("aria-selected", "false");
	// Keep standard tabs mutually exclusive to avoid double-highlight glitches.
	const preferWw =
		wwTab.classList.contains("active") &&
		!markdownTab.classList.contains("active");
	applyStandardTabSelection(preferWw ? "wysiwyg" : "markdown");
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanupLegacyDetailsArtifacts(markdown: string): string {
	const placeholderPattern = new RegExp(
		`<${DETAILS_PLACEHOLDER_TAG}\\b[^>]*>(?:\\s|&nbsp;)*<\\/${DETAILS_PLACEHOLDER_TAG}>`,
		"gi",
	);
	const selfClosingPattern = new RegExp(
		`<${DETAILS_PLACEHOLDER_TAG}\\b[^>]*/>`,
		"gi",
	);
	const legacyTokenPattern = new RegExp(
		`^\\s*${escapeRegex("DETAILSBLOCKTOKEN")}\\d+X\\d+END\\s*$`,
		"gim",
	);
	return markdown
		.replace(placeholderPattern, "")
		.replace(selfClosingPattern, "")
		.replace(legacyTokenPattern, "");
}

function getEditorMarkdownNormalized(): string {
	if (!editor) return "";
	return normalizeEditorUploadImageUrls(
		cleanupLegacyDetailsArtifacts(editor.getMarkdown()),
	);
}

async function sanitizeDataImagesInEditorIfNeeded() {
	if (!editor || isSanitizingDataImageMarkdown) return;
	const markdown = editor.getMarkdown();
	if (!containsEmbeddedDataImage(markdown)) {
		return;
	}
	isSanitizingDataImageMarkdown = true;
	statusText = "检测到内嵌图片，正在转存...";
	try {
		const normalized = cleanupLegacyDetailsArtifacts(markdown);
		const replaced =
			await replaceEmbeddedDataImagesWithUploadedUrls(normalized);
		if (editor && replaced !== markdown) {
			editor.setMarkdown(replaced);
			statusText = "已自动转存内嵌图片";
			showNotice("已将 data:image 自动转存为已上传图片", "success");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "内嵌图片转存失败";
		statusText = "内嵌图片转存失败";
		showNotice(message, "error");
	} finally {
		isSanitizingDataImageMarkdown = false;
	}
}

function scheduleDataImageSanitize() {
	if (dataImageSanitizeTimer) {
		clearTimeout(dataImageSanitizeTimer);
		dataImageSanitizeTimer = null;
	}
	dataImageSanitizeTimer = setTimeout(() => {
		dataImageSanitizeTimer = null;
		void sanitizeDataImagesInEditorIfNeeded();
	}, DATA_IMAGE_SANITIZE_DEBOUNCE_MS);
}

function getEditorHeight(): string {
	if (typeof window === "undefined") {
		return `${EDITOR_MIN_HEIGHT}px`;
	}
	const scaled = Math.round(window.innerHeight * EDITOR_HEIGHT_RATIO);
	const fixed = Math.min(
		EDITOR_MAX_HEIGHT,
		Math.max(EDITOR_MIN_HEIGHT, scaled),
	);
	return `${fixed}px`;
}

function cleanupStaleDetailsInMarkdownPreview() {
	if (!editorHost || !editor) return;
	const markdown = editor.getMarkdown();
	if (/<details[\s>]/i.test(markdown) || /<summary[\s>]/i.test(markdown)) {
		return;
	}
	const preview = editorHost.querySelector<HTMLElement>(
		".toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents",
	);
	if (!preview) return;
	const staleDetails = preview.querySelectorAll("details");
	for (const node of staleDetails) {
		node.remove();
	}
}

function normalizeCodeLanguageLabel(raw: string): string {
	const normalized = raw.trim().toLowerCase();
	return normalized;
}

function extractPreviewCodeLanguageFromDom(pre: HTMLElement): string {
	const existing = pre.getAttribute("data-language") || "";
	if (existing.trim() && normalizeCodeLanguageLabel(existing) !== "text") {
		return normalizeCodeLanguageLabel(existing);
	}
	const code = pre.querySelector("code");
	if (!code) return "";
	for (const className of Array.from(code.classList)) {
		if (className.startsWith("language-")) {
			return normalizeCodeLanguageLabel(className.slice("language-".length));
		}
		if (className.startsWith("lang-")) {
			return normalizeCodeLanguageLabel(className.slice("lang-".length));
		}
	}
	return "";
}

function extractCodeFenceLanguagesFromMarkdown(markdown: string): string[] {
	const lines = markdown.split(/\r?\n/);
	const languages: string[] = [];
	let inFence = false;
	let fenceMarker = "";
	for (const lineRaw of lines) {
		const line = lineRaw.trim();
		const fenceStart = line.match(/^(```+|~~~+)\s*([^\s`]*)?.*$/);
		if (!inFence) {
			if (!fenceStart) continue;
			inFence = true;
			fenceMarker = fenceStart[1] || "```";
			const rawLang = fenceStart[2] || "";
			const lang = normalizeCodeLanguageLabel(rawLang);
			if (lang && lang !== "text") {
				languages.push(lang);
			} else {
				languages.push("");
			}
			continue;
		}
		const closingPattern = new RegExp(`^${fenceMarker}\\s*$`);
		if (closingPattern.test(line)) {
			inFence = false;
			fenceMarker = "";
		}
	}
	return languages;
}

function queryRenderableCodeBlocks(host: HTMLElement): HTMLElement[] {
	return Array.from(
		host.querySelectorAll<HTMLElement>(
			[
				".toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents pre",
				".toastui-editor-ww-container .toastui-editor-contents pre",
			].join(","),
		),
	);
}

function ensureCodeCopyButton(pre: HTMLElement): void {
	const code = pre.querySelector("code");
	const hasContent = Boolean(code?.textContent?.trim());
	const existingButton = pre.querySelector(`.${CODE_COPY_BUTTON_CLASS}`);
	if (!code || !hasContent) {
		if (existingButton instanceof HTMLButtonElement) {
			existingButton.remove();
		}
		pre.classList.remove(CODE_COPY_BLOCK_CLASS);
		return;
	}
	pre.classList.add(CODE_COPY_BLOCK_CLASS);
	if (existingButton) return;
	const button = document.createElement("button");
	button.type = "button";
	button.className = CODE_COPY_BUTTON_CLASS;
	button.innerHTML = `<span class="copy-icon">${CODE_COPY_ICON_SVG}</span><span class="check-icon">${CODE_CHECK_ICON_SVG}</span>`;
	button.setAttribute("aria-label", "复制代码");
	button.title = "复制代码";
	button.dataset.copyState = "";
	pre.appendChild(button);
}

function syncCodeBlockCopyButtons(): void {
	if (!editorHost) return;
	const blocks = queryRenderableCodeBlocks(editorHost);
	for (const block of blocks) {
		ensureCodeCopyButton(block);
	}
}

function setCodeCopyButtonFeedback(
	button: HTMLButtonElement,
	mode: "success" | "error",
): void {
	button.dataset.copyState = mode;
	button.setAttribute("aria-label", mode === "success" ? "已复制" : "复制失败");
	button.title = mode === "success" ? "已复制" : "复制失败";
	const oldTimer = button.dataset.copyTimerId;
	if (oldTimer) {
		window.clearTimeout(Number(oldTimer));
	}
	const timer = window.setTimeout(() => {
		button.dataset.copyState = "";
		button.setAttribute("aria-label", "复制代码");
		button.title = "复制代码";
		button.dataset.copyTimerId = "";
	}, CODE_COPY_RESET_DELAY_MS);
	button.dataset.copyTimerId = String(timer);
}

async function handleCodeCopyButtonClick(
	button: HTMLButtonElement,
): Promise<void> {
	const block = button.closest("pre");
	if (!(block instanceof HTMLElement)) return;
	const code = block.querySelector("code");
	const codeText = code?.textContent || "";
	if (!codeText.trim()) {
		setCodeCopyButtonFeedback(button, "error");
		return;
	}
	const copyTextWithFallback = async (text: string): Promise<boolean> => {
		if (
			typeof navigator !== "undefined" &&
			navigator.clipboard &&
			typeof navigator.clipboard.writeText === "function"
		) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch {
				// fallback below
			}
		}
		try {
			const temp = document.createElement("textarea");
			temp.value = text;
			temp.setAttribute("readonly", "true");
			temp.style.position = "fixed";
			temp.style.top = "-9999px";
			temp.style.left = "-9999px";
			document.body.appendChild(temp);
			temp.focus();
			temp.select();
			const ok = document.execCommand("copy");
			temp.remove();
			return ok;
		} catch {
			return false;
		}
	};
	const copied = await copyTextWithFallback(codeText);
	setCodeCopyButtonFeedback(button, copied ? "success" : "error");
}

function bindCodeBlockCopyActions(host: HTMLElement): () => void {
	const handleClickCapture = (event: MouseEvent) => {
		const target = event.target;
		if (!(target instanceof Element)) return;
		const button = target.closest(`button.${CODE_COPY_BUTTON_CLASS}`);
		if (!(button instanceof HTMLButtonElement) || !host.contains(button))
			return;
		event.preventDefault();
		event.stopPropagation();
		void handleCodeCopyButtonClick(button);
	};

	host.addEventListener("click", handleClickCapture, true);
	return () => {
		host.removeEventListener("click", handleClickCapture, true);
	};
}

function syncMarkdownPreviewCodeLanguageBadges() {
	if (!editorHost) return;
	const preview = editorHost.querySelector<HTMLElement>(
		".toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents",
	);
	if (!preview) return;
	const blocks = Array.from(preview.querySelectorAll<HTMLElement>("pre"));
	const markdown = editor?.getMarkdown() || "";
	const fenceLanguages = extractCodeFenceLanguagesFromMarkdown(markdown);
	let fenceIndex = 0;
	for (const block of blocks) {
		const domLang = extractPreviewCodeLanguageFromDom(block);
		let language = domLang;
		if (!language) {
			if (!block.classList.contains("toastui-editor-md-preview-highlight")) {
				language = fenceLanguages[fenceIndex] || "";
				fenceIndex += 1;
			} else {
				const prevLanguage =
					block.previousElementSibling instanceof HTMLElement
						? block.previousElementSibling.getAttribute("data-language") || ""
						: "";
				const nextLanguage =
					block.nextElementSibling instanceof HTMLElement
						? block.nextElementSibling.getAttribute("data-language") || ""
						: "";
				language = prevLanguage || nextLanguage;
			}
		}
		if (language) {
			block.setAttribute("data-language", language);
		} else {
			block.removeAttribute("data-language");
		}
	}
	syncCodeBlockCopyButtons();
}

function syncMarkdownPreviewCodeLanguageBadgesSoon() {
	window.requestAnimationFrame(() => {
		syncMarkdownPreviewCodeLanguageBadges();
		window.setTimeout(() => {
			syncMarkdownPreviewCodeLanguageBadges();
		}, 0);
		window.setTimeout(() => {
			syncMarkdownPreviewCodeLanguageBadges();
		}, 80);
	});
}

async function publishPost() {
	if (isSubmitting) return;
	if (!editor) {
		showNotice("编辑器还没加载完成，请稍等", "error");
		return;
	}
	if (!getDeveloperModeEnabled()) {
		showNotice("开发者模式未解锁", "error");
		return;
	}
	const devCodeHash = getStoredDevCredentialValue();
	if (!devCodeHash) {
		showNotice("缺少开发者口令，请重新解锁开发者模式", "error");
		return;
	}
	const content = getEditorMarkdownNormalized().trim();
	if (mode === "post" && !title.trim()) {
		showNotice("标题不能为空", "error");
		return;
	}
	if (!content) {
		showNotice("正文不能为空", "error");
		return;
	}
	if (containsEmbeddedDataImage(content)) {
		showNotice("正文仍包含 data:image，正在转存，请稍后再发布", "error");
		await sanitizeDataImagesInEditorIfNeeded();
		return;
	}
	isSubmitting = true;
	statusText = "正在发布...";
	try {
		const response = await fetch("/api/dev/publish", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				type: mode,
				title,
				slug,
				originalSlug,
				description,
				tags,
				category,
				image,
				draft,
				content,
				published,
				devCodeHash,
			}),
		});

		const result = (await response.json().catch(() => ({}))) as {
			ok?: boolean;
			message?: string;
			path?: string;
			commitUrl?: string;
			deployed?: boolean;
		};
		if (!response.ok || !result.ok) {
			throw new Error(result.message || "发布失败");
		}
		statusText = "发布成功，等待部署";
		dirty = false;
		if (activeDraftId) {
			removeDraft(activeDraftId);
			activeDraftId = "";
		}
		showNotice(`发布成功：${result.path || "新文章"}`, "success");
		setTimeout(() => {
			window.location.href = "/";
		}, 900);
	} catch (error) {
		const message = error instanceof Error ? error.message : "发布失败";
		statusText = "发布失败";
		showNotice(message, "error");
	} finally {
		isSubmitting = false;
	}
}

$: if (title && !userTouchedSlug && !originalSlug) {
	slug = slugify(title);
}

$: localSlugConflictMessage = getLocalSlugConflictMessage();

// 模式或滑块容器变化后，等 DOM 刷新再定位指示条
$: if (modeSwitchElement) {
	mode;
	void tick().then(updateModeSwitchIndicator);
}

onMount(() => {
	let disposed = false;
	let editorInitializing = false;
	let unbindEditorFocusTracking: (() => void) | null = null;
	void tick().then(updateModeSwitchIndicator);
	let unbindLinkPopupUrlNormalization: (() => void) | null = null;
	let unbindEditorLinkTooltip: (() => void) | null = null;
	let unbindEditorImagePreview: (() => void) | null = null;
	let unbindEditorImageCaptions: (() => void) | null = null;
	let unbindEditorSaveShortcut: (() => void) | null = null;
	let unbindEditorContextMenu: (() => void) | null = null;
	let unbindToolbarInlineMarkCoexistence: (() => void) | null = null;
	let unbindCodeBlockCopyActions: (() => void) | null = null;
	let unbindTaskToolbarBubble: (() => void) | null = null;
	markdownOnlyMode = readMarkdownOnlyModePreference();
	isAppleDevice = detectAppleDevice();
	const handleWindowResize = () => {
		editor?.setHeight?.(getEditorHeight());
		syncToolbarSvgIconsSoon();
	};
	const handleEditorFocusIn = () => {
		editorFocused = true;
	};
	const handleEditorFocusOut = () => {
		window.requestAnimationFrame(() => {
			if (!editorHost) {
				editorFocused = false;
				return;
			}
			editorFocused = editorHost.contains(document.activeElement);
		});
	};

	const teardownEditorRuntime = () => {
		if (unbindEditorFocusTracking) {
			unbindEditorFocusTracking();
			unbindEditorFocusTracking = null;
		}
		if (unbindLinkPopupUrlNormalization) {
			unbindLinkPopupUrlNormalization();
			unbindLinkPopupUrlNormalization = null;
		}
		if (unbindEditorLinkTooltip) {
			unbindEditorLinkTooltip();
			unbindEditorLinkTooltip = null;
		}
		if (unbindEditorImagePreview) {
			unbindEditorImagePreview();
			unbindEditorImagePreview = null;
		}
		if (unbindEditorImageCaptions) {
			unbindEditorImageCaptions();
			unbindEditorImageCaptions = null;
		}
		if (unbindEditorSaveShortcut) {
			unbindEditorSaveShortcut();
			unbindEditorSaveShortcut = null;
		}
		if (unbindEditorContextMenu) {
			unbindEditorContextMenu();
			unbindEditorContextMenu = null;
		}
		if (unbindToolbarInlineMarkCoexistence) {
			unbindToolbarInlineMarkCoexistence();
			unbindToolbarInlineMarkCoexistence = null;
		}
		if (unbindCodeBlockCopyActions) {
			unbindCodeBlockCopyActions();
			unbindCodeBlockCopyActions = null;
		}
		if (unbindTaskToolbarBubble) {
			unbindTaskToolbarBubble();
			unbindTaskToolbarBubble = null;
		}
		hideTaskToolbarBubble();
		if (dataImageSanitizeTimer) {
			clearTimeout(dataImageSanitizeTimer);
			dataImageSanitizeTimer = null;
		}
		stopToolbarIconObserver();
		editorFocused = false;
		closeImagePreview();
		closeLinkConfirmDialog();
		if (autoSaveTimer) {
			clearInterval(autoSaveTimer);
			autoSaveTimer = null;
		}
		if (editor) {
			editor.destroy();
			editor = null;
		}
	};

	const initEditor = async () => {
		if (disposed || isLocked || editor || editorInitializing) {
			return;
		}
		editorInitializing = true;
		try {
			clearDeveloperModeAutoLock();
			migrateLegacyDraft();
			await tick();
			if (disposed || isLocked) {
				return;
			}
			if (!editorHost) {
				editorInitError = "编辑器容器加载失败";
				statusText = "编辑器加载失败";
				showNotice(editorInitError, "error");
				return;
			}

			const hostForFocusTracking = editorHost;
			hostForFocusTracking.addEventListener("focusin", handleEditorFocusIn);
			hostForFocusTracking.addEventListener("focusout", handleEditorFocusOut);
			unbindEditorFocusTracking = () => {
				hostForFocusTracking.removeEventListener(
					"focusin",
					handleEditorFocusIn,
				);
				hostForFocusTracking.removeEventListener(
					"focusout",
					handleEditorFocusOut,
				);
			};

			try {
				if (disposed || isLocked || editorHost !== hostForFocusTracking) {
					return;
				}
				editor = new ToastUiEditor({
					el: hostForFocusTracking,
					height: getEditorHeight(),
					initialEditType: "markdown",
					previewStyle: "vertical",
					language: "zh-CN",
					usageStatistics: false,
					useCommandShortcut: false,
					placeholder: "在这里写下你的文章...",
					linkAttributes: {
						target: "_blank",
						rel: "noopener noreferrer",
					},
					customHTMLRenderer: CUSTOM_DETAILS_HTML_RENDERER,
					toolbarItems: [
						["heading", "bold", "italic", "strike"],
						["hr", "quote"],
						["ul", "ol", "task", "indent", "outdent"],
						["table", "link", "image"],
						["code", "codeblock"],
					],
					hooks: {
						addImageBlobHook: async (blob: Blob, callback: unknown) => {
							if (typeof callback !== "function") return false;
							const fileName = getImagePreviewFileName(blob);
							statusText = "图片后台上传中...";
							pendingImageUploads += 1;
							void (async () => {
								try {
									const uploaded = await uploadEditorImage(blob);
									insertUploadedImage(
										callback as ToastImageHookCallback,
										uploaded.url,
									);
									showNotice(`图片已上传：${fileName}`, "success");
								} catch (error) {
									const message =
										error instanceof Error ? error.message : "图片上传失败";
									showNotice(`后台上传失败：${message}`, "error");
									statusText = "图片后台上传失败";
								} finally {
									pendingImageUploads = Math.max(0, pendingImageUploads - 1);
									if (pendingImageUploads === 0) {
										statusText = "编辑中...";
									}
								}
							})();
							return false;
						},
					},
				}) as EditorInstance;
				unbindLinkPopupUrlNormalization =
					bindLinkPopupUrlNormalization(hostForFocusTracking);
				unbindEditorLinkTooltip = bindEditorLinkTooltip(hostForFocusTracking);
				unbindEditorImagePreview = bindEditorImagePreview(hostForFocusTracking);
				unbindEditorImageCaptions = bindEditorImageCaptions(hostForFocusTracking);
				unbindEditorSaveShortcut = bindEditorSaveShortcut(hostForFocusTracking);
				unbindEditorContextMenu = bindEditorContextMenu(hostForFocusTracking);
				unbindToolbarInlineMarkCoexistence =
					bindToolbarInlineMarkCoexistence(hostForFocusTracking);
				unbindCodeBlockCopyActions =
					bindCodeBlockCopyActions(hostForFocusTracking);
				unbindTaskToolbarBubble = bindTaskToolbarBubble(hostForFocusTracking);
				if (markdownOnlyMode) {
					editor.changeMode?.("markdown", true);
				}
				editorInitError = "";
				statusText = "编辑器已就绪";
				window.requestAnimationFrame(() => {
					localizeModeSwitchLabels();
					applyToolbarSvgIcons();
				});
				window.setTimeout(() => {
					applyToolbarSvgIcons();
				}, 0);
				window.setTimeout(() => {
					applyToolbarSvgIcons();
				}, 60);
				startToolbarIconObserver();
				tryLoadDraft();
				syncMarkdownPreviewCodeLanguageBadgesSoon();
				editor.on("change", () => {
					scheduleDataImageSanitize();
					markDirty();
					syncMarkdownPreviewCodeLanguageBadgesSoon();
					window.requestAnimationFrame(() => {
						cleanupStaleDetailsInMarkdownPreview();
					});
				});

				autoSaveTimer = setInterval(() => {
					if (dirty) {
						persistDraft(true);
					}
				}, AUTO_SAVE_INTERVAL);
			} catch (error) {
				editorInitError =
					error instanceof Error ? error.message : "编辑器初始化失败";
				statusText = "编辑器初始化失败";
				showNotice(editorInitError, "error");
				teardownEditorRuntime();
			}
		} finally {
			editorInitializing = false;
		}
	};

	const applyDeveloperModeState = async (enabled: boolean) => {
		const nextLocked = !enabled;
		if (nextLocked === isLocked) {
			return;
		}
		isLocked = nextLocked;
		if (nextLocked) {
			statusText = "等待输入";
			editorInitError = "";
			teardownEditorRuntime();
			return;
		}
		await initEditor();
	};

	const handleDeveloperModeChange = (event: Event) => {
		const enabled = Boolean((event as CustomEvent<boolean>).detail);
		void applyDeveloperModeState(enabled);
	};

	const syncDeveloperModeState = () => {
		void applyDeveloperModeState(getDeveloperModeEnabled());
	};

	window.addEventListener(
		"developer-mode-change",
		handleDeveloperModeChange as EventListener,
	);
	window.addEventListener("resize", handleWindowResize);
	window.addEventListener("focus", syncDeveloperModeState);
	document.addEventListener("visibilitychange", syncDeveloperModeState);

	const init = async () => {
		isLocked = !getDeveloperModeEnabled();
		if (isLocked) {
			return;
		}
		await initEditor();
	};

	void init();

	return () => {
		disposed = true;
		modeSwitchDragging = false;
		window.removeEventListener("pointermove", handleModeSwitchPointerMove);
		window.removeEventListener("pointerup", handleModeSwitchPointerUp);
		window.removeEventListener(
			"developer-mode-change",
			handleDeveloperModeChange as EventListener,
		);
		window.removeEventListener("resize", handleWindowResize);
		window.removeEventListener("focus", syncDeveloperModeState);
		document.removeEventListener("visibilitychange", syncDeveloperModeState);
		teardownEditorRuntime();
		armDeveloperModeAutoLock();
	};
});
</script>

<div
	class="editor-shell card-base p-4 md:p-6 rounded-[var(--radius-large)]"
	class:editor-focused={editorFocused}
	class:markdown-only={markdownOnlyMode}
>
	<div class="editor-top">
		<div>
			<div class="editor-title-row">
				<div
					class="mode-switch"
					role="tablist"
					aria-label="编辑器模式"
					bind:this={modeSwitchElement}
					on:pointerdown={handleModeSwitchPointerDown}
				>
					<div
						class="mode-switch-indicator"
						class:dragging={modeSwitchDragging}
						style={`transform:translateX(${modeSwitchDragging ? modeSwitchDragTranslateX : modeSwitchIndicatorTranslateX}px);width:${modeSwitchIndicatorWidth}px;`}
					></div>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "post"}
						class:active={mode === "post"}
						on:click={() => switchEditorMode("post")}
					>
						文章
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "thought"}
						class:active={mode === "thought"}
						on:click={() => switchEditorMode("thought")}
					>
						随笔
					</button>
				</div>
				<h1 class="text-xl font-bold text-[var(--btn-content)]">
					{mode === "thought" ? "随笔编辑器" : "文章编辑器"}
				</h1>
			</div>
			<p class="text-sm text-neutral-400 mt-1">
				{mode === "thought"
					? "随笔：标题可选，支持完整 Markdown，自动保存草稿"
					: "支持完整 Markdown，自动保存草稿"}
			</p>
		</div>
		<div class="top-actions">
			<a class="drafts-btn" href="/drafts" data-no-swup>草稿箱</a>
			{#if !isLocked}
				<button class="submit-btn" on:click={publishPost} disabled={isSubmitting}>
					{isSubmitting ? "提交中..." : "提交发布"}
				</button>
			{/if}
		</div>
	</div>

	{#if isLocked}
		<div class="locked-tip">开发者模式未开启，请在背景设置面板输入口令并回车解锁。</div>
	{:else}
		<div class="meta-grid">
			<input class="meta-input" type="text" placeholder="标题" bind:value={title} on:input={markDirty} />
			<div class="meta-field">
				<input
					class="meta-input"
					type="text"
					placeholder="Slug（留空自动生成）"
					bind:value={slug}
					on:input={() => {
						userTouchedSlug = true;
						markDirty();
					}}
				/>
				{#if localSlugConflictMessage}
					<div class="meta-warning">{localSlugConflictMessage}</div>
				{/if}
			</div>
			<input class="meta-input" type="text" placeholder="描述" bind:value={description} on:input={markDirty} />
			{#if mode === "post"}
				<input class="meta-input" type="text" placeholder="标签（逗号分隔）" bind:value={tags} on:input={markDirty} />
				<input class="meta-input" type="text" placeholder="分类（可选）" bind:value={category} on:input={markDirty} />
				<div class="cover-field">
					<input class="meta-input" type="text" placeholder="封面图 URL 或上传（可选）" bind:value={image} on:input={markDirty} />
					<button
						class="cover-upload-btn"
						type="button"
						disabled={coverUploadBusy}
						on:click={triggerCoverUpload}
					>
						{coverUploadBusy ? "上传中..." : "上传封面"}
					</button>
					<input
						bind:this={coverFileInputElement}
						class="cover-file-input"
						type="file"
						accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
						on:change={handleCoverFileChange}
					/>
				</div>
			{/if}
		</div>
		{#if mode === "post"}
			<div class="editor-options">
				<label class="draft-toggle">
					<input type="checkbox" bind:checked={draft} on:change={markDirty} />
					<span>设为草稿（不会在首页展示）</span>
				</label>
			</div>
		{/if}
		<div class="editor-workspace" bind:this={editorWorkspaceElement}>
			<div bind:this={editorHost} class="editor-host">
				{#if !editor && !editorInitError}
					<div class="editor-loading" aria-label="编辑器加载中"></div>
				{/if}
				{#if !editor && editorInitError}
					<div class="editor-error">{editorInitError}</div>
				{/if}
			</div>
			{#if taskBubbleVisible}
				<div
					bind:this={taskBubbleElement}
					class="task-toolbar-bubble"
					style={`left:${taskBubbleAnchorX}px;top:${taskBubbleAnchorY}px;`}
					in:scale={{ duration: 180, easing: cubicOut, start: 0.9 }}
					out:fade={{ duration: 160 }}
					on:mouseenter={handleTaskBubblePointerEnter}
					on:mouseleave={handleTaskBubblePointerLeave}
				>
					<div
						class="task-toolbar-bubble-actions"
						class:selected-left={taskBubbleSelected}
						class:selected-right={!taskBubbleSelected}
					>
						<button
							type="button"
							class="task-bubble-choice"
							class:is-active={taskBubbleSelected}
							on:click={() => insertTaskFromBubble(true)}
						>
							已选择
						</button>
						<button
							type="button"
							class="task-bubble-choice"
							class:is-active={!taskBubbleSelected}
							on:click={() => insertTaskFromBubble(false)}
						>
							未选择
						</button>
					</div>
				</div>
			{/if}
			{#if imagePreviewVisible && imagePreviewSrc}
				<div
					class="image-preview-overlay"
					role="dialog"
					aria-modal="true"
					aria-label="图片预览"
					tabindex="-1"
					on:click={handleImagePreviewOverlayClick}
					on:keydown={handleImagePreviewOverlayKeydown}
					on:wheel={handleImagePreviewWheel}
				>
					<button
						class="image-preview-close-global"
						type="button"
						aria-label="关闭图片预览"
						on:click={closeImagePreview}
					>
						×
					</button>
					<div class="image-preview-stage">
						<div class="image-preview-frame">
							<img
								class="image-preview-image"
								src={imagePreviewSrc}
								alt={imagePreviewAlt || "图片预览"}
								style={`transform: scale(${imagePreviewScale});`}
								draggable="false"
							/>
						</div>
					</div>
				</div>
			{/if}
		</div>
		{#if contextMenuVisible}
			<div
				bind:this={contextMenuElement}
				class="editor-context-menu"
				style={`left: ${contextMenuX}px; top: ${contextMenuY}px;`}
				role="menu"
				aria-label="编辑器右键菜单"
				on:mousedown|preventDefault
				on:contextmenu|preventDefault
			>
				{#if contextMenuType === "text"}
					<button type="button" class="context-menu-item" on:click={() => handleTextContextMenuAction("copy")}>
						<span class="context-menu-item-label">复制</span>
						<span class="context-menu-shortcut">
							<svg class="shortcut-icon" viewBox="0 0 16 16" aria-hidden="true">
								<path d="M2.5 3.5h7a1 1 0 0 1 1 1v8h-8a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Zm3-2h7a1 1 0 0 1 1 1v8h-1.5V4a1 1 0 0 0-1-1H4.5V2.5a1 1 0 0 1 1-1Z" />
							</svg>
							{isAppleDevice ? "⌘C" : "Ctrl+C"}
						</span>
					</button>
					<button type="button" class="context-menu-item" on:click={() => handleTextContextMenuAction("paste")}>
						<span class="context-menu-item-label">粘贴</span>
						<span class="context-menu-shortcut">
							<svg class="shortcut-icon" viewBox="0 0 16 16" aria-hidden="true">
								<path d="M6 1.5h4a1 1 0 0 1 1 1V3h1.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1H5v-.5a1 1 0 0 1 1-1Zm.5 2.5h3V3h-3v1Zm-2.5.5v8h8v-8H4Z" />
							</svg>
							{isAppleDevice ? "⌘V" : "Ctrl+V"}
						</span>
					</button>
					<button type="button" class="context-menu-item" on:click={() => runEditorCommand("bold")}>
						{getContextMenuCommandLabel("bold")}
					</button>
					<button type="button" class="context-menu-item" on:click={() => runEditorCommand("italic")}>
						{getContextMenuCommandLabel("italic")}
					</button>
					<button type="button" class="context-menu-item" on:click={() => runEditorCommand("strike")}>
						{getContextMenuCommandLabel("strike")}
					</button>
					<button type="button" class="context-menu-item" on:click={() => runEditorCommand("code")}>
						{getContextMenuCommandLabel("code")}
					</button>
					<button type="button" class="context-menu-item" on:click={() => runEditorCommand("codeBlock")}>
						{getContextMenuCommandLabel("codeBlock")}
					</button>
				{:else}
					<div class="context-menu-label">{contextMenuImageAlt || "图片操作"}</div>
					<button type="button" class="context-menu-item" on:click={() => handleImageContextMenuAction("preview")}>
						预览图片
					</button>
					<button type="button" class="context-menu-item" on:click={() => handleImageContextMenuAction("copy")}>
						复制图片地址
					</button>
					<button type="button" class="context-menu-item" on:click={() => handleImageContextMenuAction("edit")}>
						调整大小
					</button>
					<button type="button" class="context-menu-item" on:click={() => handleImageContextMenuAction("editCaption")}>
						编辑下方说明
					</button>
					<button type="button" class="context-menu-item" on:click={() => handleImageContextMenuAction("delete")}>
						删除图片引用
					</button>
					<button type="button" class="context-menu-item danger" on:click={() => handleImageContextMenuAction("deleteFile")}>
						彻底删除图片文件
					</button>
				{/if}
			</div>
		{/if}
		{#if imageEditVisible && imageEditSrc}
			<div
				class="image-edit-overlay"
				role="dialog"
				aria-modal="true"
				aria-label="图片编辑"
				transition:fade={{ duration: 160 }}
			>
				<div class="image-edit-panel" transition:scale={{ duration: 190, easing: cubicOut, start: 0.96 }}>
					<div class="image-edit-header">
						<div class="image-edit-title">图片编辑</div>
						<button class="image-edit-close" type="button" on:click={closeImageEditDialog}>×</button>
					</div>
					<div class="image-edit-body">
						<div
							class="image-edit-stage"
							bind:this={imageEditStageElement}
							on:wheel|preventDefault|stopPropagation={handleImageEditWheel}
						>
							<img
								bind:this={imageEditPreviewImageElement}
								class="image-edit-preview-image"
								src={imageEditSrc}
								alt={imageEditAlt || "图片编辑预览"}
								style={`transform:translate(${imageEditPanX}px,${imageEditPanY}px) scale(${imageEditZoom});`}
								draggable="false"
								on:load={handleImageEditImageLoad}
								on:wheel|preventDefault={handleImageEditWheel}
								on:pointerdown={handleImageEditPointerDown}
								on:pointermove={handleImageEditPointerMove}
								on:pointerup={handleImageEditPointerUp}
								on:pointercancel={handleImageEditPointerUp}
							/>
							{#if imageEditCropEnabled}
								<div
									class="image-edit-crop-box"
									style={`left:${imageEditCropX + imageEditPreviewOffsetX}px;top:${imageEditCropY + imageEditPreviewOffsetY}px;width:${imageEditCropWidth}px;height:${imageEditCropHeight}px;`}
									on:pointerdown={handleImageEditCropBoxPointerDown}
									on:wheel|preventDefault|stopPropagation={handleImageEditWheel}
									on:pointermove={handleImageEditResizePointerMove}
									on:pointerup={handleImageEditResizePointerUp}
									on:pointercancel={handleImageEditResizePointerUp}
								>
									<span class="image-edit-crop-handle nw" on:pointerdown={(event) => handleImageEditResizeHandlePointerDown("nw", event)}></span>
									<span class="image-edit-crop-handle n" on:pointerdown={(event) => handleImageEditResizeHandlePointerDown("n", event)}></span>
									<span class="image-edit-crop-handle ne" on:pointerdown={(event) => handleImageEditResizeHandlePointerDown("ne", event)}></span>
									<span class="image-edit-crop-handle e" on:pointerdown={(event) => handleImageEditResizeHandlePointerDown("e", event)}></span>
									<span class="image-edit-crop-handle se" on:pointerdown={(event) => handleImageEditResizeHandlePointerDown("se", event)}></span>
									<span class="image-edit-crop-handle s" on:pointerdown={(event) => handleImageEditResizeHandlePointerDown("s", event)}></span>
									<span class="image-edit-crop-handle sw" on:pointerdown={(event) => handleImageEditResizeHandlePointerDown("sw", event)}></span>
									<span class="image-edit-crop-handle w" on:pointerdown={(event) => handleImageEditResizeHandlePointerDown("w", event)}></span>
								</div>
							{/if}
						</div>
						<div class="image-edit-controls">
							<div class="image-edit-tip">
								滚轮缩放：{Math.round(imageEditZoom * 100)}% · 拖拽框选裁切区域
								{#if imageEditLockSquare} · 大图已自动启用 1:1 选框{/if}
							</div>
							<div class="image-edit-rect-grid">
								<label class="image-edit-field">
									<span>宽(px)</span>
									<input
										class="image-edit-input"
										type="number"
										min="1"
										bind:value={imageEditSourceWidth}
										on:input={applyImageEditSourceRect}
									/>
								</label>
								<label class="image-edit-field">
									<span>高(px)</span>
									<input
										class="image-edit-input"
										type="number"
										min="1"
										bind:value={imageEditSourceHeight}
										on:input={applyImageEditSourceRect}
									/>
								</label>
								<label class="image-edit-field">
									<span>X</span>
									<input
										class="image-edit-input"
										type="number"
										min="0"
										bind:value={imageEditSourceX}
										on:input={applyImageEditSourceRect}
									/>
								</label>
								<label class="image-edit-field">
									<span>Y</span>
									<input
										class="image-edit-input"
										type="number"
										min="0"
										bind:value={imageEditSourceY}
										on:input={applyImageEditSourceRect}
									/>
								</label>
							</div>
							<div class="image-edit-actions">
								<button type="button" class="image-edit-btn secondary" on:click={applyImageEditSourceRect}>指定尺寸</button>
								<button type="button" class="image-edit-btn secondary" on:click={clearImageCropSelection}>清除裁切框</button>
								<button type="button" class="image-edit-btn secondary" on:click={closeImageEditDialog}>取消</button>
								<button type="button" class="image-edit-btn primary" on:click={applyImageEditChanges}>应用修改</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		{/if}
		{#if captionEditVisible && captionEditSrc}
			<div
				class="image-edit-overlay"
				role="dialog"
				aria-modal="true"
				aria-label="编辑下方说明"
				transition:fade={{ duration: 160 }}
			>
				<div class="caption-edit-panel" transition:scale={{ duration: 190, easing: cubicOut, start: 0.96 }}>
					<div class="image-edit-header">
						<div class="image-edit-title">编辑下方说明</div>
						<button class="image-edit-close" type="button" on:click={closeImageCaptionDialog}>×</button>
					</div>
					<div class="image-edit-body">
						<img
							class="caption-edit-preview"
							src={captionEditSrc}
							alt="图片预览"
							draggable="false"
						/>
						<div class="image-edit-controls">
							<label class="image-edit-caption-row">
								<span class="image-edit-caption-label">下方说明</span>
								<input
									class="image-edit-input image-edit-caption-input"
									type="text"
									placeholder="可选，填了会显示在图片正下方"
									bind:value={captionEditValue}
									on:keydown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											applyImageCaptionDialog();
										}
									}}
								/>
							</label>
							<div class="image-edit-actions">
								<button type="button" class="image-edit-btn secondary" on:click={closeImageCaptionDialog}>取消</button>
								<button type="button" class="image-edit-btn primary" on:click={applyImageCaptionDialog}>应用</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		{/if}
		<div class="editor-foot">
			<div class="status-wrap">
				<span>{statusText}</span>
				{#if showLoadDraftPrompt}
					<div class="load-draft-prompt">
						<span class="load-draft-text">是否加载草稿</span>
						<button class="draft-choice-btn" type="button" on:click={loadPendingDraft}>加载</button>
						<button class="draft-choice-btn secondary" type="button" on:click={skipPendingDraft}>跳过</button>
					</div>
				{/if}
			</div>
			<div class="foot-actions">
				<input
					bind:this={markdownFileInputElement}
					class="md-file-input"
					type="file"
					accept=".md,text/markdown,text/plain"
					on:change={handleMarkdownFileUpload}
				/>
				<button class="save-btn secondary" type="button" on:click={triggerMarkdownImport} disabled={!editor || isSubmitting}>
					上传 MD
				</button>
				<button class="save-btn secondary" type="button" on:click={exportMarkdownFile} disabled={!editor}>
					导出 MD
				</button>
				<button class="save-btn" type="button" on:click={() => persistDraft()} disabled={!editor}>
					立即保存
				</button>
			</div>
		</div>
	{/if}

	{#if notice}
		<div class={`notice ${noticeType}`}>{notice}</div>
	{/if}
</div>

<DevConfirmDialog
	open={linkConfirmVisible}
	label="打开链接"
	title="检测到链接，是否继续打开？"
	description={pendingLinkText ? `链接文本：${pendingLinkText}` : "请确认是否打开该链接。"}
	note={pendingLinkUrl ? `链接地址：${pendingLinkUrl}` : ""}
	confirmLabel="打开链接"
	cancelLabel="取消"
	tone="primary"
	on:cancel={closeLinkConfirmDialog}
	on:confirm={confirmOpenEditorLink}
/>

<DevConfirmDialog
	open={imageDeleteConfirmVisible}
	label="删除图片文件"
	title="检测到图片资源，是否继续删除？"
	description={pendingDeleteImageAlt ? `图片文本：${pendingDeleteImageAlt}` : "将删除图片文件，并从正文中移除该图片引用。"}
	note={pendingDeleteImageSrc ? `图片地址：${pendingDeleteImageSrc}` : ""}
	warning={pendingDeleteImageRepoPath ? `目标路径：${pendingDeleteImageRepoPath}\n该操作会尝试删除本地文件；如果配置了 GitHub，也会同步删除仓库文件。` : "仅支持删除 /uploads/editor/ 下的已上传图片文件。"}
	confirmLabel={imageDeleteBusy ? "删除中..." : "确认删除"}
	cancelLabel="取消"
	tone="danger"
	busy={imageDeleteBusy}
	on:cancel={closeImageDeleteConfirmDialog}
	on:confirm={confirmDeleteImageFile}
/>

<style lang="stylus">
@font-face
  font-family "KeinannMaruPOP"
  src url("/fonts/KeinannMaruPOP_CN-EN.ttf") format("truetype")
  font-display swap

.editor-shell
  color var(--btn-content)
  overflow hidden
  position relative
  --editor-content-color rgba(38, 54, 55, 0.9)
  --editor-placeholder-color rgba(85, 104, 106, 0.62)
  --editor-active-content-color rgba(18, 31, 36, 0.96)
  --editor-active-placeholder-color rgba(52, 72, 74, 0.74)
  --editor-glow-color var(--primary)
  --editor-glow-shadow var(--editor-glow-color)
  --editor-toolbar-bg-a rgba(248, 251, 249, 0.94)
  --editor-toolbar-bg-b rgba(242, 247, 245, 0.94)
  --editor-toolbar-border rgba(122, 149, 144, 0.32)
  --editor-toolbar-divider rgba(122, 149, 144, 0.28)
  --editor-toolbar-btn-bg rgba(255, 255, 255, 0)
  --editor-toolbar-btn-hover rgba(255, 255, 255, 0.84)
  --editor-toolbar-btn-active rgba(214, 232, 226, 0.9)
  --editor-toolbar-btn-border rgba(120, 146, 141, 0)
  --editor-toolbar-btn-border-hover rgba(90, 134, 124, 0.38)
  --editor-toolbar-pattern-dot rgba(97, 132, 124, 0)
  --editor-toolbar-group-bg rgba(255, 255, 255, 0.58)
  --editor-toolbar-focus-ring rgba(49, 145, 120, 0.34)
  --editor-tooltip-bg rgba(255, 255, 255, 0.98)
  --editor-tooltip-text rgba(18, 31, 36, 0.96)
  --editor-tooltip-shadow rgba(15, 23, 42, 0.18)
  --editor-tooltip-border rgba(120, 146, 141, 0.35)
  --editor-paper-bg rgba(255, 255, 255, 0.9)
  --editor-paper-line rgba(141, 170, 162, 0.12)
  --editor-popup-bg rgba(247, 250, 247, 0.98)
  --editor-popup-border rgba(115, 164, 150, 0.62)
  --editor-popup-text rgba(28, 47, 52, 0.96)
  --editor-popup-text-dim rgba(66, 102, 99, 0.86)
  --editor-popup-font-family "KeinannMaruPOP", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Noto Sans SC", "Source Han Sans SC", sans-serif
  --editor-popup-input-bg rgba(234, 243, 239, 0.82)
  --editor-popup-input-border rgba(132, 178, 166, 0.55)
  --editor-popup-placeholder rgba(93, 131, 126, 0.62)
  --editor-popup-accent rgba(42, 146, 118, 0.94)
  --editor-popup-accent-soft rgba(42, 146, 118, 0.18)
  --editor-popup-cancel-bg rgba(220, 233, 228, 0.85)
  --editor-popup-tab-active-bg rgba(160, 207, 193, 0.34)
  --editor-code-fence-bg rgba(226, 238, 251, 0.98)
  --editor-code-fence-border rgba(84, 123, 170, 0.9)
  --editor-code-fence-text rgba(19, 45, 76, 0.98)
  --editor-code-fence-meta rgba(57, 98, 147, 0.98)
  --editor-code-preview-bg rgba(234, 243, 253, 0.98)
  --editor-code-preview-border rgba(120, 156, 201, 0.85)
  --editor-code-preview-text rgba(22, 45, 73, 0.98)
  --editor-link-color #000000
  --editor-link-underline-color rgba(37, 99, 235, 0.45)
  --editor-bold-bg #1f3f5a
  --editor-bold-color #9bc8f4
  --editor-highlight-bg #f2e37a
  --editor-highlight-text #111111
  --editor-code-inline-bg rgba(209, 226, 245, 0.88)
  --editor-code-inline-text rgba(39, 84, 135, 0.98)
  --editor-code-lang-bg rgba(196, 216, 240, 0.92)
  --editor-code-lang-text rgba(45, 73, 104, 0.98)
  --editor-table-picker-cell-bg rgba(255, 255, 255, 0.94)
  --editor-table-picker-cell-border rgba(186, 202, 220, 0.82)
  --editor-table-picker-cell-header-bg rgba(233, 241, 250, 0.96)
  --editor-table-picker-selection-border rgba(76, 126, 182, 0.95)
  --editor-table-picker-selection-bg rgba(96, 142, 194, 0.2)
  --editor-table-picker-text rgba(36, 54, 76, 0.95)
  --editor-table-border rgba(63, 93, 130, 0.98)
  --editor-table-header-bg rgba(115, 149, 188, 0.85)
  --editor-table-cell-bg rgba(255, 255, 255, 0.99)
  --editor-table-row-alt-bg rgba(232, 241, 252, 0.95)
  --editor-table-row-hover-bg rgba(208, 225, 246, 0.95)
  --editor-table-shadow rgba(27, 56, 93, 0.18)
  --editor-md-table-delimiter rgba(57, 101, 151, 0.98)
  --editor-md-table-text rgba(16, 35, 58, 0.98)
  --editor-scrollbar-track unquote('oklch(0.9 0.024 var(--hue) / 0.58)')
  --editor-scrollbar-thumb unquote('oklch(0.66 0.09 var(--hue) / 0.62)')
  --editor-scrollbar-thumb-hover unquote('oklch(0.6 0.11 var(--hue) / 0.8)')
  --mode-switch-bg rgba(244, 247, 252, 0.98)
  --mode-switch-border rgba(192, 206, 224, 0.88)
  --mode-switch-tab-color rgba(56, 74, 98, 0.88)
  --mode-switch-tab-active-bg var(--primary)
  --mode-switch-tab-active-color rgba(249, 255, 252, 0.98)
  --mode-switch-tab-active-border var(--primary)
  --editor-context-menu-bg unquote('color-mix(in oklab, var(--card-bg) 92%, oklch(0.35 0.03 var(--hue) / 0.16))')
  --editor-context-menu-border unquote('color-mix(in oklab, var(--primary) 46%, var(--line-color))')
  --editor-context-menu-shadow unquote('color-mix(in oklab, var(--primary) 26%, rgba(15, 23, 42, 0.22))')
  --editor-context-menu-label unquote('color-mix(in oklab, var(--btn-content) 70%, rgba(71, 85, 105, 0.92))')
  --editor-context-menu-text unquote('color-mix(in oklab, var(--btn-content) 88%, rgba(17, 24, 39, 0.95))')
  --editor-context-menu-hover unquote('color-mix(in oklab, var(--primary) 18%, transparent)')
  --editor-context-menu-focus-ring unquote('color-mix(in oklab, var(--primary) 62%, white)')
  --editor-context-menu-shortcut-text unquote('color-mix(in oklab, var(--primary) 72%, rgba(17, 24, 39, 0.92))')
  --editor-context-menu-shortcut-bg unquote('color-mix(in oklab, var(--primary) 20%, var(--btn-regular-bg))')
  --editor-context-menu-shortcut-border unquote('color-mix(in oklab, var(--primary) 44%, var(--line-color))')
  --editor-context-menu-danger unquote('oklch(0.58 0.2 24)')
  --editor-context-menu-danger-hover rgba(239, 68, 68, 0.16)

:global(html.dark) .editor-shell
  --editor-content-color rgba(210, 224, 228, 0.92)
  --editor-placeholder-color rgba(171, 191, 198, 0.58)
  --editor-active-content-color rgba(244, 250, 252, 0.98)
  --editor-active-placeholder-color rgba(206, 224, 230, 0.72)
  --editor-toolbar-bg-a rgba(23, 34, 40, 0.95)
  --editor-toolbar-bg-b rgba(27, 39, 45, 0.95)
  --editor-toolbar-border rgba(104, 134, 138, 0.42)
  --editor-toolbar-divider rgba(120, 150, 155, 0.3)
  --editor-toolbar-btn-bg rgba(28, 44, 51, 0)
  --editor-toolbar-btn-hover rgba(40, 60, 68, 0.88)
  --editor-toolbar-btn-active rgba(61, 92, 98, 0.94)
  --editor-toolbar-btn-border rgba(110, 143, 148, 0)
  --editor-toolbar-btn-border-hover rgba(122, 178, 163, 0.54)
  --editor-toolbar-pattern-dot rgba(154, 191, 183, 0)
  --editor-toolbar-group-bg rgba(18, 31, 36, 0.42)
  --editor-toolbar-focus-ring rgba(88, 197, 170, 0.34)
  --editor-tooltip-bg rgba(18, 22, 27, 0.96)
  --editor-tooltip-text rgba(248, 252, 255, 0.98)
  --editor-tooltip-shadow rgba(4, 8, 14, 0.5)
  --editor-tooltip-border rgba(124, 177, 163, 0.24)
  --editor-paper-bg rgba(20, 29, 33, 0.9)
  --editor-paper-line rgba(107, 149, 138, 0.18)
  --editor-popup-bg rgba(13, 24, 30, 0.97)
  --editor-popup-border rgba(94, 171, 149, 0.72)
  --editor-popup-text rgba(224, 243, 238, 0.96)
  --editor-popup-text-dim rgba(166, 216, 199, 0.9)
  --editor-popup-input-bg rgba(29, 47, 53, 0.72)
  --editor-popup-input-border rgba(100, 168, 148, 0.58)
  --editor-popup-placeholder rgba(143, 188, 175, 0.65)
  --editor-popup-accent rgba(75, 198, 164, 0.95)
  --editor-popup-accent-soft rgba(75, 198, 164, 0.22)
  --editor-popup-cancel-bg rgba(50, 80, 79, 0.6)
  --editor-popup-tab-active-bg rgba(64, 124, 112, 0.42)
  --editor-code-fence-bg rgba(20, 34, 49, 0.98)
  --editor-code-fence-border rgba(125, 175, 230, 0.88)
  --editor-code-fence-text rgba(224, 240, 255, 0.99)
  --editor-code-fence-meta rgba(171, 209, 247, 0.99)
  --editor-code-preview-bg rgba(16, 28, 40, 0.98)
  --editor-code-preview-border rgba(118, 168, 225, 0.66)
  --editor-code-preview-text rgba(226, 241, 255, 0.99)
  --editor-link-color #ffffff
  --editor-link-underline-color rgba(96, 165, 250, 0.5)
  --editor-bold-bg #1d3952
  --editor-bold-color #9bc8f4
  --editor-highlight-bg #f2e37a
  --editor-highlight-text #111111
  --editor-code-inline-bg rgba(47, 71, 96, 0.88)
  --editor-code-inline-text rgba(181, 219, 255, 0.99)
  --editor-code-lang-bg rgba(54, 83, 113, 0.93)
  --editor-code-lang-text rgba(216, 235, 255, 0.99)
  --editor-table-picker-cell-bg rgba(30, 42, 54, 0.92)
  --editor-table-picker-cell-border rgba(94, 122, 154, 0.62)
  --editor-table-picker-cell-header-bg rgba(38, 54, 70, 0.95)
  --editor-table-picker-selection-border rgba(129, 189, 255, 0.95)
  --editor-table-picker-selection-bg rgba(114, 171, 233, 0.32)
  --editor-table-picker-text rgba(222, 237, 255, 0.96)
  --editor-table-border rgba(182, 221, 255, 0.94)
  --editor-table-header-bg rgba(83, 123, 166, 0.92)
  --editor-table-cell-bg rgba(22, 36, 48, 0.98)
  --editor-table-row-alt-bg rgba(30, 49, 66, 0.98)
  --editor-table-row-hover-bg rgba(40, 67, 91, 0.98)
  --editor-table-shadow rgba(4, 8, 16, 0.55)
  --editor-md-table-delimiter rgba(171, 212, 255, 0.99)
  --editor-md-table-text rgba(237, 246, 255, 0.99)
  --editor-scrollbar-track unquote('oklch(0.28 0.018 var(--hue) / 0.76)')
  --editor-scrollbar-thumb unquote('oklch(0.74 0.085 var(--hue) / 0.7)')
  --editor-scrollbar-thumb-hover unquote('oklch(0.81 0.1 var(--hue) / 0.9)')
  --mode-switch-bg rgba(16, 24, 33, 0.96)
  --mode-switch-border rgba(74, 96, 122, 0.58)
  --mode-switch-tab-color rgba(178, 201, 226, 0.94)
  --mode-switch-tab-active-bg var(--primary)
  --mode-switch-tab-active-color rgba(236, 250, 246, 0.98)
  --mode-switch-tab-active-border var(--primary)
  --editor-context-menu-bg unquote('color-mix(in oklab, var(--card-bg) 90%, oklch(0.2 0.03 var(--hue) / 0.4))')
  --editor-context-menu-border unquote('color-mix(in oklab, var(--primary) 52%, rgba(148, 163, 184, 0.35))')
  --editor-context-menu-shadow unquote('color-mix(in oklab, var(--primary) 34%, rgba(2, 8, 23, 0.62))')
  --editor-context-menu-label unquote('color-mix(in oklab, var(--btn-content) 74%, rgba(226, 232, 240, 0.88))')
  --editor-context-menu-text unquote('color-mix(in oklab, var(--btn-content) 86%, rgba(248, 250, 252, 0.94))')
  --editor-context-menu-hover unquote('color-mix(in oklab, var(--primary) 24%, transparent)')
  --editor-context-menu-focus-ring unquote('color-mix(in oklab, var(--primary) 66%, rgba(186, 230, 253, 0.92))')
  --editor-context-menu-shortcut-text unquote('color-mix(in oklab, var(--primary) 74%, rgba(248, 250, 252, 0.95))')
  --editor-context-menu-shortcut-bg unquote('color-mix(in oklab, var(--primary) 24%, var(--btn-regular-bg))')
  --editor-context-menu-shortcut-border unquote('color-mix(in oklab, var(--primary) 52%, rgba(148, 163, 184, 0.45))')
  --editor-context-menu-danger unquote('oklch(0.72 0.15 24)')
  --editor-context-menu-danger-hover rgba(239, 68, 68, 0.22)

:global(:root.rainbow-mode) .editor-shell
  --editor-context-menu-border unquote('color-mix(in oklab, var(--primary) 68%, transparent)')
  --editor-context-menu-shadow unquote('color-mix(in oklab, var(--primary) 40%, rgba(2, 8, 23, 0.46))')
  --editor-context-menu-hover unquote('color-mix(in oklab, var(--primary) 28%, transparent)')
  --editor-context-menu-shortcut-bg unquote('color-mix(in oklab, var(--primary) 28%, var(--btn-regular-bg))')
  --editor-context-menu-shortcut-border unquote('color-mix(in oklab, var(--primary) 64%, var(--line-color))')

.editor-shell.editor-focused
  --editor-content-color var(--editor-active-content-color)
  --editor-placeholder-color var(--editor-active-placeholder-color)

.editor-top
  display flex
  justify-content space-between
  align-items flex-start
  gap 1rem
  margin-bottom 1rem

.editor-top > div:first-child h1
  line-height 1.25
  letter-spacing 0.01em
  color var(--btn-content)

.editor-title-row
  display flex
  flex-direction column
  align-items flex-start
  gap 0.5rem

.mode-switch
  position relative
  display inline-flex
  align-items center
  gap 0.25rem
  padding 0.2rem
  border-radius 0.75rem
  background var(--mode-switch-bg)
  border 1px solid var(--mode-switch-border)

.mode-switch-indicator
  position absolute
  top 0.2rem
  bottom 0.2rem
  left 0
  width 0
  border-radius 0.55rem
  background var(--mode-switch-tab-active-bg)
  border 1px solid var(--mode-switch-tab-active-border)
  box-shadow 0 2px 8px rgba(0, 0, 0, 0.12)
  pointer-events none
  z-index 0
  transition transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), width 0.28s cubic-bezier(0.22, 1, 0.36, 1)
  &.dragging
    transition none
    cursor grabbing

.mode-switch button
  position relative
  z-index 1
  display inline-flex
  align-items center
  justify-content center
  height 1.9rem
  padding 0 0.75rem
  line-height 1
  font-size 0.85rem
  font-weight 600
  border 1px solid transparent
  border-radius 0.55rem
  background transparent
  color var(--mode-switch-tab-color)
  cursor pointer
  transition background 0.18s ease, color 0.18s ease, border-color 0.18s ease
  &:hover
    color var(--primary)
  &.active
    color var(--mode-switch-tab-active-color)

.editor-top > div:first-child p
  line-height 1.5
  color rgba(71, 85, 105, 0.96)
  font-weight 600

.top-actions
  display inline-flex
  align-items center
  gap 0.6rem

.drafts-btn
  display inline-flex
  align-items center
  justify-content center
  height 2.65rem
  padding 0 1rem
  line-height 1
  font-size 1.05rem
  border 1px solid var(--primary)
  color var(--btn-content)
  border-radius 12px
  font-weight 700
  background transparent
  transition transform 0.2s ease, background 0.2s ease, opacity 0.2s ease
  &:hover
    background var(--btn-regular-bg)
    transform translateY(-1px)

.submit-btn
  display inline-flex
  align-items center
  justify-content center
  height 2.65rem
  padding 0 1.05rem
  line-height 1
  font-size 1.05rem
  border 1px solid var(--primary)
  background var(--primary)
  color white
  border-radius 12px
  font-weight 700
  box-shadow 0 8px 20px rgba(59, 130, 246, 0.2)
  transition transform 0.2s ease, filter 0.2s ease, opacity 0.2s ease
  &:hover
    transform translateY(-1px)
    filter brightness(1.05)
  &:disabled
    opacity 0.55
    filter saturate(0.75)
    cursor not-allowed

.locked-tip
  margin-top 0.5rem
  border 1px dashed var(--primary)
  border-radius 0.9rem
  padding 1rem
  color var(--btn-content)

.meta-grid
  display grid
  grid-template-columns repeat(2, minmax(0, 1fr))
  gap 0.75rem
  margin-bottom 0.75rem

.meta-field
  min-width 0
  display flex
  flex-direction column
  gap 0.35rem

.meta-input
  width 100%
  height 2.45rem
  border-radius 0.65rem
  padding 0 0.75rem
  line-height 2.45rem
  font-size 1rem
  font-weight 600
  letter-spacing 0
  background var(--btn-regular-bg)
  border 1px solid rgba(148, 163, 184, 0.24)
  color rgba(30, 41, 59, 0.98)
  outline none
  transition border-color 0.18s ease, box-shadow 0.18s ease
  &::placeholder
    color rgba(100, 116, 139, 0.95)
    opacity 1
  &:focus
    border-color rgba(148, 163, 184, 0.36)
    box-shadow none

:global(html.dark) .editor-top > div:first-child p
  color rgba(203, 213, 225, 0.98)

:global(html.dark) .meta-input
  color rgba(236, 246, 255, 0.98)
  &::placeholder
    color rgba(171, 191, 198, 0.9)

.meta-warning
  padding 0 0.1rem
  font-size 0.8rem
  line-height 1.4
  color unquote('color-mix(in oklab, var(--primary) 78%, var(--btn-content))')

.cover-field
  display flex
  align-items stretch
  gap 0.5rem
  min-width 0
  .meta-input
    flex 1
    min-width 0

.cover-upload-btn
  flex none
  height 2.45rem
  padding 0 0.9rem
  border-radius 0.65rem
  border 1px solid rgba(148, 163, 184, 0.36)
  background var(--btn-regular-bg)
  color var(--btn-content)
  font-size 0.88rem
  font-weight 650
  white-space nowrap
  cursor pointer
  transition border-color 0.18s ease, background-color 0.18s ease, opacity 0.18s ease
  &:hover:not(:disabled)
    border-color var(--btn-regular-bg-hover)
    background var(--btn-regular-bg-hover)
  &:disabled
    opacity 0.6
    cursor default

.cover-file-input
  display none

.editor-options
  display flex
  flex-wrap wrap
  align-items center
  gap 0.95rem
  margin-bottom 0.8rem

.editor-workspace
  position relative
  border-radius 0.9rem
  overflow visible

.task-toolbar-bubble
  position absolute
  z-index 10040
  transform translateX(-50%)
  min-width 9rem
  padding 0.32rem
  border-radius 0.72rem
  border 1px solid var(--editor-tooltip-border)
  background var(--editor-tooltip-bg)
  color var(--editor-tooltip-text)
  box-shadow 0 12px 24px var(--editor-tooltip-shadow)
  backdrop-filter blur(6px)
  pointer-events auto

.task-toolbar-bubble::after
  content ''
  position absolute
  left 50%
  top -0.28rem
  width 0.56rem
  height 0.56rem
  background var(--editor-tooltip-bg)
  border-top 1px solid var(--editor-tooltip-border)
  border-left 1px solid var(--editor-tooltip-border)
  transform translateX(-50%) rotate(45deg)

.task-toolbar-bubble-actions
  position relative
  display flex
  gap 0.1rem
  padding 0.1rem
  border-radius 0.54rem
  background rgba(120, 146, 141, 0.15)
  isolation isolate

.task-toolbar-bubble-actions::before
  content ''
  position absolute
  top 0.1rem
  left 0.1rem
  width calc(50% - 0.15rem)
  height calc(100% - 0.2rem)
  border-radius 0.46rem
  background linear-gradient(180deg, rgba(96, 165, 250, 0.96) 0%, rgba(59, 130, 246, 0.96) 100%)
  box-shadow 0 6px 12px rgba(59, 130, 246, 0.28)
  transform translateX(0)
  transition transform 0.22s ease, box-shadow 0.2s ease
  z-index 1

.task-toolbar-bubble-actions.selected-right::before
  transform translateX(calc(100% + 0.1rem))

.task-bubble-choice
  flex 1 1 0
  min-width 3.4rem
  border none
  outline none
  border-radius 0.5rem
  padding 0.3rem 0.5rem
  font-size 0.76rem
  font-weight 680
  line-height 1
  position relative
  z-index 2
  color rgba(88, 107, 114, 0.95)
  background transparent
  transition color 0.16s ease, transform 0.16s ease
  &:hover
    color rgba(43, 63, 70, 0.98)
  &:focus-visible
    box-shadow 0 0 0 2px var(--editor-toolbar-focus-ring)
  &.is-active
    color rgba(249, 255, 252, 0.98)
    transform translateY(-0.5px)

:global(html.dark) .task-bubble-choice
  color rgba(201, 219, 225, 0.94)
  &:hover
    color rgba(234, 246, 250, 0.98)

.editor-context-menu
  position absolute
  z-index 10060
  min-width 10.8rem
  max-width unquote('min(18rem, calc(100vw - 16px))')
  display flex
  flex-direction column
  gap 0.18rem
  border-radius 0.66rem
  padding 0.34rem
  background var(--editor-context-menu-bg)
  border 1px solid var(--editor-context-menu-border)
  box-shadow 0 14px 28px rgba(2, 8, 17, 0.24), 0 0 0 1px var(--editor-context-menu-shadow)
  backdrop-filter blur(8px)

.context-menu-label
  padding 0.28rem 0.5rem
  font-size 0.77rem
  color var(--editor-context-menu-label)
  white-space nowrap
  overflow hidden
  text-overflow ellipsis

.context-menu-item
  width 100%
  border none
  outline none
  text-align left
  display flex
  align-items center
  justify-content space-between
  gap 0.7rem
  border-radius 0.48rem
  padding 0.44rem 0.58rem
  line-height 1.15
  font-size 0.88rem
  color var(--editor-context-menu-text)
  background transparent
  transition background-color 0.14s ease, color 0.14s ease
  &:hover
    background var(--editor-context-menu-hover)
  &:focus-visible
    background var(--editor-context-menu-hover)
    box-shadow inset 0 0 0 1px var(--editor-context-menu-focus-ring)
  &.danger
    color var(--editor-context-menu-danger)
    &:hover
      background var(--editor-context-menu-danger-hover)

.context-menu-item-label
  flex 1
  min-width 0

.context-menu-shortcut
  flex 0 0 auto
  display inline-flex
  align-items center
  gap 0.3rem
  font-size 0.8rem
  font-weight 700
  line-height 1
  color var(--editor-context-menu-shortcut-text)
  background var(--editor-context-menu-shortcut-bg)
  border 1px solid var(--editor-context-menu-shortcut-border)
  border-radius 0.38rem
  padding 0.13rem 0.34rem
  text-shadow 0 1px 0 rgba(4, 10, 20, 0.28)

.shortcut-icon
  width 0.88rem
  height 0.88rem
  fill currentColor

.image-edit-overlay
  position absolute
  inset 0
  z-index 2100
  display flex
  align-items center
  justify-content center
  padding 0.9rem
  border-radius 0.9rem
  background rgba(5, 11, 18, 0.54)
  backdrop-filter blur(2px)

.image-edit-panel
  width unquote('min(58rem, calc(100vw - 2rem))')
  max-height calc(100vh - 5rem)
  display flex
  flex-direction column
  border-radius 0.78rem
  overflow hidden
  background rgba(10, 18, 29, 0.98)
  border 1px solid rgba(102, 155, 214, 0.58)
  box-shadow 0 20px 38px rgba(1, 7, 15, 0.6)

.caption-edit-panel
  width unquote('min(26rem, calc(100vw - 2rem))')
  display flex
  flex-direction column
  border-radius 0.78rem
  overflow hidden
  background rgba(10, 18, 29, 0.98)
  border 1px solid rgba(102, 155, 214, 0.58)
  box-shadow 0 20px 38px rgba(1, 7, 15, 0.6)

.caption-edit-preview
  display block
  width 100%
  max-height 9rem
  object-fit contain
  background rgba(17, 30, 46, 0.86)

.image-edit-header
  display flex
  align-items center
  justify-content space-between
  padding 0.62rem 0.78rem
  border-bottom 1px solid rgba(90, 135, 190, 0.35)
  background rgba(18, 32, 49, 0.92)

.image-edit-title
  color rgba(232, 244, 255, 0.98)
  font-size 0.94rem
  font-weight 700

.image-edit-close
  border none
  width 2rem
  height 2rem
  border-radius 999px
  color rgba(226, 240, 255, 0.95)
  background rgba(45, 70, 99, 0.62)
  font-size 1.24rem
  line-height 1

.image-edit-body
  display grid
  grid-template-columns 1.1fr 0.9fr
  gap 0.9rem
  padding 0.84rem
  min-height 20rem
  overflow auto

.image-edit-stage
  position relative
  background rgba(8, 15, 24, 0.84)
  border 1px solid rgba(85, 129, 183, 0.45)
  border-radius 0.62rem
  min-height 16rem
  display flex
  align-items center
  justify-content center
  overflow hidden

.image-edit-preview-image
  transform-origin center center
  max-width 100%
  max-height min(60vh, 32rem)
  user-select none
  -webkit-user-drag none
  touch-action none
  cursor crosshair
  will-change transform

.image-edit-crop-box
  position absolute
  border 2px solid rgba(117, 199, 255, 0.98)
  box-shadow inset 0 0 0 9999px rgba(10, 28, 48, 0.38), 0 0 0 1px rgba(5, 16, 29, 0.95)
  pointer-events auto
  cursor url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cg filter='url(%23s)'%3E%3Ccircle cx='14' cy='14' r='4.4' fill='%230d1a28' stroke='%2368d3ff' stroke-width='1.4'/%3E%3Ccircle cx='14' cy='14' r='1.6' fill='%23e9fbff'/%3E%3C/g%3E%3Cpath d='M14 2.6 11.2 6h5.6L14 2.6Zm0 22.8 2.8-3.4h-5.6L14 25.4ZM25.4 14 22 11.2v5.6l3.4-2.8ZM2.6 14 6 16.8v-5.6L2.6 14Z' fill='%23c9f2ff' stroke='%230b1622' stroke-width='.55'/%3E%3Cpath d='M14 4.1 12.2 6.3h3.6L14 4.1Zm0 19.8 1.8-2.2h-3.6l1.8 2.2ZM23.9 14 21.7 12.2v3.6l2.2-1.8ZM4.1 14l2.2 1.8v-3.6L4.1 14Z' fill='%23f5feff' opacity='.92'/%3E%3Cdefs%3E%3Cfilter id='s' x='7.5' y='7.5' width='13' height='13' filterUnits='userSpaceOnUse'%3E%3CfeDropShadow dx='0' dy='0.6' stdDeviation='0.6' flood-color='%23040b14' flood-opacity='.7'/%3E%3C/filter%3E%3C/defs%3E%3C/svg%3E") 14 14, move
  &:active
    cursor url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Cg filter='url(%23s)'%3E%3Ccircle cx='14' cy='14' r='4.4' fill='%2309121c' stroke='%234bc5ff' stroke-width='1.4'/%3E%3Ccircle cx='14' cy='14' r='1.7' fill='%23bff0ff'/%3E%3C/g%3E%3Cpath d='M14 2.6 11.2 6h5.6L14 2.6Zm0 22.8 2.8-3.4h-5.6L14 25.4ZM25.4 14 22 11.2v5.6l3.4-2.8ZM2.6 14 6 16.8v-5.6L2.6 14Z' fill='%238fdfff' stroke='%23070f18' stroke-width='.55'/%3E%3Cdefs%3E%3Cfilter id='s' x='7.5' y='7.5' width='13' height='13' filterUnits='userSpaceOnUse'%3E%3CfeDropShadow dx='0' dy='0.5' stdDeviation='0.6' flood-color='%23030a13' flood-opacity='.78'/%3E%3C/filter%3E%3C/defs%3E%3C/svg%3E") 14 14, grabbing

.image-edit-crop-handle
  position absolute
  width 0.86rem
  height 0.86rem
  border-radius 999px
  border 2px solid rgba(15, 22, 30, 0.95)
  background rgba(236, 247, 255, 0.98)
  box-shadow 0 0 0 1px rgba(113, 186, 238, 0.85)
  touch-action none
  &.nw
    left -0.5rem
    top -0.5rem
    cursor nwse-resize
  &.n
    left 50%
    top -0.5rem
    transform translateX(-50%)
    cursor ns-resize
  &.ne
    right -0.5rem
    top -0.5rem
    cursor nesw-resize
  &.e
    right -0.5rem
    top 50%
    transform translateY(-50%)
    cursor ew-resize
  &.se
    right -0.5rem
    bottom -0.5rem
    cursor nwse-resize
  &.s
    left 50%
    bottom -0.5rem
    transform translateX(-50%)
    cursor ns-resize
  &.sw
    left -0.5rem
    bottom -0.5rem
    cursor nesw-resize
  &.w
    left -0.5rem
    top 50%
    transform translateY(-50%)
    cursor ew-resize

.image-edit-controls
  display flex
  flex-direction column
  gap 0.6rem
  padding 0.12rem

.image-edit-rect-grid
  display grid
  grid-template-columns 1fr 1fr
  gap 0.45rem

.image-edit-field
  display flex
  flex-direction column
  gap 0.22rem
  span
    font-size 0.75rem
    color rgba(183, 212, 243, 0.95)

.image-edit-input
  width 100%
  height 2.1rem
  border-radius 0.5rem
  border 1px solid rgba(96, 146, 203, 0.55)
  background rgba(17, 30, 46, 0.86)
  color rgba(229, 242, 255, 0.98)
  padding 0 0.58rem

.image-edit-tip
  font-size 0.78rem
  color rgba(163, 195, 228, 0.82)

.image-edit-caption-row
  display flex
  align-items center
  gap 0.45rem
  .image-edit-caption-label
    font-size 0.78rem
    color rgba(163, 195, 228, 0.82)
    white-space nowrap
  .image-edit-caption-input
    flex 1
    min-width 0

.image-edit-actions
  margin-top auto
  display flex
  gap 0.45rem
  justify-content flex-end
  flex-wrap wrap

.image-edit-btn
  border none
  border-radius 0.48rem
  padding 0.44rem 0.72rem
  font-size 0.82rem
  font-weight 650
  &.secondary
    color rgba(196, 220, 245, 0.94)
    background rgba(39, 62, 89, 0.66)
  &.primary
    color rgba(247, 252, 255, 0.98)
    background rgba(46, 142, 243, 0.9)

.draft-toggle
  display inline-flex
  align-items center
  gap 0.45rem
  font-size 0.88rem

.editor-host
  --editor-host-border-color var(--btn-regular-bg-hover)
  --editor-host-outline-shadow none
  border-radius 0.9rem
  overflow visible
  min-height 24rem
  position relative
  background linear-gradient(150deg, rgba(255, 255, 255, 0.58) 0%, rgba(223, 243, 236, 0.4) 100%)
  transition background 0.2s ease

.editor-host::after
  content ''
  position absolute
  inset 0
  border-radius inherit
  border 1px solid var(--editor-host-border-color)
  box-shadow var(--editor-host-outline-shadow)
  pointer-events none
  z-index 12

.editor-shell.editor-focused .editor-host
  --editor-host-border-color var(--editor-glow-color)
  --editor-host-outline-shadow 0 0 0 1px var(--editor-glow-color)
  background linear-gradient(150deg, rgba(255, 255, 255, 0.72) 0%, rgba(214, 238, 229, 0.55) 100%)

:global(html.dark) .editor-host
  background linear-gradient(160deg, rgba(29, 45, 52, 0.72) 0%, rgba(18, 57, 50, 0.58) 100%)

:global(html.dark) .editor-shell.editor-focused .editor-host
  background linear-gradient(160deg, rgba(34, 55, 62, 0.82) 0%, rgba(24, 66, 58, 0.66) 100%)

.editor-loading
  position absolute
  inset 0
  display flex
  align-items center
  justify-content center
  color var(--btn-content)
  opacity 0.9
  pointer-events none

.editor-loading::before
  content ''
  width 1.5rem
  height 1.5rem
  border-radius 9999px
  border 2px solid rgba(120, 146, 141, 0.35)
  border-top-color var(--primary)
  animation editor-loading-spin 0.9s linear infinite

@keyframes editor-loading-spin
  from
    transform rotate(0deg)
  to
    transform rotate(360deg)

.editor-error
  position absolute
  inset 0
  display flex
  align-items center
  justify-content center
  color rgba(248, 113, 113, 0.95)
  font-size 0.95rem
  padding 1rem
  text-align center

.editor-foot
  margin-top 0.75rem
  display flex
  flex-wrap wrap
  align-items center
  justify-content space-between
  gap 0.75rem
  font-size 0.86rem
  color var(--btn-content)

.status-wrap
  display inline-flex
  align-items center
  flex-wrap wrap
  gap 0.45rem
  min-height 2.05rem

.load-draft-prompt
  display inline-flex
  align-items center
  gap 0.35rem
  padding 0.16rem 0.45rem
  border 1px solid rgba(120, 146, 141, 0.35)
  border-radius 999px
  background rgba(240, 248, 244, 0.7)

.load-draft-text
  font-size 0.8rem
  color rgba(55, 81, 76, 0.88)

.draft-choice-btn
  display inline-flex
  align-items center
  justify-content center
  min-width 2.3rem
  height 1.55rem
  padding 0 0.45rem
  line-height 1
  border 1px solid var(--primary)
  border-radius 999px
  font-size 0.74rem
  background var(--primary)
  color #fff
  transition filter 0.2s ease, opacity 0.2s ease
  &:hover
    filter brightness(1.05)

.draft-choice-btn.secondary
  background transparent
  color var(--btn-content)

.save-btn
  display inline-flex
  align-items center
  justify-content center
  margin-left auto
  height 2.25rem
  padding 0 0.82rem
  line-height 1
  border 1px solid var(--primary)
  background transparent
  border-radius 0.55rem

.save-btn.secondary
  border-color rgba(120, 146, 141, 0.48)

.foot-actions
  margin-left auto
  display inline-flex
  align-items center
  flex-wrap wrap
  gap 0.5rem
  .save-btn
    margin-left 0

.md-file-input
  display none

:global(html.dark) .load-draft-prompt
  background rgba(18, 34, 37, 0.78)
  border-color rgba(95, 136, 127, 0.52)

:global(html.dark) .load-draft-text
  color rgba(192, 219, 210, 0.9)

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

:global(html.editor-image-preview-open),
:global(html.editor-image-preview-open body)
  overflow hidden

.image-preview-overlay
  position absolute
  inset 0
  z-index 2200
  display flex
  align-items center
  justify-content center
  padding 1rem
  border-radius 0.9rem
  overflow hidden
  background rgba(7, 12, 20, 0.46)
  animation image-preview-overlay-in 0.2s ease both

.image-preview-stage
  display flex
  width 100%
  height 100%
  align-items center
  justify-content center
  padding 0.4rem
  overflow hidden
  animation image-preview-image-in 0.24s ease both
  position relative
  z-index 1

.image-preview-frame
  position relative
  display flex
  align-items center
  justify-content center
  border-radius calc(0.9rem - 1px)
  overflow hidden
  box-shadow none

.image-preview-image
  display block
  width auto
  height auto
  max-width min(78vw, 1220px)
  max-height 80vh
  object-fit contain
  object-position center center
  border-radius calc(0.9rem - 1px)
  transform-origin center center
  transition transform 0.12s ease-out
  user-select none
  -webkit-user-drag none

.image-preview-close
  position absolute
  top 0.7rem
  right 0.7rem
  z-index 10
  width 2.2rem
  height 2.2rem
  border 1px solid rgba(255, 255, 255, 0.45)
  border-radius 999px
  display inline-flex
  align-items center
  justify-content center
  font-size 1.5rem
  font-weight 700
  line-height 1
  color rgba(255, 255, 255, 1)
  background rgba(10, 16, 24, 0.78)
  backdrop-filter blur(2px)
  opacity 1
  pointer-events auto
  transition background-color 0.16s ease, transform 0.16s ease, box-shadow 0.16s ease
  &:hover
    background rgba(10, 16, 24, 0.92)
    box-shadow 0 0 0 2px rgba(255, 255, 255, 0.2)
    transform scale(1.04)

.image-preview-close-global
  position absolute
  top 0.8rem
  right 0.8rem
  z-index 9999
  width 2.4rem
  height 2.4rem
  border none
  border-radius 999px
  display inline-flex
  align-items center
  justify-content center
  font-size 1.58rem
  font-weight 700
  line-height 1
  color #fff
  background #111827
  box-shadow 0 0 0 2px rgba(0, 0, 0, 0.58), 0 10px 20px rgba(0, 0, 0, 0.5)
  pointer-events auto
  &:hover
    background #030712

@keyframes image-preview-overlay-in
  from
    opacity 0
  to
    opacity 1

@keyframes image-preview-image-in
  from
    opacity 0
    transform scale(0.92)
  to
    opacity 1
    transform scale(1)

:global(.toastui-editor-contents img)
  max-width 100%
  height auto
  cursor zoom-in

:global(.toastui-editor-defaultUI)
  border none !important
  border-radius calc(0.9rem - 1px) !important
  overflow visible !important
  width 100% !important
  box-sizing border-box !important
  background var(--editor-paper-bg) !important

:global(.toastui-editor-defaultUI > .toastui-editor-main)
  border-bottom-left-radius calc(0.9rem - 1px)
  border-bottom-right-radius calc(0.9rem - 1px)
  overflow hidden
  display flex !important
  flex-direction column !important

:global(.toastui-editor-defaultUI > .toastui-editor-main > .toastui-editor-main-container)
  flex 1 1 0 !important
  min-height 0 !important
  overflow hidden !important

:global(.toastui-editor-defaultUI > .toastui-editor-main > .toastui-editor-mode-switch)
  flex 0 0 auto !important

:global(.toastui-editor-defaultUI-toolbar)
  display block !important
  width 100% !important
  box-sizing border-box !important
  height auto !important
  position relative
  overflow visible
  border-top-left-radius calc(0.9rem - 1px) !important
  border-top-right-radius calc(0.9rem - 1px) !important
  background linear-gradient(180deg, var(--editor-toolbar-bg-a) 0%, var(--editor-toolbar-bg-b) 100%) !important
  border-bottom 1px solid var(--editor-toolbar-border) !important
  padding 0.5rem 0.58rem !important

:global(.toastui-editor-defaultUI-toolbar::before)
  display none

:global(.toastui-editor-toolbar)
  display flex !important
  width 100%
  min-width 0
  justify-content flex-start
  align-items center
  flex-wrap wrap
  height auto !important
  gap 0.28rem
  overflow visible
  white-space normal

:global(.toastui-editor-toolbar-group)
  display inline-flex
  flex 0 0 auto
  align-items center
  gap 0.16rem
  margin-right 0.2rem
  margin-bottom 0.1rem
  padding 0.14rem
  border-radius 0.62rem
  background var(--editor-toolbar-group-bg)

:global(.toastui-editor-toolbar-group:last-child)
  margin-right 0

:global(.toastui-editor-toolbar-divider)
  width 1px !important
  height 1.05rem !important
  margin 0 0.1rem !important
  background var(--editor-toolbar-divider) !important

:global(.toastui-editor-defaultUI-toolbar button)
  display inline-flex !important
  align-items center
  justify-content center
  width 2.04rem !important
  height 2.04rem !important
  margin 0 !important
  padding 0 !important
  border-radius 0.58rem !important
  border 1px solid var(--editor-toolbar-btn-border) !important
  background-color var(--editor-toolbar-btn-bg) !important
  color var(--editor-content-color) !important
  box-shadow none !important
  outline none !important
  transition background-color 0.16s ease, border-color 0.16s ease, box-shadow 0.16s ease

:global(.toastui-editor-defaultUI-toolbar button.link::before)
  content none !important
  display none !important
  background none !important

:global(.toastui-editor-defaultUI-toolbar button:not(:disabled):hover)
  background-color var(--editor-toolbar-btn-hover) !important
  border-color var(--editor-toolbar-btn-border-hover) !important
  box-shadow inset 0 0 0 1px var(--editor-toolbar-btn-border-hover) !important

:global(.toastui-editor-defaultUI-toolbar button:focus-visible)
  border-color var(--editor-toolbar-btn-border-hover) !important
  box-shadow 0 0 0 3px var(--editor-toolbar-focus-ring) !important

:global(.toastui-editor-defaultUI-toolbar button:disabled)
  opacity 0.38 !important

:global(.toastui-editor-toolbar-icons[data-svg-icon-name]:not(:disabled).active)
  background-color var(--editor-toolbar-btn-active) !important
  border-color var(--editor-toolbar-btn-border-hover) !important
  box-shadow inset 0 0 0 1px var(--editor-toolbar-btn-border-hover) !important

:global(.toastui-editor-toolbar-icons[data-svg-icon-name])
  border-radius inherit !important
  background none !important
  background-image none !important
  text-indent 0 !important

:global(.toastui-editor-toolbar-icons[data-svg-icon-name] svg)
  width 1.02rem
  height 1.02rem
  stroke-width 2.05
  flex-shrink 0
  pointer-events none

:global(.toastui-editor-defaultUI-toolbar .toastui-editor-tooltip)
  position absolute !important
  z-index 9999 !important
  border-radius 0.56rem !important
  padding 0.36rem 0.56rem !important
  line-height 1 !important
  white-space nowrap !important
  border 1px solid var(--editor-tooltip-border) !important
  background var(--editor-tooltip-bg) !important
  color var(--editor-tooltip-text) !important
  box-shadow 0 10px 20px var(--editor-tooltip-shadow) !important
  transform translate(calc(1.02rem - 6px - 50%), calc(-100% - 46px)) !important
  pointer-events none !important

:global(.toastui-editor-defaultUI-toolbar .toastui-editor-tooltip .arrow)
  display none !important
  width 8px !important
  height 8px !important
  left 50% !important
  top auto !important
  bottom -4px !important
  margin-left -4px !important
  background var(--editor-tooltip-bg) !important
  border-right 1px solid var(--editor-tooltip-border) !important
  border-bottom 1px solid var(--editor-tooltip-border) !important
  transform rotate(45deg) !important
  z-index -1 !important

:global(.toastui-editor-md-container)
  background var(--editor-paper-bg) !important

:global(.toastui-editor-main-container)
  color var(--editor-content-color) !important
  background var(--editor-paper-bg) !important
  background-image repeating-linear-gradient(to bottom, transparent 0, transparent 31px, var(--editor-paper-line) 31px, var(--editor-paper-line) 32px) !important

:global(.toastui-editor-ww-container)
  background var(--editor-paper-bg) !important

:global(.toastui-editor-ww-container > .toastui-editor)
  background var(--editor-paper-bg) !important

:global(.toastui-editor-ww-container .toastui-editor-contents)
  background var(--editor-paper-bg) !important

:global(.toastui-editor-md-container .toastui-editor-md-preview)
  background var(--editor-paper-bg) !important

:global(.toastui-editor-md-tab-container)
  background transparent !important
  border-bottom 1px solid var(--btn-regular-bg-hover) !important

:global(.toastui-editor-mode-switch)
  height 2.2rem !important
  padding-right 0.35rem !important
  border-top 1px solid var(--mode-switch-border) !important
  background var(--mode-switch-bg) !important

:global(.toastui-editor-mode-switch .tab-item)
  display inline-flex !important
  align-items center
  justify-content center
  min-width 8.2rem
  font-family "Microsoft YaHei", "微软雅黑", "PingFang SC", "Noto Sans CJK SC", sans-serif !important
  margin 0 !important
  height 100% !important
  line-height 1 !important
  border 1px solid transparent !important
  border-radius 0.45rem !important
  background transparent !important
  color var(--mode-switch-tab-color) !important
  opacity 1

:global(.toastui-editor-mode-switch .tab-item.active)
:global(.toastui-editor-mode-switch .tab-item[aria-selected='true'])
  color var(--mode-switch-tab-active-color) !important
  opacity 1
  background var(--mode-switch-tab-active-bg) !important
  border-color var(--mode-switch-tab-active-border) !important

:global(.toastui-editor-mode-switch .tab-item.dev-markdown-only-tab)
  min-width 6.6rem

:global(.editor-shell.markdown-only .toastui-editor-mode-switch .tab-item.active:not(.dev-markdown-only-tab))
  background transparent !important
  border-color transparent !important
  color var(--mode-switch-tab-color) !important

:global(.editor-shell.markdown-only .toastui-editor-md-container .toastui-editor)
  width 100% !important
  border-right none !important

:global(.editor-shell.markdown-only .toastui-editor-md-container .toastui-editor-md-splitter)
  display none !important

:global(.editor-shell.markdown-only .toastui-editor-md-container .toastui-editor-md-preview)
  display none !important

:global(.toastui-editor-contents-placeholder::before)
  color var(--editor-placeholder-color) !important

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-contents-placeholder::before)
  color var(--editor-placeholder-color) !important

:global(.toastui-editor-ww-container .ProseMirror .placeholder)
  color var(--editor-placeholder-color) !important

:global(.toastui-editor-md-container .toastui-editor)
  color var(--editor-content-color) !important

:global(.toastui-editor-md-container .toastui-editor *)
  color var(--editor-content-color) !important

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents)
  color var(--editor-content-color) !important
  overflow-wrap anywhere !important
  word-break break-word !important

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents *)
  color var(--editor-content-color) !important

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents pre),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents pre *),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents code)
  overflow-wrap normal !important
  word-break normal !important

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents blockquote),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents blockquote *)
  color var(--editor-placeholder-color) !important

:global(.toastui-editor-ww-container .ProseMirror)
  color var(--editor-content-color) !important
  caret-color var(--editor-content-color) !important

:global(.toastui-editor-ww-container .ProseMirror *)
  color var(--editor-content-color) !important

:global(.toastui-editor-md-container .toastui-editor),
:global(.toastui-editor-md-container .toastui-editor-md-preview),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents),
:global(.toastui-editor-ww-container .toastui-editor),
:global(.toastui-editor-ww-container .toastui-editor-contents)
  scrollbar-width thin
  scrollbar-color var(--editor-scrollbar-thumb) var(--editor-scrollbar-track)

:global(.toastui-editor-md-container .toastui-editor::-webkit-scrollbar),
:global(.toastui-editor-md-container .toastui-editor-md-preview::-webkit-scrollbar),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents::-webkit-scrollbar),
:global(.toastui-editor-ww-container .toastui-editor::-webkit-scrollbar),
:global(.toastui-editor-ww-container .toastui-editor-contents::-webkit-scrollbar)
  width 10px
  height 10px

:global(.toastui-editor-md-container .toastui-editor::-webkit-scrollbar-track),
:global(.toastui-editor-md-container .toastui-editor-md-preview::-webkit-scrollbar-track),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents::-webkit-scrollbar-track),
:global(.toastui-editor-ww-container .toastui-editor::-webkit-scrollbar-track),
:global(.toastui-editor-ww-container .toastui-editor-contents::-webkit-scrollbar-track)
  background var(--editor-scrollbar-track)
  border-radius 999px

:global(.toastui-editor-md-container .toastui-editor::-webkit-scrollbar-thumb),
:global(.toastui-editor-md-container .toastui-editor-md-preview::-webkit-scrollbar-thumb),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents::-webkit-scrollbar-thumb),
:global(.toastui-editor-ww-container .toastui-editor::-webkit-scrollbar-thumb),
:global(.toastui-editor-ww-container .toastui-editor-contents::-webkit-scrollbar-thumb)
  background var(--editor-scrollbar-thumb)
  border-radius 999px
  border 2px solid transparent
  background-clip padding-box

:global(.toastui-editor-md-container .toastui-editor::-webkit-scrollbar-thumb:hover),
:global(.toastui-editor-md-container .toastui-editor-md-preview::-webkit-scrollbar-thumb:hover),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents::-webkit-scrollbar-thumb:hover),
:global(.toastui-editor-ww-container .toastui-editor::-webkit-scrollbar-thumb:hover),
:global(.toastui-editor-ww-container .toastui-editor-contents::-webkit-scrollbar-thumb:hover)
  background var(--editor-scrollbar-thumb-hover)

:global(.toastui-editor-contents)
  color var(--editor-content-color) !important

:global(.toastui-editor-defaultUI)
  --dev-editor-content-font-size 15px
  --dev-editor-content-line-height 1.7
  --dev-editor-content-font-family "KeinannMaruPOP", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Noto Sans SC", "Source Han Sans SC", sans-serif

:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor),
:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents),
:global(.toastui-editor-defaultUI .toastui-editor-ww-container .toastui-editor-contents)
  font-size var(--dev-editor-content-font-size) !important
  line-height var(--dev-editor-content-line-height) !important
  font-family var(--dev-editor-content-font-family) !important
  font-weight 400 !important

:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor *),
:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents *),
:global(.toastui-editor-defaultUI .toastui-editor-ww-container .toastui-editor-contents *)
  font-size inherit !important
  line-height inherit !important
  font-family inherit !important

:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor .CodeMirror),
:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor .CodeMirror pre)
  font-size var(--dev-editor-content-font-size) !important
  line-height var(--dev-editor-content-line-height) !important
  font-family var(--dev-editor-content-font-family) !important

:global(.toastui-editor-contents ul),
:global(.toastui-editor-contents ol),
:global(.toastui-editor-contents ul li),
:global(.toastui-editor-contents ol li),
:global(.toastui-editor-contents ul p),
:global(.toastui-editor-contents ol p)
  font-size inherit !important

:global(.toastui-editor-contents ul),
:global(.toastui-editor-contents ol)
  padding-top 3px !important

:global(.toastui-editor-contents ul > li:not(.task-list-item)::before),
:global(.toastui-editor-contents ol > li::before)
  font-size 1em !important

:global(.toastui-editor-contents ul > li:not(.task-list-item)::before)
  width 0.36em !important
  height 0.36em !important
  margin-top 0 !important
  top 0.67em !important
  transform translateY(-50%) !important
  color var(--editor-bold-color) !important
  background-color var(--editor-bold-color) !important

:global(.toastui-editor-contents .task-list-item::before)
  top calc(50% + 1px) !important
  transform translateY(-50%) !important
  margin-top 0 !important

:global(.toastui-editor-contents ol > li::before)
  display inline-flex !important
  align-items center !important
  justify-content center !important
  top 50% !important
  transform translateY(-50%) !important
  margin-top 0 !important
  line-height 1 !important

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents a),
:global(.toastui-editor-ww-container .toastui-editor-contents a),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-link),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-link .toastui-editor-md-marked-text),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-link .toastui-editor-md-delimiter)
  color var(--editor-link-color) !important
  text-decoration none !important

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents a:hover),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents a:focus),
:global(.toastui-editor-ww-container .toastui-editor-contents a:hover),
:global(.toastui-editor-ww-container .toastui-editor-contents a:focus),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-link:hover),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-link:hover .toastui-editor-md-marked-text),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-link:focus),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-link:focus .toastui-editor-md-marked-text)
  color var(--editor-link-color) !important
  text-decoration none !important

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block-line-background)
  background var(--editor-code-fence-bg) !important
  box-shadow inset 3px 0 0 var(--editor-code-fence-border)

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block-line-background.start)
  border-top-right-radius 0.5rem

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block-line-background.end)
  border-bottom-right-radius 0.5rem

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block .toastui-editor-md-marked-text)
  color var(--editor-code-fence-text) !important

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block .toastui-editor-md-meta),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block .toastui-editor-md-delimiter)
  color var(--editor-code-fence-meta) !important

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block .toastui-editor-md-meta)
  display inline-flex !important
  align-items center
  min-height 1.45rem
  padding 0.08rem 0.46rem !important
  border-radius 0.45rem
  background var(--editor-code-lang-bg)
  line-height 1.15 !important
  vertical-align middle

:global(.toastui-editor-contents pre)
  background var(--editor-code-preview-bg) !important
  border 1px solid var(--editor-code-preview-border) !important
  border-radius 0.75rem !important
  box-shadow inset 0 0 0 1px var(--editor-code-preview-border)

:global(.toastui-editor-md-preview .toastui-editor-contents pre[data-language])
  position relative
  padding-top 2.1rem !important

:global(.toastui-editor-md-preview .toastui-editor-contents pre[data-language]::after)
  content attr(data-language)
  position absolute
  top 0.55rem
  right 0.55rem
  left auto !important
  bottom auto !important
  z-index 2
  color var(--editor-code-lang-text) !important
  background var(--editor-code-lang-bg) !important
  border 1px solid var(--editor-code-preview-border) !important
  border-radius 0.5rem
  min-height 1.52rem
  padding 0.14rem 0.56rem
  line-height 1.15
  font-size 0.82rem
  display inline-flex
  align-items center
  pointer-events none

:global(.toastui-editor-md-preview .toastui-editor-contents pre.toastui-editor-md-preview-highlight::after)
  content attr(data-language) !important
  position absolute !important
  top 0.55rem !important
  right 0.55rem !important
  left auto !important
  bottom auto !important
  display inline-flex !important
  align-items center
  pointer-events none

:global(.toastui-editor-md-preview .toastui-editor-contents pre.toastui-editor-md-preview-highlight)
  box-shadow inset 0 0 0 1px var(--editor-code-preview-border), 0 0 0 1px var(--editor-code-lang-bg) !important

:global(.toastui-editor-md-preview .toastui-editor-contents pre[data-language='text']::after)
  display none !important

:global(.toastui-editor-contents pre.dev-code-block-with-copy)
  position relative
  padding-top 2.1rem !important

:global(.toastui-editor-md-preview .toastui-editor-contents pre.dev-code-block-with-copy[data-language]::after)
  right 3rem !important

:global(.toastui-editor-md-preview .toastui-editor-contents pre.dev-code-block-with-copy.toastui-editor-md-preview-highlight::after)
  right 3rem !important

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn)
  position absolute
  top 0.55rem
  right 0.55rem
  z-index 3
  width 1.35rem
  height 1.35rem
  border none
  border-radius 0
  display inline-flex
  align-items center
  justify-content center
  color rgba(107, 114, 128, 0.95)
  background transparent !important
  cursor pointer
  opacity 0
  visibility hidden
  transform translateY(-2px)
  pointer-events none
  box-shadow none !important
  transition opacity 0.15s ease, transform 0.16s ease, color 0.16s ease

:global(.toastui-editor-contents pre.dev-code-block-with-copy:hover > .dev-code-copy-btn),
:global(.toastui-editor-contents pre.dev-code-block-with-copy:focus-within > .dev-code-copy-btn),
:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn[data-copy-state='success']),
:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn[data-copy-state='error'])
  opacity 1
  visibility visible
  transform translateY(0)
  pointer-events auto

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn:hover)
  color rgba(75, 85, 99, 0.98)
  background transparent !important
  box-shadow none !important

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn:focus-visible)
  outline none
  box-shadow 0 0 0 2px var(--editor-toolbar-focus-ring) !important

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn > .copy-icon),
:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn > .check-icon)
  position absolute
  display inline-flex
  align-items center
  justify-content center
  line-height 0
  transition opacity 0.14s ease, transform 0.16s ease

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn > .copy-icon)
  opacity 1
  transform scale(1)

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn > .check-icon)
  opacity 0
  transform scale(0.78)

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn svg)
  width 0.88rem
  height 0.88rem
  display block

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn[data-copy-state='success'])
  color rgba(22, 163, 74, 0.98)
  background transparent !important
  box-shadow none !important

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn[data-copy-state='success'] > .copy-icon)
  opacity 0
  transform scale(0.76)

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn[data-copy-state='success'] > .check-icon)
  opacity 1
  transform scale(1)

:global(.toastui-editor-contents pre.dev-code-block-with-copy > .dev-code-copy-btn[data-copy-state='error'])
  color rgba(153, 27, 27, 0.98)
  background transparent !important

:global(.toastui-editor-contents pre code)
  color var(--editor-code-preview-text) !important

:global(.toastui-editor-md-preview .toastui-editor-contents code):not(pre code)
:global(.toastui-editor-ww-container .toastui-editor-contents code):not(pre code)
  background var(--editor-code-inline-bg) !important
  color var(--editor-code-inline-text) !important
  border-radius 0.33rem
  padding 0.04rem 0.24rem !important

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code):not(.toastui-editor-md-code-block)
  background var(--editor-code-inline-bg) !important
  color var(--editor-code-inline-text) !important
  border-radius 0.33rem

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code):not(.toastui-editor-md-code-block) .toastui-editor-md-delimiter,
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code.toastui-editor-md-delimiter):not(.toastui-editor-md-code-block),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-code.toastui-editor-md-marked-text):not(.toastui-editor-md-code-block)
  color var(--editor-code-inline-text) !important

:global(.dev-editor-link-tooltip)
  position fixed
  top 0
  left 0
  z-index 99999
  display inline-block
  width auto
  max-width 30rem
  padding 0.52rem 0.72rem
  border-radius 0.68rem
  border 1px solid var(--dev-link-tooltip-border, rgba(120, 146, 141, 0.35))
  background var(--dev-link-tooltip-bg, rgba(255, 255, 255, 0.98))
  color var(--dev-link-tooltip-text, rgba(18, 31, 36, 0.96))
  box-shadow 0 14px 32px var(--dev-link-tooltip-shadow, rgba(15, 23, 42, 0.18))
  font-size 0.86rem
  line-height 1.3
  white-space normal
  word-break break-word
  pointer-events none
  opacity 0
  transform translateY(4px)
  transition opacity 0.14s ease, transform 0.14s ease

:global(.dev-editor-link-tooltip.visible)
  opacity 1
  transform translateY(0)

:global(.dev-editor-link-tooltip::after)
  content ""
  position absolute
  left var(--dev-link-tooltip-arrow-left, 50%)
  width 10px
  height 10px
  margin-left -5px
  transform rotate(45deg)
  background var(--dev-link-tooltip-bg, rgba(255, 255, 255, 0.98))

:global(.dev-editor-link-tooltip[data-side='top']::after)
  top calc(100% - 6px)
  border-right 1px solid var(--dev-link-tooltip-border, rgba(120, 146, 141, 0.35))
  border-bottom 1px solid var(--dev-link-tooltip-border, rgba(120, 146, 141, 0.35))

:global(.dev-editor-link-tooltip[data-side='bottom']::after)
  bottom calc(100% - 6px)
  border-left 1px solid var(--dev-link-tooltip-border, rgba(120, 146, 141, 0.35))
  border-top 1px solid var(--dev-link-tooltip-border, rgba(120, 146, 141, 0.35))

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents mark),
:global(.toastui-editor-ww-container .toastui-editor-contents mark)
  background var(--editor-highlight-bg) !important
  color var(--editor-highlight-text) !important
  border-radius 0.25rem !important
  padding 0 0.25rem !important
  line-height inherit !important
  box-decoration-break clone
  -webkit-box-decoration-break clone

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents sup),
:global(.toastui-editor-ww-container .toastui-editor-contents sup),
:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents sub),
:global(.toastui-editor-ww-container .toastui-editor-contents sub)
  line-height 1 !important
  position relative
  vertical-align baseline
  font-weight 600

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents sup),
:global(.toastui-editor-ww-container .toastui-editor-contents sup)
  font-size 0.74em !important
  top -0.26em

:global(.toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents sub),
:global(.toastui-editor-ww-container .toastui-editor-contents sub)
  font-size 0.78em !important
  bottom -0.16em

:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor-md-preview .toastui-editor-contents strong),
:global(.toastui-editor-defaultUI .toastui-editor-ww-container .toastui-editor-contents strong),
:global(.toastui-editor-defaultUI .toastui-editor-ww-container .ProseMirror strong)
  background transparent !important
  color inherit !important
  border-radius 0 !important
  padding 0 !important
  font-weight 700 !important
  box-decoration-break slice
  -webkit-box-decoration-break slice

:global(.toastui-editor-md-container .toastui-editor .cm-strong),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-bold),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-bold .toastui-editor-md-marked-text)
  background transparent !important
  color inherit !important
  border-radius 0 !important
  padding 0 !important
  font-weight 700 !important

:global(.toastui-editor-contents .toastui-editor-ww-code-block code)
  background transparent !important
  color var(--editor-code-preview-text) !important
  border-radius 0 !important
  padding 0 !important
  box-shadow none !important

:global(.toastui-editor-contents .toastui-editor-ww-code-block:after)
  color var(--editor-code-lang-text) !important
  background var(--editor-code-lang-bg) !important
  border 1px solid var(--editor-code-preview-border) !important
  border-radius 0.5rem
  top 0.55rem !important
  right 0.55rem !important
  left auto !important
  height auto !important
  min-height 1.52rem
  padding 0.14rem 0.56rem !important
  line-height 1.15 !important
  font-size 0.82rem !important
  display inline-flex !important
  align-items center
  justify-content center
  background-image none !important
  background-position initial !important
  background-size auto !important

:global(.toastui-editor-contents .toastui-editor-ww-code-block[data-language='text']:after)
  display none !important

:global(.toastui-editor-contents .toastui-editor-ww-code-block *):not(:after)
  background transparent !important

:global(.toastui-editor-contents table)
  border-collapse collapse !important
  border 1px solid var(--editor-table-border) !important
  background var(--editor-table-cell-bg) !important
  box-shadow 0 10px 24px var(--editor-table-shadow), inset 0 0 0 1px var(--editor-table-border)

:global(.toastui-editor-contents table th),
:global(.toastui-editor-contents table td)
  border 1px solid var(--editor-table-border) !important
  background var(--editor-table-cell-bg) !important
  color var(--editor-content-color) !important
  padding 0.48rem 0.62rem !important
  min-height 2.05rem !important
  min-width 2.35rem !important
  vertical-align top !important
  box-shadow inset 0 0 0 1px var(--editor-table-border)

:global(.toastui-editor-contents table th)
  background var(--editor-table-header-bg) !important
  font-weight 700 !important

:global(.toastui-editor-contents table tbody tr:nth-child(even) td)
  background var(--editor-table-row-alt-bg) !important

:global(.toastui-editor-contents table tbody tr:hover td)
  background var(--editor-table-row-hover-bg) !important

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-table),
:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-table.toastui-editor-md-delimiter)
  color var(--editor-md-table-delimiter) !important
  opacity 1 !important
  text-shadow 0 0 0.5px currentColor

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-table .toastui-editor-md-table-cell)
  color var(--editor-md-table-text) !important
  font-weight 600 !important

:global(.toastui-editor-md-container .toastui-editor .toastui-editor-md-table .toastui-editor-md-delimiter)
  color var(--editor-md-table-delimiter) !important
  font-weight 700 !important

:global(.toastui-editor-defaultUI .toastui-editor-contents table th),
:global(.toastui-editor-defaultUI .toastui-editor-contents table td)
  border-color var(--editor-table-border) !important
  background-color var(--editor-table-cell-bg) !important

:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor .toastui-editor-md-table .toastui-editor-md-table-cell)
  color var(--editor-md-table-text) !important

:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block),
:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block .toastui-editor-md-marked-text)
  color var(--editor-code-fence-text) !important

:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block .toastui-editor-md-meta),
:global(.toastui-editor-defaultUI .toastui-editor-md-container .toastui-editor .toastui-editor-md-code-block .toastui-editor-md-delimiter)
  color var(--editor-code-fence-meta) !important

:global(.toastui-editor-contents details)
  margin 0.9rem 0
  border 1px solid var(--line-divider) !important
  border-radius 0.8rem
  overflow hidden
  background var(--editor-paper-bg)

:global(.toastui-editor-ww-container .toastui-editor-contents details:focus),
:global(.toastui-editor-ww-container .toastui-editor-contents details:focus-visible),
:global(.toastui-editor-ww-container .toastui-editor-contents details > summary:focus),
:global(.toastui-editor-ww-container .toastui-editor-contents details > summary:focus-visible)
  outline none !important
  box-shadow none !important

:global(.toastui-editor-ww-container .ProseMirror details.ProseMirror-selectednode),
:global(.toastui-editor-ww-container .ProseMirror details > summary.ProseMirror-selectednode)
  outline none !important
  box-shadow none !important
  border-color var(--line-divider) !important

:global(.toastui-editor-contents details > summary)
  position relative
  list-style none
  cursor pointer
  padding 0.65rem 0.9rem 0.92rem 2.1rem
  font-weight 700
  color var(--editor-content-color) !important
  background rgba(128, 134, 146, 0.12)

:global(.toastui-editor-contents details > summary::marker)
  content ''

:global(.toastui-editor-contents details > summary::-webkit-details-marker)
  display none

:global(.toastui-editor-contents details > summary::before)
  content '▸'
  position absolute
  left 0.88rem
  top 50%
  transform translateY(-52%)
  font-size 0.9rem
  line-height 1
  color var(--editor-content-color)
  opacity 0.88
  transition transform 0.16s ease

:global(.toastui-editor-contents details > summary::after)
  content ''
  position absolute
  left 0.75rem
  right 0.75rem
  bottom 0.33rem
  height 0.33rem
  border-radius 999px
  background rgba(128, 134, 146, 0.45)
  pointer-events none

:global(.toastui-editor-contents details[open] > summary::before)
  transform translateY(-52%) rotate(90deg)

:global(.toastui-editor-contents details[open] > summary)
  border-bottom 1px solid var(--line-divider)

:global(.toastui-editor-contents details > :not(summary))
  padding 0.72rem 0.9rem 0.9rem

:global(.toastui-editor-contents details > :not(summary) > :first-child)
  margin-top 0 !important

:global(.toastui-editor-contents details > :not(summary) > :last-child)
  margin-bottom 0 !important

:global(.toastui-editor-popup)
  background var(--editor-popup-bg) !important
  border 1px solid var(--editor-popup-border) !important
  border-radius 1.15rem !important
  box-shadow 0 20px 56px rgba(10, 6, 20, 0.58) !important
  color var(--editor-popup-text) !important

:global(.toastui-editor-popup-body)
  padding 1.12rem 1.2rem !important

:global(.toastui-editor-popup-body label)
  color var(--editor-popup-text) !important
  font-size 1.08rem !important
  font-weight 700 !important
  margin-bottom 0.56rem !important

:global(.toastui-editor-popup-body input[type='text'])
  height 2.82rem !important
  border-radius 0.72rem !important
  border 1px solid var(--editor-popup-input-border) !important
  background var(--editor-popup-input-bg) !important
  color var(--editor-popup-text) !important
  padding 0 0.84rem !important

:global(.toastui-editor-popup-body input[type='text']::placeholder)
  color var(--editor-popup-placeholder) !important

:global(.toastui-editor-popup-body input[type='text']:focus)
  border-color var(--editor-popup-accent) !important
  box-shadow 0 0 0 1px var(--editor-popup-accent), 0 0 0 4px var(--editor-popup-accent-soft) !important
  outline none !important

:global(.toastui-editor-popup-body .toastui-editor-button-container)
  margin-top 1rem !important
  display flex !important
  justify-content flex-end !important
  gap 0.56rem !important

:global(.toastui-editor-popup-add-link)
  width calc(100vw - 1.25rem) !important
  max-width 24.2rem !important
  border-radius 1.05rem !important
  border 1px solid var(--editor-popup-border) !important
  background var(--editor-popup-bg) !important
  box-shadow 0 16px 34px var(--editor-tooltip-shadow) !important

:global(.toastui-editor-popup-add-link .toastui-editor-popup-body)
  padding 1.06rem 1.06rem 0.96rem !important
  font-family var(--editor-popup-font-family) !important

:global(.toastui-editor-popup-add-link .toastui-editor-popup-body > div[aria-label])
  display grid !important
  grid-template-columns minmax(0, 1fr)
  gap 0.52rem

:global(.toastui-editor-popup-add-link .toastui-editor-popup-body label)
  margin 0.34rem 0 0 !important
  font-size 0.96rem !important
  line-height 1.24
  font-weight 650 !important
  letter-spacing 0.01em
  color var(--editor-popup-text) !important
  font-family var(--editor-popup-font-family) !important

:global(.toastui-editor-popup-add-link .toastui-editor-popup-body input[type='text'])
  height 2.5rem !important
  border-radius 0.66rem !important
  border 1px solid var(--editor-popup-input-border) !important
  background var(--editor-popup-input-bg) !important
  padding 0 0.78rem !important
  font-size 0.92rem !important
  font-weight 500 !important
  color var(--editor-popup-text) !important
  letter-spacing 0.005em
  font-family var(--editor-popup-font-family) !important
  transition border-color 0.18s ease, box-shadow 0.18s ease, background-color 0.18s ease

:global(.toastui-editor-popup-add-link .toastui-editor-popup-body .toastui-editor-button-container)
  margin-top 0.82rem !important
  gap 0.52rem !important
  justify-content flex-end !important

:global(.toastui-editor-popup-add-link .toastui-editor-close-button),
:global(.toastui-editor-popup-add-link .toastui-editor-ok-button)
  min-width 5.55rem !important
  height 2.36rem !important
  border-radius 0.6rem !important
  font-family var(--editor-popup-font-family) !important
  font-size 0.88rem !important
  font-weight 620 !important
  letter-spacing 0.01em
  box-shadow none !important
  transition background-color 0.16s ease, border-color 0.16s ease

:global(.toastui-editor-popup-add-link .toastui-editor-close-button)
  border 1px solid var(--editor-popup-input-border) !important
  background var(--editor-popup-cancel-bg) !important
  color var(--editor-popup-text) !important

:global(.toastui-editor-popup-add-link .toastui-editor-close-button:hover)
  border-color var(--editor-popup-accent) !important
  background var(--editor-popup-input-bg) !important

:global(.toastui-editor-popup-add-link .toastui-editor-ok-button)
  border 1px solid var(--editor-popup-accent) !important
  background var(--editor-popup-accent) !important
  color rgba(255, 255, 255, 0.99) !important

:global(.toastui-editor-popup-add-link .toastui-editor-ok-button:hover)
  filter none
  background var(--editor-popup-accent) !important
  opacity 0.9

:global(.toastui-editor-popup-add-link .toastui-editor-popup-body input[type='text']:focus)
  border-color var(--editor-popup-accent) !important
  background var(--editor-popup-input-bg) !important
  box-shadow 0 0 0 3px var(--editor-popup-accent-soft) !important
  outline none !important

:global(.toastui-editor-popup-add-image .toastui-editor-tabs)
  margin -0.12rem 0 0.92rem !important
  display flex !important
  gap 0.28rem !important
  border-bottom 1px solid var(--editor-popup-input-border) !important

:global(.toastui-editor-popup-add-image)
  width calc(100vw - 1.25rem) !important
  max-width 24.2rem !important
  border-radius 1rem !important
  border 1px solid var(--editor-popup-border) !important
  background var(--editor-popup-bg) !important
  box-shadow 0 16px 34px var(--editor-tooltip-shadow) !important

:global(.toastui-editor-popup-add-image .toastui-editor-popup-body)
  padding 1.06rem 1.06rem 0.96rem !important
  font-family var(--editor-popup-font-family) !important

:global(.toastui-editor-popup-add-image .toastui-editor-popup-body label)
  margin 0.34rem 0 0 !important
  font-size 0.96rem !important
  line-height 1.24
  font-weight 650 !important
  letter-spacing 0.01em
  color var(--editor-popup-text) !important
  font-family var(--editor-popup-font-family) !important

:global(.toastui-editor-popup-add-image .toastui-editor-tabs .tab-item)
  height auto !important
  padding 0.44rem 0.82rem !important
  margin 0 !important
  border none !important
  border-radius 0.62rem 0.62rem 0 0 !important
  color var(--editor-popup-text-dim) !important
  background transparent !important
  font-weight 620 !important
  font-family var(--editor-popup-font-family) !important

:global(.toastui-editor-popup-add-image .toastui-editor-tabs .tab-item.active)
  color var(--editor-popup-accent) !important
  background var(--editor-popup-tab-active-bg) !important
  border-bottom 2px solid var(--editor-popup-accent) !important

:global(.toastui-editor-popup-add-image .toastui-editor-file-name)
  height 2.5rem !important
  border-radius 0.66rem !important
  border 1px solid var(--editor-popup-input-border) !important
  background var(--editor-popup-input-bg) !important
  color var(--editor-popup-placeholder) !important
  text-align center !important
  line-height 2.5rem !important
  padding 0 !important
  font-family var(--editor-popup-font-family) !important

:global(.toastui-editor-popup-add-image .toastui-editor-file-select-button)
  height 2.5rem !important
  border-radius 0.66rem !important
  border 1px solid var(--editor-popup-input-border) !important
  background var(--editor-popup-cancel-bg) !important
  color var(--editor-popup-text) !important
  font-size 0.9rem !important
  font-weight 620 !important
  font-family var(--editor-popup-font-family) !important
  box-shadow none !important
  transition background-color 0.16s ease, border-color 0.16s ease

:global(.toastui-editor-popup-add-image .toastui-editor-file-select-button:hover)
  border-color var(--editor-popup-accent) !important
  background var(--editor-popup-input-bg) !important

:global(.toastui-editor-popup-add-image .toastui-editor-popup-body input[type='text'])
  height 2.5rem !important
  border-radius 0.66rem !important
  border 1px solid var(--editor-popup-input-border) !important
  background var(--editor-popup-input-bg) !important
  padding 0 0.78rem !important
  font-size 0.92rem !important
  font-weight 500 !important
  color var(--editor-popup-text) !important
  letter-spacing 0.005em
  font-family var(--editor-popup-font-family) !important

:global(.toastui-editor-popup-add-image .toastui-editor-popup-body input[type='text']:focus)
  border-color var(--editor-popup-accent) !important
  background var(--editor-popup-input-bg) !important
  box-shadow 0 0 0 3px var(--editor-popup-accent-soft) !important
  outline none !important

:global(.toastui-editor-md-preview .dev-img-caption)
  display block
  text-align center
  margin 0.15rem 0 1.35rem
  font-size 0.86rem
  line-height 1.5
  color #81868F

:global(.toastui-editor-popup-add-image .toastui-editor-button-container)
  margin-top 0.82rem !important
  gap 0.52rem !important
  justify-content flex-end !important

:global(.toastui-editor-popup-add-image .toastui-editor-close-button),
:global(.toastui-editor-popup-add-image .toastui-editor-ok-button)
  min-width 5.55rem !important
  height 2.36rem !important
  border-radius 0.6rem !important
  font-family var(--editor-popup-font-family) !important
  font-size 0.88rem !important
  font-weight 620 !important
  letter-spacing 0.01em
  box-shadow none !important
  transition background-color 0.16s ease, border-color 0.16s ease

:global(.toastui-editor-popup-add-image .toastui-editor-close-button)
  border 1px solid var(--editor-popup-input-border) !important
  background var(--editor-popup-cancel-bg) !important
  color var(--editor-popup-text) !important

:global(.toastui-editor-popup-add-image .toastui-editor-close-button:hover)
  border-color var(--editor-popup-accent) !important
  background var(--editor-popup-input-bg) !important

:global(.toastui-editor-popup-add-image .toastui-editor-ok-button)
  border 1px solid var(--editor-popup-accent) !important
  background var(--editor-popup-accent) !important
  color rgba(255, 255, 255, 0.99) !important

:global(.toastui-editor-popup-add-image .toastui-editor-ok-button:hover)
  filter none
  background var(--editor-popup-accent) !important
  opacity 0.9

:global(.toastui-editor-popup-add-heading ul li)
  padding 4px 10px !important
  border-radius 0.42rem !important
  color var(--editor-popup-text) !important

:global(.toastui-editor-popup-add-heading ul li:hover)
  background-color var(--btn-regular-bg-hover) !important
  color var(--editor-popup-text) !important

:global(.toastui-editor-popup-add-heading ul li h1),
:global(.toastui-editor-popup-add-heading ul li h2),
:global(.toastui-editor-popup-add-heading ul li h3),
:global(.toastui-editor-popup-add-heading ul li h4),
:global(.toastui-editor-popup-add-heading ul li h5),
:global(.toastui-editor-popup-add-heading ul li h6),
:global(.toastui-editor-popup-add-heading ul li p)
  color inherit !important

:global(.toastui-editor-popup-add-table .toastui-editor-table-cell)
  border-color var(--editor-table-picker-cell-border) !important
  background var(--editor-table-picker-cell-bg) !important

:global(.toastui-editor-popup-add-table .toastui-editor-table-cell.header)
  background var(--editor-table-picker-cell-header-bg) !important

:global(.toastui-editor-popup-add-table .toastui-editor-table-selection-layer)
  border-color var(--editor-table-picker-selection-border) !important
  background var(--editor-table-picker-selection-bg) !important

:global(.toastui-editor-popup-add-table .toastui-editor-table-description)
  margin-top 0.62rem !important
  color var(--editor-table-picker-text) !important
  font-size 0.95rem !important
  font-weight 700 !important
  letter-spacing 0.02em

:global(.toastui-editor-popup-add-table .toastui-editor-table-description *),
:global(.toastui-editor-dropdown-toolbar .toastui-editor-table-description),
:global(.toastui-editor-dropdown-toolbar .toastui-editor-table-description *)
  color var(--editor-table-picker-text) !important
  opacity 1 !important

:global(.toastui-editor-dropdown-toolbar.toastui-editor-popup-add-table),
:global(.toastui-editor-dropdown-toolbar .toastui-editor-popup-add-table)
  background var(--editor-popup-bg) !important
  border 1px solid var(--editor-popup-border) !important
  border-radius 1rem !important

:global(.toastui-editor-dropdown-toolbar.toastui-editor-popup-add-table .toastui-editor-table-description),
:global(.toastui-editor-dropdown-toolbar .toastui-editor-popup-add-table .toastui-editor-table-description)
  display inline-flex !important
  align-items center
  justify-content center
  min-height 1.65rem
  padding 0.12rem 0.56rem
  border-radius 999px
  background rgba(92, 128, 170, 0.18)
  text-shadow 0 0 0.5px currentColor

:global(.toastui-editor-dropdown-toolbar .toastui-editor-table-description)
  display inline-flex !important
  align-items center
  justify-content center
  min-height 1.65rem
  padding 0.12rem 0.56rem
  border-radius 999px
  background rgba(92, 128, 170, 0.18)

@media (max-width: 860px)
  .image-edit-body
    grid-template-columns 1fr

  .image-edit-panel
    width calc(100vw - 1rem)
    max-height calc(100vh - 1.2rem)

  .image-preview-overlay
    padding 0.7rem

  .image-preview-image
    max-width calc(100vw - 1.6rem)
    max-height calc(100vh - 5.1rem)

  .image-preview-close
    top 0.56rem
    right 0.56rem

  .meta-grid
    grid-template-columns 1fr

  .editor-top
    flex-direction column
    align-items flex-start

  :global(.toastui-editor-defaultUI-toolbar)
    padding 0.42rem 0.45rem !important

  :global(.toastui-editor-toolbar)
    gap 0.2rem

  :global(.toastui-editor-toolbar-group)
    gap 0.1rem
    margin-right 0.14rem
    padding 0.1rem

  :global(.toastui-editor-defaultUI-toolbar button)
    width 1.9rem !important
    height 1.9rem !important

  :global(.toastui-editor-toolbar-divider)
    margin 0 0.05rem !important
</style>
