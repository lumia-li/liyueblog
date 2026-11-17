/**
 * Paintlab 页面逻辑（主题内嵌版）
 * - 内容区是缩略画廊：上传后按上传顺序逐张自动绘制（2× 速），全部完成即停
 * - 点击任意缩略图打开弹层看大图，弹层内重新绘制
 * - 站点用 swup 无刷新切页，本模块只在页面首次加载执行一次，
 *   所以初始化必须能被 swup 的 page:view 反复调用（幂等 + 旧实例清理）
 */
import { analyze, type PaintData } from "./analyze";
import { maybeCelebrate } from "./celebrate";
import { createPainter, decodeImage, type Painter } from "./painter";
import {
	clearAll as clearStored,
	loadAll,
	put as putStored,
	removeOne,
	type StoredItem,
} from "./storage";

const DEFAULT_SPEED = 2;
const GAP_MS = 650;
const SPEED_STORAGE_KEY = "paintlab:speed";

/** 图片格式白名单（只接受这几种，避免解码失败或超大文件拖垮页面） */
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const ALLOWED_LABEL = "PNG / JPG / WEBP / GIF";
/** 数量与体积上限：太多会把主线程压垮 */
const MAX_IMAGES = 12;
const MAX_FILE_MB = 20;

type ItemState = "queued" | "analyzing" | "ready" | "playing" | "done" | "failed";

interface PaintItem {
	/** IndexedDB 主键，同时用于恢复与删除 */
	id: string;
	/** 上传顺序，恢复后保持原排列 */
	order: number;
	blob: Blob;
	url: string;
	name: string;
	size: number;
	w: number;
	h: number;
	data: PaintData | null;
	state: ItemState;
	card: HTMLElement;
	/** 缩略图容器，用于按图片真实比例设置高度 */
	thumbEl: HTMLElement;
	canvas: HTMLCanvasElement;
	subEl: HTMLElement;
	stateEl: HTMLElement;
	/** 状态右侧的细进度条 */
	meterEl: HTMLElement;
	/** 画完时播放的对号动画 */
	checkEl: HTMLElement;
	hintEl: HTMLElement;
	painter: Painter;
}

interface Cleanup {
	(): void;
}

declare global {
	interface Window {
		__paintlabCleanup?: Cleanup;
		__paintlabSwupHooked?: boolean;
	}
}

type SwupLike = { hooks?: { on: (event: string, fn: () => void) => void } };

function getSwup(): SwupLike | undefined {
	return (window as unknown as { swup?: SwupLike }).swup;
}

function el<T extends Element>(root: ParentNode, id: string): T | null {
	return root.querySelector<T>(`#${id}`);
}

function must<T extends Element>(root: ParentNode, id: string): T {
	const node = el<T>(root, id);
	if (!node) throw new Error(`Paintlab 缺少元素 #${id}`);
	return node;
}

const fmtMs = (ms: number): string => {
	const s = Math.round(ms / 1000);
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const fmtBytes = (n: number): string => {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/** 初始化一份页面实例；swup 切页（含缓存 DOM）后会再次调用 */
let mountedRoot: HTMLElement | null = null;
let lastMountAt = 0;

export function mountPaintlab(): void {
	const root = document.getElementById("paintlab-app");
	if (!root) return;

	// swup 首次加载与 page:view 可能对同一次进入连发两次，去重
	const now = Date.now();
	if (mountedRoot === root && now - lastMountAt < 300) return;
	mountedRoot = root;
	lastMountAt = now;

	// 上一次实例（切页前）需要停掉动画与定时器
	window.__paintlabCleanup?.();

	const drop = must<HTMLElement>(root, "paintlab-drop");
	const fileInput = must<HTMLInputElement>(root, "paintlab-file");
	const gallery = must<HTMLElement>(root, "paintlab-gallery");
	const galleryEmpty = must<HTMLElement>(root, "paintlab-empty");
	const countImgs = must<HTMLElement>(root, "paintlab-count-imgs");
	const countStrokes = must<HTMLElement>(root, "paintlab-count-strokes");
	const titleState = must<HTMLElement>(root, "paintlab-state");
	const saveTip = must<HTMLElement>(root, "paintlab-save");
	const replayAll = must<HTMLButtonElement>(root, "paintlab-replay");
	const clearAll = must<HTMLButtonElement>(root, "paintlab-clear");

	// ===== 瀑布流布局：卡片按「当前最矮的列」分配，图片高度各自不同 =====
	let columnEls: HTMLElement[] = [];

	/** 按容器宽度决定列数：手机 1 列、平板 2 列、桌面 3 列 */
	function desiredColumns(): number {
		const w = gallery.clientWidth || 900;
		if (w < 520) return 1;
		if (w < 840) return 2;
		return 3;
	}

	/** 保证列容器数量正确（重建会清空画廊，调用方需重新插入卡片） */
	function ensureColumns(): void {
		const need = desiredColumns();
		if (columnEls.length === need && columnEls.every((c) => c.isConnected)) return;
		gallery.innerHTML = "";
		columnEls = [];
		for (let i = 0; i < need; i += 1) {
			const col = document.createElement("div");
			col.className = "paintlab-col";
			gallery.appendChild(col);
			columnEls.push(col);
		}
	}

	/** 取当前最矮的一列 */
	function shortestColumn(): HTMLElement {
		ensureColumns();
		let best = columnEls[0];
		let min = Infinity;
		for (const col of columnEls) {
			const h = col.getBoundingClientRect().height;
			if (h < min) {
				min = h;
				best = col;
			}
		}
		return best;
	}

	function appendCard(card: HTMLElement): void {
		shortestColumn().appendChild(card);
	}

	/** 清空所有列并重置列引用（下一次 append 会重新建列） */
	function resetColumns(): void {
		gallery.innerHTML = "";
		columnEls = [];
	}

	/** 列数变化后按原顺序重新分配所有卡片 */
	function relayoutGallery(): void {
		const cards = items.map((it) => it.card);
		ensureColumns();
		columnEls.forEach((col) => {
			col.innerHTML = "";
		});
		for (const card of cards) appendCard(card);
	}

	// 主题里有带 transform 的祖先，position:fixed 会相对它定位而不是视口，所以把弹层挪到 body。
	// swup 命中缓存时 DOM 会被复用，弹层可能已经挂在 body 上，直接复用同一个节点。
	const lightbox = (document.getElementById("paintlab-lightbox") ??
		must<HTMLElement>(root, "paintlab-lightbox")) as HTMLElement;
	document.querySelectorAll("#paintlab-lightbox").forEach((node) => {
		if (node !== lightbox) node.remove();
	});
	document.body.appendChild(lightbox);

	const lbStage = must<HTMLElement>(lightbox, "paintlab-lb-stage");
	const lbCanvas = must<HTMLCanvasElement>(lightbox, "paintlab-lb-canvas");
	const lbCtx = lbCanvas.getContext("2d");
	const lbInfo = must<HTMLElement>(lightbox, "paintlab-lb-info");
	const lbReplay = must<HTMLButtonElement>(lightbox, "paintlab-lb-replay");
	const lbClose = must<HTMLButtonElement>(lightbox, "paintlab-lb-close");
	const lbPlay = must<HTMLButtonElement>(lightbox, "paintlab-lb-play");
	const lbSeek = must<HTMLInputElement>(lightbox, "paintlab-lb-seek");
	const lbTime = must<HTMLElement>(lightbox, "paintlab-lb-time");
	const lbCmp = must<HTMLButtonElement>(lightbox, "paintlab-lb-cmp");
	const lbImage = must<HTMLImageElement>(lightbox, "paintlab-lb-image");
	const lbSpeed = must<HTMLSelectElement>(lightbox, "paintlab-lb-speed");

	let items: PaintItem[] = [];
	let currentIndex = -1;
	let sequenceRunning = false;
	let sequenceToken = 0;
	let analyzingQueue = false;
	let lightboxIndex = -1;
	let gapTimer = 0;

	// 播放倍数：全局生效（缩略图连播 + 弹层大图），并记住上次选择
	let speed = DEFAULT_SPEED;
	try {
		const saved = Number(localStorage.getItem(SPEED_STORAGE_KEY));
		if (saved > 0) speed = saved;
	} catch {
		// 隐私模式下 localStorage 不可用，用默认值
	}
	lbSpeed.value = String(speed);

	let saveTipTimer = 0;
	/** 保存状态提示：saved 时 2 秒后自动回到默认文案 */
	function setSaveState(
		text: string,
		state: "idle" | "saved" | "error" = "idle",
		holdMs = 2200,
	): void {
		saveTip.textContent = text;
		saveTip.dataset.state = state;
		window.clearTimeout(saveTipTimer);
		if (state !== "idle") {
			saveTipTimer = window.setTimeout(() => {
				saveTip.textContent = "数据保存在本机浏览器";
				saveTip.dataset.state = "idle";
			}, holdMs);
		}
	}

	/** 把一张图（含分析结果）写进 IndexedDB */
	function persist(item: PaintItem): void {
		const record: StoredItem = {
			id: item.id,
			name: item.name,
			size: item.size,
			type: item.blob.type,
			order: item.order,
			addedAt: Date.now(),
			blob: item.blob,
			data: item.data,
		};
		void putStored(record).then((ok) => {
			if (ok) setSaveState("已保存 · 刷新后仍保留", "saved");
			else setSaveState("存储空间不足，这张未能保存", "error");
		});
	}

	const lbPainter = createPainter({
		canvas: lbCanvas,
		onTick: (tick) => {
			lbSeek.value = String(Math.round(tick.ratio * 10000));
			lbTime.textContent = `${fmtMs(tick.current)} / ${fmtMs(tick.total)}`;
			lbPlay.textContent = tick.playing ? "⏸ 暂停" : "▶ 播放";
		},
		onDone: () => {
			if (lightboxIndex >= 0) setState(items[lightboxIndex], "done");
			maybeCelebrate();
		},
	});
	lbPainter.setSpeed(speed);

	function setState(item: PaintItem | undefined, state: ItemState, extra?: string): void {
		if (!item) return;
		item.state = state;
		const labels: Record<ItemState, string> = {
			queued: "排队中",
			analyzing: extra || "分析中…",
			ready: "待绘制",
			playing: "绘制中",
			done: "已完成",
			failed: extra || "分析失败",
		};
		item.stateEl.textContent = labels[state];
		item.stateEl.dataset.state = state;
	}

	/** 画完：细进度条向右收回 + 播放对号动画 */
	function finishAnimation(item: PaintItem): void {
		const fill = item.meterEl.querySelector("i") as HTMLElement | null;
		if (fill) fill.style.width = "100%";
		item.meterEl.hidden = false;
		item.meterEl.classList.add("is-collapsing");
		window.setTimeout(() => {
			item.meterEl.hidden = true;
			item.meterEl.classList.remove("is-collapsing");
			if (fill) fill.style.width = "0%";
		}, 460);

		// 对号常驻：画完后一直保留，直到重新播放或删除
		item.checkEl.classList.remove("is-playing", "is-visible");
		void item.checkEl.offsetWidth;
		item.checkEl.classList.add("is-visible", "is-playing");
	}

	function resetMeter(item: PaintItem): void {
		const fill = item.meterEl.querySelector("i") as HTMLElement | null;
		if (fill) fill.style.width = "0%";
		item.meterEl.hidden = true;
		item.meterEl.classList.remove("is-collapsing");
		item.checkEl.classList.remove("is-visible", "is-playing");
	}

	function refreshTotals(): void {
		const strokes = items.reduce((sum, it) => sum + (it.data ? it.data.s.length : 0), 0);
		countImgs.textContent = String(items.length);
		countStrokes.textContent = strokes.toLocaleString("en-US");
		galleryEmpty.hidden = items.length > 0;
		gallery.hidden = items.length === 0;
		clearAll.disabled = items.length === 0;
		replayAll.disabled = !items.some((it) => it.data);
	}

	function updateTitleState(): void {
		if (!items.length) {
			titleState.textContent = "等待上传";
			return;
		}
		const ready = items.filter((it) => it.data).length;
		if (ready < items.length) {
			titleState.textContent = `分析中 ${ready}/${items.length}`;
			return;
		}
		if (sequenceRunning) {
			titleState.textContent = `绘制中 ${currentIndex + 1}/${items.length}`;
			return;
		}
		const allDone = items.every((it) => it.state === "done");
		titleState.textContent = allDone ? "全部完成 · 点击任意图片重播" : `${items.length} 张就绪`;
	}

	function highlight(index: number): void {
		items.forEach((it, i) => {
			it.card.classList.toggle("paintlab-active", i === index);
		});
	}

	function createItem(blob: Blob, saved?: StoredItem): PaintItem {
		const name = saved?.name || (blob instanceof File ? blob.name : "") || "粘贴的图片";
		const size = saved?.size ?? blob.size;
		const id = saved?.id ?? `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
		const order = saved?.order ?? Date.now();
		const url = URL.createObjectURL(blob);
		const card = document.createElement("div");
		card.className = "paintlab-card";
		card.title = "点击查看大图";
		card.setAttribute("role", "button");
		card.setAttribute("tabindex", "0");

		const thumb = document.createElement("span");
		thumb.className = "paintlab-thumb";
		const canvas = document.createElement("canvas");
		const hint = document.createElement("span");
		hint.className = "paintlab-thumb-hint";
		hint.textContent = "等待分析";
		thumb.append(canvas, hint);

		const meta = document.createElement("span");
		meta.className = "paintlab-meta";
		const nameEl = document.createElement("span");
		nameEl.className = "paintlab-name";
		nameEl.textContent = name;
		const subEl = document.createElement("span");
		subEl.className = "paintlab-sub";
		subEl.textContent = saved?.data
			? `${saved.data.w}×${saved.data.h} · ${saved.data.s.length.toLocaleString("en-US")} 笔 · ${fmtMs(saved.data.total)}`
			: `${fmtBytes(size)} · 等待分析`;
		meta.append(nameEl);

		const stateEl = document.createElement("span");
		stateEl.className = "paintlab-tag";

		// 状态行：状态文字 + 绘制中的细进度条 + 画完的对号
		const meter = document.createElement("span");
		meter.className = "paintlab-meter";
		meter.hidden = true;
		const meterFill = document.createElement("i");
		meter.appendChild(meterFill);

		const check = document.createElement("span");
		check.className = "paintlab-check";
		check.innerHTML =
			'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M7 12.6l3.1 3.1L17 9.2"></path></svg>';

		const statusRow = document.createElement("span");
		statusRow.className = "paintlab-status";
		statusRow.append(stateEl, meter, check);
		// 状态 + 进度条贴在文件名右侧，尺寸信息另起一行
		meta.append(statusRow);
		card.append(thumb, meta, subEl);

		// 删除按钮：平时隐藏，鼠标靠近卡片才出现；点一次进入确认态，再点才真正删除
		const del = document.createElement("button");
		del.type = "button";
		del.className = "paintlab-del";
		del.title = "删除这张";
		del.textContent = "×";
		card.appendChild(del);

		// 已知尺寸（刷新恢复）时直接按真实比例占位，避免先闪一下 16:10
		if (saved?.data?.w && saved?.data?.h) {
			thumb.style.aspectRatio = `${saved.data.w} / ${saved.data.h}`;
		}
		appendCard(card);

		const painter = createPainter({
			canvas,
			onTick: (tick) => {
				if (!tick.playing) return;
				meter.hidden = false;
				meterFill.style.width = `${Math.round(tick.ratio * 100)}%`;
			},
			onDone: () => {
				const target = items.find((it) => it.card === card);
				if (!target) return;
				setState(target, "done");
				finishAnimation(target);
				// 画完一张 -> 有一定概率放烟花（不是每张都放）
				maybeCelebrate();
				// 当前正在播的那张画完 -> 推进到下一张（全部播完自动停止）
				if (sequenceRunning && items.indexOf(target) === currentIndex) advanceSequence();
			},
		});
		painter.setSpeed(speed);

		const item: PaintItem = {
			id,
			order,
			blob,
			url,
			name,
			size,
			w: saved?.data?.w ?? 0,
			h: saved?.data?.h ?? 0,
			data: saved?.data ?? null,
			state: "queued",
			card,
			thumbEl: thumb,
			canvas,
			subEl,
			stateEl,
			meterEl: meter,
			checkEl: check,
			hintEl: hint,
			painter,
		};

		card.addEventListener("click", () => {
			if (!item.data) return;
			openLightbox(items.indexOf(item));
		});
		card.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			if (item.data) openLightbox(items.indexOf(item));
		});

		let confirmTimer = 0;
		del.addEventListener("click", (event) => {
			event.stopPropagation();
			if (!del.classList.contains("is-confirm")) {
				del.classList.add("is-confirm");
				del.textContent = "确认删除";
				window.clearTimeout(confirmTimer);
				confirmTimer = window.setTimeout(() => {
					del.classList.remove("is-confirm");
					del.textContent = "×";
				}, 3000);
				return;
			}
			window.clearTimeout(confirmTimer);
			removeItem(item);
		});

		if (saved?.data) {
			// 本地已缓存分析结果：直接把完整画面铺上去，
			// 而不是留一张空白纸（否则看起来像「还在绘制、没内容」）
			setState(item, "done");
			hint.hidden = true;
			painter.showComplete(saved.data);
			// 恢复出来的图同样是「已完成」，对号直接常驻（不播动画）
			check.classList.add("is-visible");
		} else {
			setState(item, "queued");
		}
		return item;
	}

	function removeItem(item: PaintItem): void {
		const index = items.indexOf(item);
		if (index < 0) return;

		stopSequence();
		if (index === lightboxIndex) closeLightbox();

		items.splice(index, 1);
		item.painter.destroy();
		URL.revokeObjectURL(item.url);
		item.card.remove();
		// 本地存储里的记录一起删掉，刷新后不会再冒出来
		void removeOne(item.id);

		if (index === currentIndex) currentIndex = -1;
		else if (index < currentIndex) currentIndex -= 1;
		if (index < lightboxIndex) lightboxIndex -= 1;

		highlight(currentIndex);
		refreshTotals();
		updateTitleState();
	}

	function fitLightbox(): void {
		const item = items[lightboxIndex];
		if (!item?.data) return;
		const ratio = item.data.w / item.data.h;
		const maxW = Math.min(window.innerWidth * 0.9, 980);
		const maxH = window.innerHeight * 0.74;
		let width = maxW;
		let height = width / ratio;
		if (height > maxH) {
			height = maxH;
			width = height * ratio;
		}
		lbStage.style.width = `${Math.round(width)}px`;
		lbStage.style.height = `${Math.round(height)}px`;
	}

	function openLightbox(index: number): void {
		const item = items[index];
		if (!item?.data) return;
		lightboxIndex = index;
		lightbox.hidden = false;
		lightbox.classList.add("is-open");
		document.body.style.overflow = "hidden";
		// 全屏绘制时藏掉灯笼等页面装饰，避免挡住画面
		document.body.classList.add("paintlab-lb-open");
		lbPainter.load(item.data, { autoplay: true });
		fitLightbox();
		lbImage.src = item.url;
		lbStage.classList.remove("is-cmp");
		lbCmp.classList.remove("active");
		lbSeek.value = "0";
		const data = item.data;
		lbTime.textContent = `0:00 / ${fmtMs(data.total)}`;
		lbInfo.textContent = `${item.name} · ${item.w}×${item.h} · ${data.s.length.toLocaleString("en-US")} 笔 · ${fmtMs(data.total)}`;
	}

	function closeLightbox(): void {
		lightboxIndex = -1;
		lightbox.classList.remove("is-open");
		lightbox.hidden = true;
		document.body.style.overflow = "";
		document.body.classList.remove("paintlab-lb-open");
		lbStage.classList.remove("is-cmp");
		lbCmp.classList.remove("active");
		lbPainter.pause();
		lbCtx?.clearRect(0, 0, lbCanvas.width, lbCanvas.height);
	}

	function playItem(index: number): void {
		const item = items[index];
		if (!item?.data) return;
		currentIndex = index;
		highlight(index);
		item.hintEl.hidden = true;
		resetMeter(item);
		// 缩略图同样使用完整笔迹，小图上的细节与原版一致
		item.painter.setSpeed(speed);
		item.painter.load(item.data, { autoplay: true });
		setState(item, "playing");
		refreshTotals();
		updateTitleState();
	}

	function stopSequence(): void {
		sequenceRunning = false;
		sequenceToken += 1;
		window.clearTimeout(gapTimer);
	}

	function advanceSequence(): void {
		const token = sequenceToken;
		const playable = (it: PaintItem | undefined) => !!it && it.data !== null && it.state !== "done";

		// 先往后找，找不到再回头找前面被落下/被打断的图——保证「没画完的都会继续画」
		let next = items.findIndex(
			(it, i) => i > currentIndex && it.data !== null && it.state !== "done",
		);
		if (next < 0) {
			next = items.findIndex(
				(it, i) => i !== currentIndex && it.data !== null && it.state !== "done",
			);
		}

		if (next >= 0 && playable(items[next])) {
			gapTimer = window.setTimeout(() => {
				if (token !== sequenceToken) return;
				playItem(next);
			}, GAP_MS);
			return;
		}

		stopSequence();
		updateTitleState();
		const waiting = items.some((it) => it.state === "analyzing" || it.state === "queued");
		if (waiting) {
			// 还有图没分析完：等 runQueue 收尾时自动接着播
			titleState.textContent = "等待剩余图片分析…";
		}
	}

	function startSequence(from = 0): void {
		const first = items.findIndex((it, i) => i >= from && it.data !== null);
		if (first < 0) return;
		sequenceRunning = true;
		sequenceToken += 1;
		playItem(first);
	}

	function nextFrame(): Promise<void> {
		return new Promise((resolve) => {
			requestAnimationFrame(() => setTimeout(resolve, 0));
		});
	}

	async function runQueue(autoStart = true, fromIndex?: number): Promise<void> {
		if (analyzingQueue) return;
		analyzingQueue = true;
		try {
			for (;;) {
				const item = items.find((it) => it.state === "queued");
				if (!item) break;
				setState(item, "analyzing", "准备中…");
				updateTitleState();
				item.hintEl.hidden = false;
				item.hintEl.textContent = "分析中…";
				await nextFrame();
				try {
					const bitmap = await decodeImage(item.blob);
					item.w = bitmap.width;
					item.h = bitmap.height;
					const raw = analyze(bitmap, item.w, item.h, (text, pct) => {
						const label = pct ? `${text} ${pct}%` : text;
						setState(item, "analyzing", label);
						item.hintEl.textContent = label;
					});
					// 原样保留分析结果：不采样、不压时长，保证和原版 paintlab 的笔触密度一致
					item.data = raw;
					// 按图片真实宽高比调整缩略图容器，形成高低错落的瀑布流
					if (item.w && item.h) {
						item.thumbEl.style.aspectRatio = `${item.w} / ${item.h}`;
					}
					item.subEl.textContent = `${item.w}×${item.h} · ${item.data.s.length.toLocaleString("en-US")} 笔 · ${fmtMs(item.data.total)}`;
					setState(item, "ready");
					item.hintEl.textContent = "待绘制";
					// 分析结果一并落盘，下次打开可直接播放
					persist(item);
				} catch (error) {
					console.error(error);
					setState(item, "failed");
					item.subEl.textContent = "这张图读不出来，换一张试试";
					item.hintEl.textContent = "读取失败";
				}
				refreshTotals();
				updateTitleState();
				await nextFrame();
			}
		} finally {
			analyzingQueue = false;
		}

		if (autoStart && !sequenceRunning) {
			// 从第一张还没画完的开始（已画完的不重播），队列会依次把剩余的都播掉
			const from =
				fromIndex ??
				items.findIndex((it) => it.data !== null && it.state !== "done");
			if (from >= 0 && from < items.length) startSequence(from);
		}
	}

	function addFiles(fileList: FileList | null | undefined): void {
		const incoming = Array.from(fileList ?? []);
		if (!incoming.length) return;

		const rejectedType: string[] = [];
		const rejectedSize: string[] = [];
		const accepted: File[] = [];

		for (const file of incoming) {
			if (!ALLOWED_TYPES.includes(file.type)) {
				rejectedType.push(file.name || "未命名");
				continue;
			}
			if (file.size > MAX_FILE_MB * 1024 * 1024) {
				rejectedSize.push(file.name || "未命名");
				continue;
			}
			accepted.push(file);
		}

		const room = Math.max(0, MAX_IMAGES - items.length);
		const overflow = Math.max(0, accepted.length - room);
		const files = overflow > 0 ? accepted.slice(0, room) : accepted;

		if (rejectedType.length) {
			setSaveState(`已跳过 ${rejectedType.length} 张：仅支持 ${ALLOWED_LABEL}`, "error", 4200);
		} else if (rejectedSize.length) {
			setSaveState(`已跳过 ${rejectedSize.length} 张：单张不能超过 ${MAX_FILE_MB}MB`, "error", 4200);
		} else if (overflow > 0) {
			setSaveState(`最多 ${MAX_IMAGES} 张，已忽略多出的 ${overflow} 张`, "error", 4200);
		}

		if (!files.length) return;

		for (const file of files) {
			const item = createItem(file);
			items.push(item);
			// 先把原图存下来，即使分析失败/中途关页面也不会丢
			persist(item);
		}
		refreshTotals();
		updateTitleState();
		// 不打断正在画的那张：分析完后由队列依序补播所有未完成的图
		void runQueue();
	}

	const onDropClick = () => fileInput.click();
	const onDropKey = (event: KeyboardEvent) => {
		if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			fileInput.click();
		}
	};
	const onFileChange = () => {
		addFiles(fileInput.files);
		fileInput.value = "";
	};
	const onDragOver = (event: Event) => {
		event.preventDefault();
		drop.classList.add("is-over");
	};
	const onDragLeave = (event: Event) => {
		event.preventDefault();
		drop.classList.remove("is-over");
	};
	const onDropFiles = (event: DragEvent) => {
		event.preventDefault();
		drop.classList.remove("is-over");
		addFiles(event.dataTransfer?.files);
	};
	const onWindowDrop = (event: DragEvent) => {
		event.preventDefault();
		const target = event.target as HTMLElement | null;
		if (target?.closest(".paintlab-root")) return;
		addFiles(event.dataTransfer?.files);
	};
	const onPaste = (event: ClipboardEvent) => {
		const files = Array.from(event.clipboardData?.files ?? []);
		if (files.length) addFiles(event.clipboardData?.files);
	};
	const onLbClick = () => lbPainter.replay();
	const onLbPlay = (event: MouseEvent) => {
		event.stopPropagation();
		lbPainter.toggle();
	};
	const onLbSeek = () => {
		lbPainter.seekTo((Number(lbSeek.value) / 10000) * lbPainter.total);
	};
	const onSpeedChange = () => {
		const next = Number(lbSpeed.value);
		speed = next > 0 ? next : DEFAULT_SPEED;
		// 立即生效：弹层大图 + 所有缩略图实例
		lbPainter.setSpeed(speed);
		items.forEach((it) => it.painter.setSpeed(speed));
		try {
			localStorage.setItem(SPEED_STORAGE_KEY, String(speed));
		} catch {
			// 隐私模式下写入失败不影响播放
		}
	};
	const onLbCmp = (event: MouseEvent) => {
		event.stopPropagation();
		const on = lbStage.classList.toggle("is-cmp");
		lbCmp.classList.toggle("active", on);
	};
	const onLbReplay = (event: MouseEvent) => {
		event.stopPropagation();
		lbPainter.replay();
	};
	const onLbClose = (event: MouseEvent) => {
		event.stopPropagation();
		closeLightbox();
	};
	const onLbBackdrop = (event: MouseEvent) => {
		if (event.target === lightbox) closeLightbox();
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape" && lightboxIndex >= 0) closeLightbox();
	};
	const onReplayAll = () => {
		items.forEach((it) => {
			if (it.data) setState(it, "ready");
		});
		startSequence(0);
	};
	// 清空需要二次确认：点一次变「确认清空」，3 秒内再点才真正清空
	let clearConfirmTimer = 0;
	const resetClearButton = () => {
		window.clearTimeout(clearConfirmTimer);
		clearAll.classList.remove("is-confirm");
		clearAll.textContent = "清空";
	};
	const onClearAll = () => {
		if (!clearAll.classList.contains("is-confirm")) {
			clearAll.classList.add("is-confirm");
			clearAll.textContent = "确认清空";
			window.clearTimeout(clearConfirmTimer);
			clearConfirmTimer = window.setTimeout(resetClearButton, 3000);
			return;
		}

		resetClearButton();
		stopSequence();
		closeLightbox();
		items.forEach((it) => {
			it.painter.destroy();
			URL.revokeObjectURL(it.url);
		});
		items = [];
		currentIndex = -1;
		resetColumns();
		void clearStored();
		setSaveState("本地数据已清空", "saved");
		refreshTotals();
		updateTitleState();
	};

	// 打开页面时恢复上次的内容（放在最后，确保上面所有函数都已就绪）
	async function restoreSession(): Promise<void> {
		if (items.length) return;
		const rows = await loadAll();
		// 加载期间用户可能已经上传，避免混在一起
		if (!rows.length || items.length) return;
		for (const row of rows) {
			items.push(createItem(row.blob, row));
		}
		refreshTotals();
		updateTitleState();
		setSaveState(`已恢复上次的 ${rows.length} 张图片`, "saved", 6000);
		// 缺少分析结果的（例如上次没分析完）排队补算，但不自动开始播放
		if (items.some((it) => !it.data)) void runQueue(false);
	}
	let galleryResizeTimer = 0;
	const onResize = () => {
		if (lightboxIndex >= 0) fitLightbox();
		// 宽度变化可能改变列数，重新分配卡片
		window.clearTimeout(galleryResizeTimer);
		galleryResizeTimer = window.setTimeout(() => relayoutGallery(), 160);
	};

	// 缓存 DOM 被复用时要能一次性解绑旧监听，避免重复触发
	const controller = new AbortController();
	const listen = { signal: controller.signal };
	const preventDrag = (event: Event) => event.preventDefault();

	drop.addEventListener("click", onDropClick, listen);
	drop.addEventListener("keydown", onDropKey as EventListener, listen);
	drop.addEventListener("dragenter", onDragOver, listen);
	drop.addEventListener("dragover", onDragOver, listen);
	drop.addEventListener("dragleave", onDragLeave, listen);
	drop.addEventListener("drop", onDropFiles as EventListener, listen);
	fileInput.addEventListener("change", onFileChange, listen);
	window.addEventListener("dragover", preventDrag, listen);
	window.addEventListener("drop", onWindowDrop as EventListener, listen);
	document.addEventListener("paste", onPaste as EventListener, listen);
	lbStage.addEventListener("click", onLbClick, listen);
	lbPlay.addEventListener("click", onLbPlay, listen);
	lbSeek.addEventListener("input", onLbSeek, listen);
	lbCmp.addEventListener("click", onLbCmp, listen);
	lbSpeed.addEventListener("change", onSpeedChange, listen);
	lbReplay.addEventListener("click", onLbReplay, listen);
	lbClose.addEventListener("click", onLbClose, listen);
	lightbox.addEventListener("click", onLbBackdrop, listen);
	document.addEventListener("keydown", onKeyDown as EventListener, listen);
	window.addEventListener("resize", onResize, listen);
	replayAll.addEventListener("click", onReplayAll, listen);
	clearAll.addEventListener("click", onClearAll, listen);

	// 命中 swup 缓存时 DOM 是复用的，先把上一次的卡片清干净
	resetColumns();
	ensureColumns();
	lightbox.classList.remove("is-open");
	lightbox.hidden = true;

	refreshTotals();
	updateTitleState();
	// 恢复上次保存的图片与笔迹（异步，不阻塞首屏）
	void restoreSession();

	window.__paintlabCleanup = () => {
		controller.abort();
		stopSequence();
		lbPainter.destroy();
		items.forEach((it) => {
			it.painter.destroy();
			URL.revokeObjectURL(it.url);
		});
		items = [];
		document.body.style.overflow = "";
		document.body.classList.remove("paintlab-lb-open");
		lightbox.classList.remove("is-open");
		lightbox.hidden = true;
		lbCtx?.clearRect(0, 0, lbCanvas.width, lbCanvas.height);
		resetColumns();
	};
}

// 首次进入 + swup 切页回来都要能重新挂载
mountPaintlab();

const bindSwupHook = (): void => {
	const swup = getSwup();
	if (!swup?.hooks || window.__paintlabSwupHooked) return;
	window.__paintlabSwupHooked = true;
	swup.hooks.on("page:view", () => mountPaintlab());
};

// 本模块执行时 swup 可能还没初始化完，除了事件还应做一次延迟兜底
bindSwupHook();
if (!window.__paintlabSwupHooked) {
	document.addEventListener("swup:enable", bindSwupHook, { once: true });
	window.setTimeout(bindSwupHook, 800);
}
