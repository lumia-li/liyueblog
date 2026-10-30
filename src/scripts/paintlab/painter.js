/**
 * 笔迹播放器（Canvas 版）
 * 原先每个笔迹是一个 <svg><path>，一张图 2.8 万个节点，滚动/播放都卡。
 * 现在整个画面只用 1 个 <canvas>：
 *   - 「已完成」的笔迹累积画进离屏 canvas，每帧直接 drawImage 贴回来
 *   - 每帧只额外绘制「当前正在画的那一笔」
 *   - 回退（拖动进度）时才重建底图
 * 线宽、圆头圆角、颜色与原 SVG 版一致，画质不变。
 */

/** 把 Blob / Image 解码成可读取像素的位图 */
export async function decodeImage(source) {
	if (source instanceof Blob) {
		try {
			return await createImageBitmap(source, { imageOrientation: "from-image" });
		} catch {
			return await createImageBitmap(source);
		}
	}
	return source;
}

function clamp(v, a, b) {
	return v < a ? a : v > b ? b : v;
}

export function createPainter(options) {
	const canvas = options.canvas;
	const ctx = canvas.getContext("2d");
	const onTick = options.onTick || function () {};
	const onDone = options.onDone || function () {};
	const showTip = options.tip !== false;

	/** 底图：累积所有已经画完的笔迹 */
	const base = document.createElement("canvas");
	const bctx = base.getContext("2d");

	let STROKES = [];
	let T0 = new Float64Array(0);
	let DUR = new Float64Array(0);
	let LO = null;
	let N = 0;
	let TOTAL = 0;
	let DATA = null;
	let T = 0;
	let playing = false;
	let lastTs = 0;
	let speed = 2;
	let rafId = 0;
	let destroyed = false;
	/** 底图里已经画到第几笔（-1 表示空） */
	let baseDone = -1;
	let tf = { s: 1, ox: 0, oy: 0 };

	function ease(p) {
		return 1 - Math.pow(1 - p, 1.7);
	}

	function strokeAt(tt) {
		let lo = 0;
		let hi = N - 1;
		let r = -1;
		while (lo <= hi) {
			const m = (lo + hi) >> 1;
			if (T0[m] <= tt) {
				r = m;
				lo = m + 1;
			} else {
				hi = m - 1;
			}
		}
		return r;
	}

	function layerName(idx) {
		if (!DATA || idx < 0 || !LO || !DATA.layers || !DATA.layers.length) return "";
		const layer = DATA.layers[LO[idx]];
		return layer ? layer[1] : "";
	}

	function emit(idx) {
		onTick({
			current: T,
			total: TOTAL,
			strokes: N,
			index: idx,
			playing: playing,
			layer: layerName(idx),
			ratio: TOTAL > 0 ? clamp(T / TOTAL, 0, 1) : 0,
		});
	}

	/** 画一笔；frac < 1 时只画到对应长度比例 */
	function paintStroke(c, stroke, frac) {
		const pts = stroke.pts;
		const count = pts.length / 2;
		if (!count) return;
		const { s, ox, oy } = tf;
		c.strokeStyle = stroke.color;
		c.lineWidth = Math.max(0.35, stroke.w * s);
		c.lineCap = "round";
		c.lineJoin = "round";
		c.beginPath();
		c.moveTo(ox + pts[0] * s, oy + pts[1] * s);

		if (frac >= 1) {
			for (let i = 1; i < count; i += 1) {
				c.lineTo(ox + pts[2 * i] * s, oy + pts[2 * i + 1] * s);
			}
		} else {
			const want = stroke.len * frac;
			let acc = 0;
			for (let i = 1; i < count; i += 1) {
				const x1 = pts[2 * i - 2];
				const y1 = pts[2 * i - 1];
				const x2 = pts[2 * i];
				const y2 = pts[2 * i + 1];
				const seg = Math.hypot(x2 - x1, y2 - y1);
				if (acc + seg >= want) {
					const r = seg > 0 ? (want - acc) / seg : 1;
					c.lineTo(ox + (x1 + (x2 - x1) * r) * s, oy + (y1 + (y2 - y1) * r) * s);
					c.stroke();
					return;
				}
				c.lineTo(ox + x2 * s, oy + y2 * s);
				acc += seg;
			}
		}
		c.stroke();
	}

	function drawTip(idx, frac) {
		const pts = STROKES[idx].pts;
		const count = pts.length / 2;
		if (!count) return;
		const { s, ox, oy } = tf;
		const want = STROKES[idx].len * frac;
		let acc = 0;
		let x = pts[0];
		let y = pts[1];
		for (let i = 1; i < count; i += 1) {
			const x1 = pts[2 * i - 2];
			const y1 = pts[2 * i - 1];
			const x2 = pts[2 * i];
			const y2 = pts[2 * i + 1];
			const seg = Math.hypot(x2 - x1, y2 - y1);
			if (acc + seg >= want) {
				const r = seg > 0 ? (want - acc) / seg : 1;
				x = x1 + (x2 - x1) * r;
				y = y1 + (y2 - y1) * r;
				break;
			}
			acc += seg;
			x = x2;
			y = y2;
		}
		ctx.beginPath();
		ctx.arc(ox + x * s, oy + y * s, Math.max(1.5, 2.2 * s), 0, Math.PI * 2);
		ctx.fillStyle = "rgba(40, 48, 60, 0.5)";
		ctx.fill();
	}

	/** 把底图重建到第 target 笔（含） */
	function rebuildBase(target) {
		bctx.clearRect(0, 0, base.width, base.height);
		for (let i = 0; i <= target; i += 1) paintStroke(bctx, STROKES[i], 1);
		baseDone = target;
	}

	function computeTransform() {
		if (!DATA || !canvas.width || !canvas.height) return;
		const s = Math.min(canvas.width / DATA.w, canvas.height / DATA.h);
		tf = {
			s,
			ox: (canvas.width - DATA.w * s) / 2,
			oy: (canvas.height - DATA.h * s) / 2,
		};
	}

	/** 按当前画布尺寸重新配置（含高分屏适配） */
	function resizeCanvas() {
		const rect = canvas.getBoundingClientRect();
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		// CSS 尺寸取整，再乘 DPR：保证 1 个 CSS 像素正好对应整数个物理像素。
		// 否则容器高度带小数（如 421.5px）时，每帧重绘的细线会按非整数比例重采样，
		// 视觉上就是画面在轻微抖动/闪烁。
		const cssW = Math.max(1, Math.round(rect.width));
		const cssH = Math.max(1, Math.round(rect.height));
		const width = cssW * dpr;
		const height = cssH * dpr;
		if (width === canvas.width && height === canvas.height) {
			computeTransform();
			return;
		}
		canvas.width = width;
		canvas.height = height;
		canvas.style.width = `${cssW}px`;
		canvas.style.height = `${cssH}px`;
		base.width = width;
		base.height = height;
		computeTransform();
		if (DATA) {
			const target = baseDone;
			rebuildBase(target >= 0 ? target : -1);
			render();
		}
	}

	function render() {
		if (!DATA || destroyed) return;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (baseDone >= 0) ctx.drawImage(base, 0, 0);
		const idx = strokeAt(T);
		if (idx >= 0) {
			const f = Math.min(1, (T - T0[idx]) / DUR[idx]);
			paintStroke(ctx, STROKES[idx], f);
			if (showTip) drawTip(idx, f);
		}
		emit(idx);
	}

	function syncTo(tt) {
		const idx = strokeAt(tt);
		const target = idx - 1;
		if (target > baseDone) {
			for (let i = baseDone + 1; i <= target; i += 1) paintStroke(bctx, STROKES[i], 1);
			baseDone = target;
		} else if (target < baseDone) {
			// 回退：底图需要重建（低频操作）
			rebuildBase(target);
		}
		render();
	}

	function loop(now) {
		if (!playing || destroyed) return;
		const dt = lastTs ? now - lastTs : 0;
		lastTs = now;
		T += dt * speed;
		if (T >= TOTAL) {
			T = TOTAL;
			syncTo(T);
			pause();
			onDone();
			return;
		}
		syncTo(T);
		rafId = requestAnimationFrame(loop);
	}

	function play() {
		if (!N || destroyed) return;
		if (T >= TOTAL) {
			T = 0;
			syncTo(0);
		}
		playing = true;
		lastTs = 0;
		render();
		rafId = requestAnimationFrame(loop);
	}

	function pause() {
		playing = false;
		cancelAnimationFrame(rafId);
		lastTs = 0;
		emit(strokeAt(T));
	}

	function toggle() {
		if (playing) pause();
		else play();
	}

	function seekTo(ms) {
		T = clamp(ms, 0, TOTAL);
		syncTo(T);
		render();
	}

	function replay() {
		T = 0;
		syncTo(0);
		play();
	}

	function setSpeed(v) {
		speed = v > 0 ? v : 1;
	}

	function load(data, opts) {
		const autoplay = !opts || opts.autoplay !== false;
		DATA = data;
		N = data.s.length;

		STROKES = new Array(N);
		T0 = new Float64Array(N);
		DUR = new Float64Array(N);
		LO = new Int32Array(N);

		let t = 0;
		let li = 0;
		for (let i = 0; i < N; i += 1) {
			const a = data.s[i];
			const dur = Math.max(a[2], 1);
			const pts = [];
			for (let j = 4; j < a.length; j += 2) pts.push(a[j], a[j + 1]);
			let len = 0;
			for (let q = 2; q < pts.length; q += 2) {
				len += Math.hypot(pts[q] - pts[q - 2], pts[q + 1] - pts[q - 1]);
			}
			if (len < 0.01) len = 0.01;
			STROKES[i] = { pts, w: a[0], color: a[3], len };
			T0[i] = t;
			DUR[i] = dur;
			t += dur;
			while (li + 1 < data.layers.length && i >= data.layers[li][3]) li += 1;
			LO[i] = li;
		}
		TOTAL = t;

		T = 0;
		playing = false;
		lastTs = 0;
		cancelAnimationFrame(rafId);
		baseDone = -1;
		resizeCanvas();
		computeTransform();
		render();
		if (autoplay) play();
	}

	/** 直接展示完整画面（不播放动画），用于刷新后恢复 */
	function showComplete(data) {
		load(data, { autoplay: false });
		rebuildBase(N - 1);
		T = TOTAL;
		render();
	}

	function destroy() {
		destroyed = true;
		playing = false;
		cancelAnimationFrame(rafId);
		STROKES = [];
		if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (bctx) bctx.clearRect(0, 0, base.width, base.height);
	}

	// 显示尺寸变化（窗口缩放 / 布局切换）时重建，保证清晰度
	let resizeObserver = null;
	if (typeof ResizeObserver !== "undefined") {
		resizeObserver = new ResizeObserver(() => {
			if (destroyed) return;
			resizeCanvas();
		});
		resizeObserver.observe(canvas);
	}

	return {
		load,
		showComplete,
		play,
		pause,
		toggle,
		replay,
		seekTo,
		setSpeed,
		destroy,
		get total() {
			return TOTAL;
		},
		get strokes() {
			return N;
		},
		get playing() {
			return playing;
		},
		get current() {
			return T;
		},
	};
}
