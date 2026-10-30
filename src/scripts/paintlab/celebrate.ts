/**
 * 画完一张图时的烟花庆祝。
 * 用 canvas-confetti 的 fireworks 玩法：左右两侧随机位置反复升空爆开，
 * 粒子用主题蓝 + 金 + 粉，2.4 秒后自然收尾。
 * 注意：不是每张都放（按概率），并且尊重系统的「减少动态效果」设置。
 */
import confetti from "canvas-confetti";

const DURATION = 2400;
const COLORS = ["#7fb4ff", "#ffd166", "#ff8fab", "#8ef0c0", "#c7b2ff"];

let running = false;

function random(min: number, max: number): number {
	return min + Math.random() * (max - min);
}

function launch(): void {
	if (running) return;
	if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
		return;
	}
	running = true;

	const end = Date.now() + DURATION;
	const defaults = {
		startVelocity: 26,
		spread: 360,
		ticks: 70,
		zIndex: 200,
		colors: COLORS,
		disableForReducedMotion: true,
	};

	const shoot = (): void => {
		const left = end - Date.now();
		if (left <= 0) {
			running = false;
			return;
		}
		// 越接近结束粒子越少，收得自然一点
		const particleCount = Math.max(12, Math.round(34 * (left / DURATION)));
		confetti({
			...defaults,
			particleCount,
			origin: { x: random(0.12, 0.36), y: random(0.06, 0.34) },
		});
		confetti({
			...defaults,
			particleCount,
			origin: { x: random(0.64, 0.88), y: random(0.06, 0.34) },
		});
		window.setTimeout(shoot, 200);
	};

	shoot();
}

/** chance 为触发放烟花的概率（0~1）；不是每张都放 */
export function maybeCelebrate(chance = 0.5): void {
	if (Math.random() > chance) return;
	launch();
}
