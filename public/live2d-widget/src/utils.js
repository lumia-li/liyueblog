/*
 * 看板娘的水平位置微调（面板固定 300px 宽，±100px 已能把模型挪到面板边缘）。
 * 存 localStorage：刷新、切换模型后仍然保持用户调好的位置。
 */
export const WAIFU_OFFSET_LIMIT = 100;
export const WAIFU_OFFSET_KEY = "waifu-offset-x";

function randomSelection(obj) {
    return Array.isArray(obj) ? obj[Math.floor(Math.random() * obj.length)] : obj;
}

/** 把任意输入夹到合法区间（取整、NaN 归零），保证模型不会被挪出面板 */
export function clampWaifuOffset(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return 0;
    }
    return Math.max(-WAIFU_OFFSET_LIMIT, Math.min(WAIFU_OFFSET_LIMIT, Math.round(number)));
}

/** 读取用户存过的偏移；没存过返回 null（交给模型自带的 OffsetX 兜底） */
export function readStoredWaifuOffset() {
    try {
        const raw = localStorage.getItem(WAIFU_OFFSET_KEY);
        return raw === null ? null : clampWaifuOffset(raw);
    } catch (error) {
        console.warn("Failed to read waifu offset.", error);
        return null;
    }
}

/** 写入偏移，返回夹取后的实际值 */
export function writeStoredWaifuOffset(value) {
    const offset = clampWaifuOffset(value);
    try {
        localStorage.setItem(WAIFU_OFFSET_KEY, String(offset));
    } catch (error) {
        console.warn("Failed to persist waifu offset.", error);
    }
    return offset;
}

export default randomSelection;
