export function formatDateToYYYYMMDD(date: Date): string {
	return date.toISOString().substring(0, 10);
}

// 随笔发布时间按作者所在时区（UTC+8）换算后展示，
// 避免随构建环境时区不同而产生日期漂移。
const THOUGHT_TIMEZONE_OFFSET_MS = 8 * 60 * 60 * 1000;

function padTo2(value: number): string {
	return value.toString().padStart(2, "0");
}

function getThoughtLocalParts(date: Date): {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
} {
	const shifted = new Date(date.getTime() + THOUGHT_TIMEZONE_OFFSET_MS);
	return {
		year: shifted.getUTCFullYear(),
		month: shifted.getUTCMonth() + 1,
		day: shifted.getUTCDate(),
		hour: shifted.getUTCHours(),
		minute: shifted.getUTCMinutes(),
		second: shifted.getUTCSeconds(),
	};
}

// 时间段划分：午夜 00-05、上午 06-11、中午 12、下午 13-17、晚上 18-23
function getThoughtPeriodLabel(hour: number): string {
	if (hour >= 18) return "晚上";
	if (hour >= 13) return "下午";
	if (hour >= 12) return "中午";
	if (hour >= 6) return "上午";
	return "午夜";
}

// 随笔的发布时间展示：带时刻显示为「2026-08-27 晚上 18：38」；
// 早期随笔只保存了日期没有时刻，则仍然只显示日期以兼容旧数据。
export function formatThoughtPublished(date: Date): string {
	// 纯日期（如 2026-08-27）解析后固定落在 00:00:00.000Z，据此判定为旧随笔
	const isDateOnly =
		date.getUTCHours() === 0 &&
		date.getUTCMinutes() === 0 &&
		date.getUTCSeconds() === 0 &&
		date.getUTCMilliseconds() === 0;
	const { year, month, day, hour, minute } = getThoughtLocalParts(date);
	const dateText = `${year}-${padTo2(month)}-${padTo2(day)}`;
	if (isDateOnly) {
		return dateText;
	}
	return `${dateText} ${getThoughtPeriodLabel(hour)} ${hour}：${padTo2(minute)}`;
}
