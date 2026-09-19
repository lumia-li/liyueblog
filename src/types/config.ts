import type { AUTO_MODE, DARK_MODE, LIGHT_MODE } from "@constants/constants";

export type SiteConfig = {
	title: string;
	subtitle: string;

	lang:
		| "en"
		| "zh_CN"
		| "zh_TW"
		| "ja"
		| "ko"
		| "es"
		| "th"
		| "vi"
		| "tr"
		| "id";

	themeColor: {
		hue: number;
		fixed: boolean;
	};
	banner: {
		enable: boolean;
		src: string;
		/**
		 * Equivalent to CSS `object-position`.
		 * Supports `top | center | bottom` or any valid `object-position` string (e.g. `center 66.67%`).
		 */
		position?: "top" | "center" | "bottom" | string;
		credit: {
			enable: boolean;
			text: string;
			url?: string;
		};
	};
	toc: {
		enable: boolean;
		depth: 1 | 2 | 3;
	};

	favicon: Favicon[];
};

export type Favicon = {
	src: string;
	theme?: "light" | "dark";
	sizes?: string;
};

export enum LinkPreset {
	Home = 0,
	Archive = 1,
	About = 2,
}

export type NavBarLink = {
	name: string;
	url: string;
	external?: boolean;
};

export type NavBarConfig = {
	links: (NavBarLink | LinkPreset)[];
};

export type ProfileConfig = {
	avatar?: string;
	name: string;
	bio?: string;
	links: {
		name: string;
		url: string;
		icon: string;
	}[];
};

export type LicenseConfig = {
	enable: boolean;
	name: string;
	url: string;
};

/** 一条友链（他人的站点 / 本站自己的名片） */
export type FriendLink = {
	name: string;
	/** 头像地址：支持完整外链（http/https）或 public/ 下的绝对路径 */
	avatar: string;
	description: string;
	url: string;
	/** 可选标签，例如 ["技术", "生活"] */
	tags?: string[];
};

export type FriendLinkSelf = FriendLink & {
	/**
	 * 供他人引用的头像直链（建议使用站点 public 目录下的图片并写完整域名）。
	 * 留空时回退到 avatar 字段。
	 */
	avatarUrl?: string;
};

export type FriendLinkConfig = {
	/** 页面标题（也用于 <title>） */
	title: string;
	/** 页面 SEO 描述 */
	description: string;
	/** 标题下方的一句话寄语（可选） */
	intro?: string;
	/** 我自己的友链信息：展示给访客，方便别人把本站加进他的友链 */
	self: FriendLinkSelf;
	/** 申请友链的说明区块，enable 为 false 时不渲染 */
	apply?: {
		enable: boolean;
		/** 一段说明文字 */
		comment?: string;
		/** 友链要求列表 */
		requirements?: string[];
		/**
		 * 申请表单：点击按钮弹出窗口填写，提交后由 /api/friend-apply
		 * 写入「友链数据仓库」的申请文件，并自动检测站点可达性与双向链接
		 * （详见该接口注释；已通过的站点再次提交会作为「信息更新」处理）
		 */
		form?: {
			enable: boolean;
			/** 入口按钮文案 */
			buttonLabel?: string;
			/** 弹窗标题 */
			title?: string;
			/** 弹窗顶部说明 */
			description?: string;
		};
		/** 申请入口按钮 */
		contacts?: {
			name: string;
			url: string;
			icon: string;
		}[];
	};
	/** 他人的友链列表，为空时页面显示占位提示 */
	friends: FriendLink[];
};

export type LIGHT_DARK_MODE =
	| typeof LIGHT_MODE
	| typeof DARK_MODE
	| typeof AUTO_MODE;

export type BlogPostData = {
	body: string;
	title: string;
	published: Date;
	description: string;
	tags: string[];
	draft?: boolean;
	image?: string;
	category?: string;
	prevTitle?: string;
	prevSlug?: string;
	nextTitle?: string;
	nextSlug?: string;
};

export type ExpressiveCodeConfig = {
	theme: string | [string, string];
};
