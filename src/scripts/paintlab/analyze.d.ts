/** analyze.js 的类型声明（实现来自 paintlab.html 的原分析引擎） */

/** 单笔紧凑打包：[笔宽, 起始ms, 时长ms, 颜色, x0, y0, x1, y1, ...] */
export type StrokePack = [number, number, number, string, ...number[]];

/** [层号, 层名, 起始笔索引, 结束笔索引（不含）] */
export type LayerBounds = [number, string, number, number];

export interface PaintData {
	w: number;
	h: number;
	/** 整幅画的总时长（毫秒） */
	total: number;
	rois: number[][];
	layers: LayerBounds[];
	s: StrokePack[];
}

export type StageReporter = (text: string, pct: number) => void;

export function analyze(
	source: ImageBitmap | HTMLImageElement,
	width: number,
	height: number,
	onStage: StageReporter,
): PaintData;

export function analysisSize(width: number, height: number): [number, number];
