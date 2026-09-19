<script lang="ts">
	import Icon from "@iconify/svelte";
	import { onMount } from "svelte";

	// 友链列表（用来判断"是否已通过"）与状态查询接口
	export let friends: { url?: string; name?: string }[] = [];
	export let endpoint = "/api/friend-apply-status";
	export let storageKey = "friendApplyRecord";

	type StoredRecord = {
		token?: string;
		url?: string;
		name?: string;
		at?: number;
		/** 上一次拿到的状态：update 时不能走"已在列表里就算通过"的捷径 */
		state?: string;
	};
	type Status = "none" | "pending" | "update" | "approved" | "rejected" | "expired";

	let status: Status = "none";
	let record: StoredRecord | null = null;

	const normalizeUrl = (value: unknown) =>
		String(value || "")
			.trim()
			.replace(/\/+$/, "")
			.toLowerCase();

	function inFriendsList(url: string): boolean {
		const target = normalizeUrl(url);
		if (!target) return false;
		return friends.some((friend) => normalizeUrl(friend?.url) === target);
	}

	function readRecord(): StoredRecord | null {
		try {
			const raw = localStorage.getItem(storageKey);
			if (!raw) return null;
			const parsed = JSON.parse(raw) as StoredRecord;
			return parsed && typeof parsed === "object" ? parsed : null;
		} catch {
			return null;
		}
	}

	function clear() {
		try {
			localStorage.removeItem(storageKey);
		} catch {
			// 忽略：localStorage 不可用时只是清不掉，不影响显示
		}
		clearTimeout(timer);
		record = null;
		status = "none";
	}

	const POLL_INTERVAL_MS = 60_000;

	// 审核中会定时复查，避免站长关掉 Issue 后这里一直停在旧状态
	let timer: ReturnType<typeof setTimeout> | undefined;
	let checking = false;

	function scheduleNextCheck() {
		clearTimeout(timer);
		if (status !== "pending") return;
		timer = setTimeout(() => void refresh(), POLL_INTERVAL_MS);
	}

	async function refresh(options: { bypassCache?: boolean } = {}) {
		if (checking) return;
		checking = true;
		try {
			record = readRecord();
			if (!record?.token) {
				status = "none";
				return;
			}

			// 站点已经出现在友链列表里 → 直接判定通过，连接口都不用查。
			// 例外：上次查到的是「信息更新中」，说明列表里还是旧信息，必须问接口。
			if (record.state !== "update" && inFriendsList(record.url || "")) {
				status = "approved";
				return;
			}

			const query = `token=${encodeURIComponent(record.token)}${
				options.bypassCache ? "&refresh=1" : ""
			}`;
			const response = await fetch(`${endpoint}?${query}`);
			const data = (await response.json().catch(() => null)) as {
				ok?: boolean;
				state?: string;
			} | null;

			// 查询失败时保持原有状态，不给出错误结论
			if (!response.ok || !data?.ok) return;

			// 接口返回 approved / rejected / pending / update / unknown
			status =
				data.state === "approved"
					? "approved"
					: data.state === "rejected"
						? "rejected"
						: data.state === "update"
							? "update"
							: data.state === "pending"
								? "pending"
								: "expired";

			// 记回本地，供下次进入时判断捷径（见上面 update 的例外）
			try {
				localStorage.setItem(storageKey, JSON.stringify({ ...record, state: status }));
			} catch {
				// localStorage 不可用时只影响下次进入的捷径判断，不影响本次显示
			}
		} catch {
			// 网络异常同样保持原状态
		} finally {
			checking = false;
			scheduleNextCheck();
		}
	}

	const formatTime = (value?: number) => {
		if (!value) return "";
		try {
			return new Date(value).toLocaleString("zh-CN", {
				year: "numeric",
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			});
		} catch {
			return "";
		}
	};

	$: submittedAt = formatTime(record?.at);
	$: siteName = String(record?.name || "").trim();

	$: meta = {
		pending: {
			icon: "fa6-solid:hourglass-half",
			accent: "border-l-[var(--primary)]",
			iconClass: "text-[var(--primary)]",
			title: "友链申请已提交，正在等待站长审核",
			detail: submittedAt
				? `提交时间：${submittedAt}；审核结果出来后这里会自动更新`
				: "审核结果出来后这里会自动更新",
		},
		update: {
			icon: "fa6-solid:arrows-rotate",
			accent: "border-l-sky-500",
			iconClass: "text-sky-500",
			title: "站点已在友链列表里，这次提交的信息更新正在审核中",
			detail: submittedAt
				? `提交时间：${submittedAt}；通过后列表里的名称 / 简介 / 头像会一起换成新信息（现在显示的还是旧信息）`
				: "通过后列表里的信息会更新（现在显示的还是旧信息）",
		},
		approved: {
			icon: "fa6-solid:circle-check",
			accent: "border-l-emerald-500",
			iconClass: "text-emerald-500",
			title: "申请已通过，站点已经加进友链列表了",
			detail: siteName ? `「${siteName}」现在就在上面的列表里` : "现在就出现在上面的列表里了",
		},
		rejected: {
			icon: "fa6-solid:circle-xmark",
			accent: "border-l-neutral-400",
			iconClass: "text-neutral-400",
			title: "很遗憾，这次申请没有通过",
			detail: "站点更新之后欢迎再来申请，也可以直接通过页面上的联系方式找站长问问原因",
		},
		expired: {
			icon: "fa6-solid:triangle-exclamation",
			accent: "border-l-amber-500",
			iconClass: "text-amber-500",
			title: "查不到这条申请记录了",
			detail: "可能已经被清理，可以重新提交一次申请",
		},
	}[status as Exclude<Status, "none">];

	onMount(() => {
		void refresh();

		// 刚提交完（弹窗发的自定义事件）→ 立刻刷新状态条
		const onSubmitted = () => void refresh({ bypassCache: true });
		// 切回这个标签页时再查一次（比如你刚在 GitHub 上关掉 Issue 再切回来）
		const onVisibilityChange = () => {
			if (!document.hidden) void refresh({ bypassCache: true });
		};

		window.addEventListener("friend-apply-submitted", onSubmitted);
		document.addEventListener("visibilitychange", onVisibilityChange);

		return () => {
			window.removeEventListener("friend-apply-submitted", onSubmitted);
			document.removeEventListener("visibilitychange", onVisibilityChange);
			clearTimeout(timer);
		};
	});
</script>

{#if status !== "none" && meta}
	<div
		class="card-base flex items-start gap-3 p-4 md:px-5 border-l-4 {meta.accent}"
		data-friend-apply-status
		aria-live="polite"
	>
		<Icon icon={meta.icon} class="shrink-0 mt-0.5 text-[1.25rem] {meta.iconClass}"></Icon>
		<div class="min-w-0 flex-1">
			<div class="font-bold text-sm text-90">{meta.title}</div>
			{#if meta.detail}
				<p class="text-xs text-75 mt-1">{meta.detail}</p>
			{/if}
		</div>
		<div class="flex items-center gap-1 shrink-0">
			<button
				type="button"
				title="重新查询申请状态"
				class="btn-plain rounded-md text-xs h-7 px-2 active:scale-95"
				onclick={() => void refresh({ bypassCache: true })}
			>
				<Icon icon="fa6-solid:rotate-right" class={checking ? "animate-spin" : ""}></Icon>
				<span>刷新</span>
			</button>
			<button
				type="button"
				class="btn-plain rounded-md text-xs h-7 px-2 active:scale-95"
				onclick={clear}
			>清除</button>
		</div>
	</div>
{/if}
