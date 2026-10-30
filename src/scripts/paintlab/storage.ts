/**
 * Paintlab 本地持久化
 * - 图片与笔迹数据体积大（单张几 MB），放 IndexedDB
 * - 标题、播放倍数这类小状态放 localStorage
 * - 所有读写都做了容错：IndexedDB 不可用（隐私模式/老浏览器）时返回 null，
 *   localStorage 数据损坏（JSON 解析失败）时自动清掉再返回 null
 */
import type { PaintData } from "./analyze";

export interface StoredItem {
	id: string;
	name: string;
	size: number;
	type: string;
	/** 上传顺序，用于恢复时保持原来的排列 */
	order: number;
	addedAt: number;
	blob: Blob;
	/** 分析结果；有值恢复时可直接播放，没值则重新分析 */
	data: PaintData | null;
}

const DB_NAME = "paintlab";
const DB_VERSION = 1;
const STORE = "items";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDB(): Promise<IDBDatabase | null> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise((resolve) => {
		try {
			if (typeof indexedDB === "undefined") {
				resolve(null);
				return;
			}
			const request = indexedDB.open(DB_NAME, DB_VERSION);
			request.onupgradeneeded = () => {
				const db = request.result;
				if (!db.objectStoreNames.contains(STORE)) {
					db.createObjectStore(STORE, { keyPath: "id" });
				}
			};
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => resolve(null);
			request.onblocked = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
	return dbPromise;
}

async function run<T>(
	mode: IDBTransactionMode,
	action: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
	const db = await openDB();
	if (!db) return null;
	return new Promise((resolve) => {
		try {
			const tx = db.transaction(STORE, mode);
			const request = action(tx.objectStore(STORE));
			request.onsuccess = () => resolve(request.result as T);
			request.onerror = () => resolve(null);
			tx.onabort = () => resolve(null);
		} catch {
			resolve(null);
		}
	});
}

/** 读取全部已保存的图片，按上传顺序排序；损坏记录会被过滤并顺手删除 */
export async function loadAll(): Promise<StoredItem[]> {
	const rows = await run<StoredItem[]>("readonly", (store) => store.getAll());
	if (!Array.isArray(rows)) return [];

	const valid: StoredItem[] = [];
	const brokenIds: string[] = [];
	for (const row of rows) {
		const ok =
			!!row && row.blob instanceof Blob && typeof row.id === "string" && row.id.length > 0;
		if (ok) valid.push(row);
		else if (row && typeof row.id === "string" && row.id) brokenIds.push(row.id);
	}
	// 数据损坏时不要让坏记录反复参与加载
	for (const id of brokenIds) {
		void run("readwrite", (store) => store.delete(id));
	}

	return valid.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

/** 写入/更新一条记录；返回 false 表示写入失败（配额不足或 IndexedDB 不可用） */
export async function put(item: StoredItem): Promise<boolean> {
	const result = await run<IDBValidKey>("readwrite", (store) => store.put(item));
	return result !== null;
}

export async function removeOne(id: string): Promise<void> {
	await run("readwrite", (store) => store.delete(id));
}

export async function clearAll(): Promise<void> {
	await run("readwrite", (store) => store.clear());
}

export function readJSON<T>(key: string): T | null {
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		return JSON.parse(raw) as T;
	} catch {
		// 数据损坏：清掉，避免每次都解析失败
		try {
			localStorage.removeItem(key);
		} catch {
			// 忽略
		}
		return null;
	}
}

export function writeJSON(key: string, value: unknown): boolean {
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}

export function readText(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

export function writeText(key: string, value: string): boolean {
	try {
		localStorage.setItem(key, value);
		return true;
	} catch {
		return false;
	}
}
