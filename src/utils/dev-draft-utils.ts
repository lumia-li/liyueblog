export type DevDraftType = "post" | "thought";

export type DevDraft = {
	id: string;
	title: string;
	slug: string;
	originalSlug?: string;
	description: string;
	tags: string;
	category: string;
	image: string;
	draft: boolean;
	content: string;
	published?: string;
	/** 草稿类型：post = 文章，thought = 随笔（缺省按文章处理，兼容旧数据） */
	type?: DevDraftType;
	updatedAt: number;
};

export type DevDraftTrashItem = DevDraft & {
	trashedAt: number;
};

export const DEV_DRAFTS_UPDATED_EVENT = "dev-drafts-updated";
export const DEV_DRAFT_TRASH_UPDATED_EVENT = "dev-draft-trash-updated";

const DRAFTS_KEY = "dev-editor-drafts-v1";
const DRAFT_TRASH_KEY = "dev-editor-draft-trash-v1";
const LEGACY_DRAFT_KEY = "dev-editor-draft-v1";

function canUseStorage(): boolean {
	return (
		typeof window !== "undefined" && typeof window.localStorage !== "undefined"
	);
}

function emitDraftEvent(name: string): void {
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(name));
}

function parseDrafts(raw: string | null): DevDraft[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as DevDraft[];
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item) => item && typeof item.id === "string")
			.sort((a, b) => b.updatedAt - a.updatedAt);
	} catch {
		return [];
	}
}

function parseDraftTrash(raw: string | null): DevDraftTrashItem[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as DevDraftTrashItem[];
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter(
				(item) =>
					item &&
					typeof item.id === "string" &&
					typeof item.trashedAt === "number",
			)
			.sort((a, b) => b.trashedAt - a.trashedAt);
	} catch {
		return [];
	}
}

function writeDrafts(drafts: DevDraft[]): void {
	if (!canUseStorage()) return;
	localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts));
	emitDraftEvent(DEV_DRAFTS_UPDATED_EVENT);
}

function writeDraftTrash(items: DevDraftTrashItem[]): void {
	if (!canUseStorage()) return;
	localStorage.setItem(DRAFT_TRASH_KEY, JSON.stringify(items));
	emitDraftEvent(DEV_DRAFT_TRASH_UPDATED_EVENT);
}

export function listDrafts(): DevDraft[] {
	if (!canUseStorage()) return [];
	return parseDrafts(localStorage.getItem(DRAFTS_KEY));
}

export function listDraftTrash(): DevDraftTrashItem[] {
	if (!canUseStorage()) return [];
	return parseDraftTrash(localStorage.getItem(DRAFT_TRASH_KEY));
}

export function getDraftById(id: string): DevDraft | null {
	return listDrafts().find((item) => item.id === id) || null;
}

export function getDraftTrashById(id: string): DevDraftTrashItem | null {
	return listDraftTrash().find((item) => item.id === id) || null;
}

export function saveDraft(input: Omit<DevDraft, "updatedAt">): {
	id: string;
	updatedAt: number;
} {
	const now = Date.now();
	const next: DevDraft = {
		...input,
		updatedAt: now,
	};
	const drafts = listDrafts().filter((item) => item.id !== input.id);
	drafts.unshift(next);
	writeDrafts(drafts);

	const trash = listDraftTrash();
	if (trash.some((item) => item.id === input.id)) {
		writeDraftTrash(trash.filter((item) => item.id !== input.id));
	}

	return { id: input.id, updatedAt: now };
}

export function removeDraft(id: string): void {
	const drafts = listDrafts().filter((item) => item.id !== id);
	writeDrafts(drafts);
}

export function moveDraftToTrash(id: string): DevDraftTrashItem | null {
	const draft = getDraftById(id);
	if (!draft) return null;

	const trashItem: DevDraftTrashItem = {
		...draft,
		trashedAt: Date.now(),
	};
	const drafts = listDrafts().filter((item) => item.id !== id);
	const trash = listDraftTrash().filter((item) => item.id !== id);
	trash.unshift(trashItem);
	writeDrafts(drafts);
	writeDraftTrash(trash);
	return trashItem;
}

export function restoreDraftFromTrash(id: string): DevDraft | null {
	const draft = getDraftTrashById(id);
	if (!draft) return null;

	const rest = {
		id: draft.id,
		title: draft.title,
		slug: draft.slug,
		originalSlug: draft.originalSlug,
		description: draft.description,
		tags: draft.tags,
		category: draft.category,
		image: draft.image,
		draft: draft.draft,
		content: draft.content,
		published: draft.published,
		type: draft.type,
	};
	saveDraft({
		...rest,
	});
	return getDraftById(id);
}

export function removeDraftTrash(id: string): boolean {
	const trash = listDraftTrash();
	if (!trash.some((item) => item.id === id)) {
		return false;
	}
	writeDraftTrash(trash.filter((item) => item.id !== id));
	return true;
}

export function migrateLegacyDraft(): void {
	if (!canUseStorage()) return;
	const legacyRaw = localStorage.getItem(LEGACY_DRAFT_KEY);
	if (!legacyRaw) return;
	try {
		const legacy = JSON.parse(legacyRaw) as Partial<DevDraft>;
		const id =
			typeof legacy.slug === "string" && legacy.slug.trim()
				? legacy.slug.trim()
				: `legacy-${Date.now()}`;
		saveDraft({
			id,
			title: legacy.title || "",
			slug: legacy.slug || "",
			originalSlug:
				typeof legacy.originalSlug === "string" ? legacy.originalSlug : "",
			description: legacy.description || "",
			tags: legacy.tags || "",
			category: legacy.category || "",
			image: legacy.image || "",
			draft: Boolean(legacy.draft),
			content: legacy.content || "",
			published: typeof legacy.published === "string" ? legacy.published : "",
			type: "post",
		});
		localStorage.removeItem(LEGACY_DRAFT_KEY);
	} catch {
		localStorage.removeItem(LEGACY_DRAFT_KEY);
	}
}
