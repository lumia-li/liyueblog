/** canvas-confetti 1.9.4 没有自带类型声明，这里补一份用到的最小定义 */
declare module "canvas-confetti" {
	export interface Options {
		particleCount?: number;
		angle?: number;
		spread?: number;
		startVelocity?: number;
		decay?: number;
		gravity?: number;
		drift?: number;
		flat?: boolean;
		ticks?: number;
		origin?: { x?: number; y?: number };
		colors?: string[];
		shapes?: Array<"square" | "circle" | "star">;
		scalar?: number;
		zIndex?: number;
		disableForReducedMotion?: boolean;
	}

	export type ConfettiFunction = (options?: Options) => Promise<null> | null;

	const confetti: ConfettiFunction;
	export default confetti;
}
