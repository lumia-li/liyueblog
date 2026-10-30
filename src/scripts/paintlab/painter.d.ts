/** painter.js 的类型声明 */
import type { PaintData } from "./analyze";

export interface PainterTick {
	current: number;
	total: number;
	strokes: number;
	index: number;
	playing: boolean;
	layer: string;
	ratio: number;
}

export interface PainterOptions {
	canvas: HTMLCanvasElement;
	tip?: boolean;
	onTick?: (tick: PainterTick) => void;
	onDone?: () => void;
}

export interface Painter {
	load(data: PaintData, options?: { autoplay?: boolean }): void;
	/** 直接渲染完整画面（不播放动画），用于刷新后恢复 */
	showComplete(data: PaintData): void;
	play(): void;
	pause(): void;
	toggle(): void;
	replay(): void;
	seekTo(ms: number): void;
	setSpeed(speed: number): void;
	destroy(): void;
	readonly total: number;
	readonly strokes: number;
	readonly playing: boolean;
	readonly current: number;
}

export function decodeImage(
	source: Blob | HTMLImageElement,
): Promise<ImageBitmap | HTMLImageElement>;

export function createPainter(options: PainterOptions): Painter;
