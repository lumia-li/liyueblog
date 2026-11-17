import nodemailer from "nodemailer";

/**
 * 友链申请通知：QQ 邮箱 SMTP / Qmsg 机器人。
 *
 * 环境变量（Vercel → Project → Settings → Environment Variables）：
 *   QQ 邮箱（主通道）：
 *     FRIEND_NOTIFY_SMTP_USER  QQ 邮箱地址，例如 123456@qq.com
 *     FRIEND_NOTIFY_SMTP_PASS  QQ 邮箱「授权码」（不是登录密码）
 *     FRIEND_NOTIFY_EMAIL_TO   接收通知的邮箱，默认与 SMTP_USER 相同
 *   可选：
 *     FRIEND_NOTIFY_SMTP_HOST  默认 smtp.qq.com
 *     FRIEND_NOTIFY_SMTP_PORT  默认 465（SSL）
 *     FRIEND_NOTIFY_QMSG_KEY   Qmsg 酱的 key（绑定 QQ 后用于机器人通知）
 *
 * 邮件和 Qmsg 都配置时会同时发送；都没配置时静默跳过，不影响友链提交。
 */

export type FriendNotifyStatus = "pending" | "update" | "approved";

export type FriendNotifyChecks = {
	siteReachable?: boolean;
	siteStatus?: number;
	siteNote?: string;
	avatarReachable?: boolean;
	avatarStatus?: number;
	avatarNote?: string;
	backlinkVerified?: boolean;
};

export type FriendNotifyInput = {
	slug: string;
	name: string;
	url: string;
	description?: string;
	avatar?: string;
	backlink?: string;
	tags?: string[];
	status: FriendNotifyStatus;
	checks?: FriendNotifyChecks;
	/** 数据仓库 owner/repo，用于生成文件链接 */
	dataRepo?: string;
	/** 数据文件相对路径，例如 applications/example.com.json */
	dataPath: string;
};

type EmailConfig = {
	host: string;
	port: number;
	user: string;
	pass: string;
	to: string;
};

type NotifyEnvKey =
	| "FRIEND_NOTIFY_SMTP_USER"
	| "FRIEND_NOTIFY_SMTP_PASS"
	| "FRIEND_NOTIFY_EMAIL_TO"
	| "FRIEND_NOTIFY_SMTP_HOST"
	| "FRIEND_NOTIFY_SMTP_PORT"
	| "FRIEND_NOTIFY_QMSG_KEY";

/** 用静态属性名读取，确保 Vercel/Vite 构建时能正确注入环境变量 */
function readEnv(name: NotifyEnvKey): string {
	const env = import.meta.env;
	switch (name) {
		case "FRIEND_NOTIFY_SMTP_USER":
			return String(env.FRIEND_NOTIFY_SMTP_USER || "").trim();
		case "FRIEND_NOTIFY_SMTP_PASS":
			return String(env.FRIEND_NOTIFY_SMTP_PASS || "").trim();
		case "FRIEND_NOTIFY_EMAIL_TO":
			return String(env.FRIEND_NOTIFY_EMAIL_TO || "").trim();
		case "FRIEND_NOTIFY_SMTP_HOST":
			return String(env.FRIEND_NOTIFY_SMTP_HOST || "").trim();
		case "FRIEND_NOTIFY_SMTP_PORT":
			return String(env.FRIEND_NOTIFY_SMTP_PORT || "").trim();
		case "FRIEND_NOTIFY_QMSG_KEY":
			return String(env.FRIEND_NOTIFY_QMSG_KEY || "").trim();
	}
}

function getEmailConfig(): EmailConfig | null {
	const user = readEnv("FRIEND_NOTIFY_SMTP_USER");
	const pass = readEnv("FRIEND_NOTIFY_SMTP_PASS");
	const to = readEnv("FRIEND_NOTIFY_EMAIL_TO") || user;
	if (!user || !pass || !to) return null;
	const port = Number(readEnv("FRIEND_NOTIFY_SMTP_PORT")) || 465;
	return {
		host: readEnv("FRIEND_NOTIFY_SMTP_HOST") || "smtp.qq.com",
		port,
		user,
		pass,
		to,
	};
}

function statusText(status: FriendNotifyStatus): string {
	if (status === "approved") return "已通过自动检测，已自动收录";
	if (status === "update") return "信息更新，等待审核";
	return "新申请，等待审核";
}

function actionTitle(status: FriendNotifyStatus): string {
	if (status === "approved") return "友链自动收录";
	if (status === "update") return "友链信息更新";
	return "新的友链申请";
}

function buildCheckLines(checks: FriendNotifyChecks | undefined): string[] {
	if (!checks) return ["检测：无"];
	const lines: string[] = [];
	if (checks.siteReachable !== undefined) {
		lines.push(
			`站点检测：${checks.siteReachable ? "通过" : "有疑问"}${
				checks.siteStatus ? ` (HTTP ${checks.siteStatus})` : ""
			}${checks.siteNote ? ` - ${checks.siteNote}` : ""}`,
		);
	}
	if (checks.avatarReachable !== undefined) {
		lines.push(
			`头像检测：${checks.avatarReachable ? "通过" : "有疑问"}${
				checks.avatarStatus ? ` (HTTP ${checks.avatarStatus})` : ""
			}${checks.avatarNote ? ` - ${checks.avatarNote}` : ""}`,
		);
	}
	if (checks.backlinkVerified !== undefined) {
		lines.push(`回链检测：${checks.backlinkVerified ? "已验证" : "未通过"}`);
	}
	return lines.length ? lines : ["检测：无"];
}

function buildMessage(input: FriendNotifyInput): {
	subject: string;
	text: string;
} {
	const repo = input.dataRepo || "lumia-li/friends-data";
	const fileUrl = `https://github.com/${repo}/blob/main/data/${input.dataPath}`;
	const tags = input.tags && input.tags.length ? input.tags.join("、") : "未填写";
	const name = input.name || input.slug;
	const subjectPrefix = actionTitle(input.status);
	const subject = `${subjectPrefix}：${name}`;

	const lines = [
		"璃月小站 · 友链通知",
		"",
		`类型：${subjectPrefix}`,
		`名称：${name}`,
		`站点：${input.url}`,
		`简介：${input.description || "未填写"}`,
		`分类：${tags}`,
		`头像：${input.avatar || "未填写"}`,
		`友链页：${input.backlink || "未填写"}`,
		"",
		...buildCheckLines(input.checks),
		"",
		`状态：${statusText(input.status)}`,
		`数据文件：${fileUrl}`,
		"",
		input.status === "pending" || input.status === "update"
			? "审核方式：打开上面的文件，把 status 改成 approved 即可上架。"
			: "已自动收录，工作流会触发博客重新构建上线。",
	];
	return { subject, text: lines.join("\n") };
}

async function sendEmail(
	config: EmailConfig,
	subject: string,
	text: string,
): Promise<void> {
	const transporter = nodemailer.createTransport({
		host: config.host,
		port: config.port,
		secure: config.port === 465,
		auth: {
			user: config.user,
			pass: config.pass,
		},
		connectionTimeout: 4000,
		greetingTimeout: 4000,
		socketTimeout: 6000,
	});
	try {
		await transporter.sendMail({
			from: `"璃月小站" <${config.user}>`,
			to: config.to,
			subject,
			text,
		});
	} finally {
		transporter.close();
	}
}

async function sendQmsg(key: string, text: string): Promise<void> {
	const response = await fetch(
		`https://qmsg.zendee.cn/send/${encodeURIComponent(key)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: new URLSearchParams({ msg: text }).toString(),
			signal: AbortSignal.timeout(5000),
		},
	);
	if (!response.ok) {
		throw new Error(`Qmsg HTTP ${response.status}`);
	}
	const payload = (await response.json().catch(() => null)) as {
		success?: boolean;
		reason?: string;
	} | null;
	if (payload && payload.success === false) {
		throw new Error(`Qmsg: ${payload.reason || "发送失败"}`);
	}
}

/** 发送友链通知；失败只记日志，不影响申请提交结果 */
export async function notifyFriendApplication(input: FriendNotifyInput): Promise<{
	sent: boolean;
	channels: string[];
}> {
	const { subject, text } = buildMessage(input);
	const tasks: Promise<void>[] = [];
	const channels: string[] = [];

	const email = getEmailConfig();
	if (email) {
		channels.push("email");
		tasks.push(sendEmail(email, subject, text));
	}

	const qmsgKey = readEnv("FRIEND_NOTIFY_QMSG_KEY");
	if (qmsgKey) {
		channels.push("qmsg");
		tasks.push(sendQmsg(qmsgKey, text));
	}

	if (tasks.length === 0) {
		return { sent: false, channels: [] };
	}

	const results = await Promise.allSettled(tasks);
	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			const reason =
				result.reason instanceof Error
					? result.reason.message
					: String(result.reason);
			console.error(
				`[friend-notify] ${channels[index] || "通知"} 发送失败：${reason}`,
			);
		}
	}

	return {
		sent: results.some((result) => result.status === "fulfilled"),
		channels,
	};
}
