import type { FriendLinkConfig } from "../types/config";


export const friendLinkConfig: FriendLinkConfig = {
    title: "友链",
    description: "璃月小站的友链，欢迎交换友链",
    intro: "这里是一起写字的伙伴，点一下就能去他们家逛逛",
    // 我自己的友链信息：展示给访客，方便别人把本站加进他的友链
    self: {
        name: "璃月小站",
        avatar: "/images/avatar.webp",
        avatarUrl: "https://liyueovo.top/images/avatar.webp", // 供他人引用的头像直链
        description: "分享技术与生活的小站，记录一些碎碎念",
        url: "https://liyueovo.top/",
        tags: ["技术", "生活"],
    },
    // 申请友链的说明区块，enable 设为 false 即可隐藏
    apply: {
        enable: true,
        comment:
            "欢迎同好交换友链~ 点下面的按钮填一下申请表单，我会尽快审核，通过后就会出现在友链列表里。",
        requirements: [
            "站点内容以原创为主，且可以正常访问（不长期 403 / 打不开）",
            "没有恶意代码、诱导广告以及违反法律法规的内容",
            "把本站加进你的友链再来申请：表单里填上你的「友链页」会自动帮你确认双向链接",
            "优先通过内容方向相近、更新较勤的站点",
        ],
        // 申请表单：点击按钮弹窗填写，提交后写入「友链数据仓库」的申请文件
        // （提交时会自动检测站点可达性与双向链接）。后端见 src/pages/api/friend-apply.ts
        form: {
            enable: true,
            buttonLabel: "填写申请表单",
            title: "申请友链",
            description:
                "填好下面的信息提交即可，我会尽快审核。提交时会自动检测站点能否打开；信息之后有变动也可以再提交一次，会作为「信息更新」处理。",
        },
        contacts: [
            {
                name: "QQ 联系",
                url: "https://qm.qq.com/q/ThtEduGcIQ",
                icon: "fa6-brands:qq",
            },
        ],
    },
    // 他人的友链列表：下面是示例数据，请替换成真实友链（留空数组 [] 会显示占位提示）
    friends: [
        {
            name: "春枫博客",
            avatar: "https://www.cfbk.top/wp-content/uploads/2023/07/cropped-logo1-300x300.png",
            description: "欢迎来到我的春枫博客，这里主要分享我的技术经验、心得和教程。",
            url: "https://www.cfbk.top/",
            tags: ["技术", "杂谈"],
        },
        {
            name: "Airlinyの小窝",
            avatar: "https://www.airliny.com/wp-content/uploads/2025/08/cropped-Image_1754882637207-scaled-1-192x192.png",
            description: "遇见你便花光了我所有的运气",
            url: "https://www.airliny.com/",
            tags: ["技术"],
        },

    ],
};
