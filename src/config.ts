import type {
	ExpressiveCodeConfig,
	LicenseConfig,
	NavBarConfig,
	ProfileConfig,
	SiteConfig,
} from "./types/config";
import { LinkPreset } from "./types/config";

export const siteConfig: SiteConfig = {
	title: "璃月小站",
	subtitle: "分享技术与生活的博客", //
	lang: "en", // Language code, e.g. 'en', 'zh_CN', 'ja', etc.
	themeColor: {
		hue: 250, // Default hue for the theme color, from 0 to 360. e.g. red: 0, teal: 200, cyan: 250, pink: 345
		fixed: false, // Hide the theme color picker for visitors
	},
	banner: {
		enable: false,
		src: "/background/7.webp", // Relative to the /src directory. Relative to the /public directory if it starts with '/'
		position: "center 66.67%", // Equivalent to CSS object-position. e.g. 'top', 'center', 'bottom', or 'center 66.67%'
		credit: {
			enable: false, // Display the credit text of the banner image
			text: "", // Credit text to be displayed
			url: "", // (Optional) URL link to the original artwork or artist's page
		},
	},
	toc: {
		enable: true, // Display the table of contents on the right side of the post
		depth: 2, // Maximum heading depth to show in the table, from 1 to 3
	},
	favicon: [
		// Leave this array empty to use the default favicon
		// 浏览器标签页图标：由 public/images/avatar.webp 生成，改头像后重新导出这几个尺寸即可
		{
			src: "/favicon/favicon-avatar-32.png",
			sizes: "32x32",
		},
		{
			src: "/favicon/favicon-avatar-128.png",
			sizes: "128x128",
		},
		{
			src: "/favicon/favicon-avatar-180.png",
			sizes: "180x180",
		},
		{
			src: "/favicon/favicon-avatar-192.png",
			sizes: "192x192",
		},
		// {
		//   src: '/favicon/icon.png',    // Path of the favicon, relative to the /public directory
		//   theme: 'light',              // (Optional) Either 'light' or 'dark', set only if you have different favicons for light and dark mode
		//   sizes: '32x32',              // (Optional) Size of the favicon, set only if you have favicons of different sizes
		// }
	],
};

export const navBarConfig: NavBarConfig = {
	links: [
		LinkPreset.Home,
		LinkPreset.Archive,
		LinkPreset.About,
		{
			name: "随笔",
			url: "/thoughts/",
		},
		{
			name: "友链",
			url: "/friends/",
		},
		{
			name: "统计",
			url: "https://u.liyueovo.top/share/BNQHKRVIrz8MsQiu", // Internal links should not include the base path, as it is automatically added
			external: true, // Show an external link icon and will open in a new tab
		},
	],
};

export const profileConfig: ProfileConfig = {
	avatar: "/images/avatar.webp", // Relative to the /src directory. Relative to the /public directory if it starts with '/'
	name: "璃月",
	bio: "欢迎来到璃月小站，这里的内容有的可能会帮到你哦",
	links: [
		{
			name: "QQ",
			icon: "fa6-brands:qq",
			url: "https://qm.qq.com/q/ThtEduGcIQ",
		},
		{
			name: "biliBili",
			icon: "fa6-brands:bilibili",
			url: "https://space.bilibili.com/1689293875",
		},
		{
			name: "github",
			icon: "fa6-brands:github",
			url: "https://github.com/wangchen-2023",
		},
	],
};

export const licenseConfig: LicenseConfig = {
	enable: true,
	name: "CC BY-NC-SA 4.0",
	url: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
};

export const expressiveCodeConfig: ExpressiveCodeConfig = {
	// Note: Some styles (such as background color) are being overridden, see the astro.config.mjs file.
	// [lightTheme, darkTheme]
	theme: ["github-light", "github-dark"],
};
