/**
 * 友链申请里「名称」「简介」的基础文本检测。
 *
 * 前后端共用同一个文件：
 *   · 前端（FriendLinkApplyModal.svelte）失焦 / 提交时即时提示，不合格不让提交
 *   · 后端（api/friend-apply.ts）再查一遍兜底，防止绕过前端直接打接口
 *
 * 规则刻意留得宽松：站点名里带域名（很多博客就这样）是允许的，
 * 只挡明显有问题的东西——空值、过短过长、HTML 标签、邮箱、纯符号、连续刷屏字符。
 */

export const FRIEND_NAME_MIN = 2;
export const FRIEND_NAME_MAX = 40;
export const FRIEND_DESCRIPTION_MIN = 4;
export const FRIEND_DESCRIPTION_MAX = 80;

export type TextCheck = { ok: true } | { ok: false; message: string };

/** < > 会被当成标签；邮箱是典型垃圾信息；同一个字符连续 6 次以上基本是刷屏 */
const TAG_PATTERN = /[<>]/;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const REPEAT_PATTERN = /(\S)\1{5,}/;
const URL_HEAD_PATTERN = /^https?:\/\//i;

/** 至少要有字母、数字或中日韩文字，不能是一串符号 */
function hasMeaningfulChar(text: string): boolean {
	return /[\p{L}\p{N}]/u.test(text);
}

/** 中文按「字」算长度，避免 emoji / 生僻字被算错 */
function lengthOf(text: string): number {
	return [...text].length;
}

export function checkFriendName(value: string): TextCheck {
	const text = value.trim();
	if (!text) return { ok: false, message: "请填写站点名称" };
	if (lengthOf(text) < FRIEND_NAME_MIN) {
		return { ok: false, message: `站点名称太短了，至少 ${FRIEND_NAME_MIN} 个字` };
	}
	if (lengthOf(text) > FRIEND_NAME_MAX) {
		return { ok: false, message: `站点名称最多 ${FRIEND_NAME_MAX} 个字` };
	}
	if (TAG_PATTERN.test(text)) {
		return { ok: false, message: "站点名称里不能包含 < > 符号" };
	}
	if (URL_HEAD_PATTERN.test(text)) {
		return { ok: false, message: "站点名称里不用写完整网址（链接有专门的输入框）" };
	}
	if (EMAIL_PATTERN.test(text)) {
		return { ok: false, message: "站点名称里不用留邮箱" };
	}
	if (REPEAT_PATTERN.test(text)) {
		return { ok: false, message: "站点名称里有连续重复的字符，检查一下？" };
	}
	if (!hasMeaningfulChar(text)) {
		return { ok: false, message: "站点名称不能只有符号" };
	}
	return { ok: true };
}

export function checkFriendDescription(value: string): TextCheck {
	const text = value.trim();
	if (!text) return { ok: false, message: "请填写一句话简介" };
	if (lengthOf(text) < FRIEND_DESCRIPTION_MIN) {
		return { ok: false, message: `简介太短了，至少 ${FRIEND_DESCRIPTION_MIN} 个字` };
	}
	if (lengthOf(text) > FRIEND_DESCRIPTION_MAX) {
		return { ok: false, message: `简介最多 ${FRIEND_DESCRIPTION_MAX} 个字` };
	}
	if (TAG_PATTERN.test(text)) {
		return { ok: false, message: "简介里不能包含 < > 符号" };
	}
	if (URL_HEAD_PATTERN.test(text)) {
		return { ok: false, message: "简介里不用写完整网址（链接有专门的输入框）" };
	}
	if (EMAIL_PATTERN.test(text)) {
		return { ok: false, message: "简介里不用留邮箱" };
	}
	if (REPEAT_PATTERN.test(text)) {
		return { ok: false, message: "简介里有连续重复的字符，检查一下？" };
	}
	if (!hasMeaningfulChar(text)) {
		return { ok: false, message: "简介不能只有符号" };
	}
	return { ok: true };
}
