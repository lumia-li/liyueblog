import I18nKey from "./i18nKey";

const translations: Record<I18nKey, string> = {
	[I18nKey.home]: "首页",
	[I18nKey.about]: "关于",
	[I18nKey.archive]: "归档",
	[I18nKey.search]: "搜索",
	[I18nKey.themeColor]: "主题色",
	[I18nKey.lightMode]: "浅色",
	[I18nKey.darkMode]: "深色",
	[I18nKey.systemMode]: "跟随系统",
	[I18nKey.uncategorized]: "未分类",
	[I18nKey.categories]: "分类",
	[I18nKey.tags]: "标签",
	[I18nKey.more]: "更多",
	[I18nKey.noTags]: "暂无标签",
	[I18nKey.postCount]: "篇文章",
	[I18nKey.postsCount]: "篇文章",
	[I18nKey.wordCount]: "字",
	[I18nKey.wordsCount]: "字",
	[I18nKey.minuteCount]: "分钟",
	[I18nKey.minutesCount]: "分钟",
	[I18nKey.pageNotFound]: "页面未找到",
	[I18nKey.pageNotFoundDescription]: "没有这个页面呢。",
	[I18nKey.pageNotFoundHint]: "链接写错了吗？可以返回首页哦。",
	[I18nKey.backToHome]: "返回首页",
	[I18nKey.viewArchives]: "查看归档",
	[I18nKey.randomPost]: "随便看看",
	[I18nKey.goHome]: "回到首页",
	[I18nKey.goArchive]: "前往归档",
	[I18nKey.goBack]: "返回",
	[I18nKey.untitled]: "未命名",
	[I18nKey.author]: "作者",
	[I18nKey.publishedAt]: "发布于",
	[I18nKey.license]: "许可证",
};

export function i18n(key: I18nKey): string {
	return translations[key] ?? String(key);
}
