// 「正在播放」同步
// - MusicBar 在换歌 / 播放暂停时把当前曲目 POST 到 /api/nowplaying
// - 服务端把状态写进仓库里的 src/data/now-playing.json（不触发重新部署）
// - 侧边栏组件同域读取接口，播放进度由浏览器按上报时间戳本地推算

export type NowPlayingState = {
	/** 曲目名；空字符串表示当前没有可显示的曲目 */
	title: string;
	artist: string;
	/** 是否正在播放（false = 暂停） */
	isPlaying: boolean;
	/** 上报时的播放位置（毫秒） */
	positionMs: number;
	/** 曲目总时长（毫秒），0 表示未知 */
	durationMs: number;
	/** 封面地址（http/https），空字符串表示没有 */
	coverUrl: string;
	/** 上报时间（ISO 字符串） */
	updatedAt: string;
};

/** 仓库里「正在播放」状态文件的位置（接口写入 + 构建期兜底读取都用它） */
export const NOWPLAYING_STATE_REPO_PATH = "src/data/now-playing.json";

/**
 * 状态文件存放的分支：独立分支上的提交不会影响默认分支，
 * 因此播放上报再频繁也不会触发重新部署。
 */
export const NOWPLAYING_STATE_REPO_BRANCH = "nowplaying";

function asString(value: unknown, maxLength = 200): string {
	return typeof value === "string" ? value.slice(0, maxLength).trim() : "";
}

function asMilliseconds(value: unknown): number {
	const number = typeof value === "number" ? value : Number(value);
	return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function asHttpUrl(value: unknown): string {
	const text = asString(value, 500);
	if (!text) return "";
	return /^https?:\/\//i.test(text) ? text : "";
}

/** 把外部输入整理成状态对象；结构完全不对时返回 null */
export function normalizeNowPlayingState(value: unknown): NowPlayingState | null {
	if (!value || typeof value !== "object") return null;
	const raw = value as Record<string, unknown>;
	const updatedAt = asString(raw.updatedAt, 40);
	return {
		title: asString(raw.title),
		artist: asString(raw.artist),
		isPlaying: raw.isPlaying === true,
		positionMs: asMilliseconds(raw.positionMs),
		durationMs: asMilliseconds(raw.durationMs),
		coverUrl: asHttpUrl(raw.coverUrl),
		updatedAt: Number.isNaN(Date.parse(updatedAt))
			? new Date().toISOString()
			: updatedAt,
	};
}

/** 空状态：没有在播放任何东西 */
export function emptyNowPlayingState(): NowPlayingState {
	return {
		title: "",
		artist: "",
		isPlaying: false,
		positionMs: 0,
		durationMs: 0,
		coverUrl: "",
		updatedAt: new Date(0).toISOString(),
	};
}

/** 解析状态文件；内容坏了就当作空状态，不让页面报错 */
export function parseNowPlayingState(text: string): NowPlayingState {
	try {
		return normalizeNowPlayingState(JSON.parse(text)) ?? emptyNowPlayingState();
	} catch {
		return emptyNowPlayingState();
	}
}

/** 写入仓库的文件内容（带尾换行，方便 diff） */
export function serializeNowPlayingState(state: NowPlayingState): string {
	return `${JSON.stringify(state, null, "\t")}\n`;
}

/** 提交信息文案 */
export function describeNowPlayingState(state: NowPlayingState): string {
	if (!state.title) return "停止播放";
	const label = state.artist ? `${state.artist} - ${state.title}` : state.title;
	return state.isPlaying ? `正在播放：${label}` : `暂停：${label}`;
}
