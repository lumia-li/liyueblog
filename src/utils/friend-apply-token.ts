import { createHmac } from "node:crypto";

/**
 * 友链申请的「查询凭证」。
 *
 * 提交成功后，服务端把站点域名（slug）用 HMAC 签名成 `${slug}.${签名}` 交给前端，
 * 申请人把它存在本地，之后凭它查询自己的申请状态（审核中 / 已通过 / 未通过）。
 * 加签名是为了防止有人拿别人的域名直接来查。
 *
 * 签名密钥用独立的 FRIEND_APPLY_SECRET（不要再复用 GITHUB_TOKEN）。
 */
function secret(): string {
	return String(
		import.meta.env.FRIEND_APPLY_SECRET ||
			import.meta.env.GITHUB_TOKEN ||
			"friend-apply-dev-secret",
	);
}

const SLUG_PATTERN = /^[a-z0-9.-]{1,80}$/;

function sign(value: string): string {
	return createHmac("sha256", secret()).update(value, "utf8").digest("hex").slice(0, 32);
}

/** 常量时间比较两个等长字符串（避免通过响应时间推测签名） */
function safeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i += 1) {
		diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}
	return diff === 0;
}

/** 生成查询凭证 */
export function createStatusToken(slug: string): string {
	return `${slug}.${sign(slug)}`;
}

/** 校验查询凭证，合法则返回站点域名（slug），否则返回 null */
export function verifyStatusToken(token: string): string | null {
	const raw = String(token || "");
	const dot = raw.lastIndexOf(".");
	if (dot <= 0) return null;

	const slug = raw.slice(0, dot).toLowerCase();
	const signature = raw.slice(dot + 1);
	if (!SLUG_PATTERN.test(slug) || !signature) return null;
	if (!safeEqual(signature.toLowerCase(), sign(slug))) return null;

	return slug;
}
