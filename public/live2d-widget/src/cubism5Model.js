/**
 * Cubism 5（moc3 / model3.json）模型渲染模块
 *
 * 渲染内核说明：
 * - live2dcubismcore.min.js：官方 Cubism Core for Web 5（可重分发文件），moc3 版本 5 只有 5.x 的 Core 才能解析
 * - pixi.min.js：PixiJS 6（pixi-live2d-display 的宿主）
 * - pixi-live2d-display.min.js：pixi-live2d-display 0.4.0 的 cubism4 构建，负责模型加载、遮罩、物理、眨眼
 *
 * 三个内核脚本都是懒加载：只有真正选中 Cubism 5 模型时才会请求，
 * 保持原有的 Cubism 2（live2d.min.js）模型在首屏不受影响。
 */

import { clampWaifuOffset } from "./utils.js";

const CUBISM5_CANVAS_ID = "live2d-cubism5";
const STAGE_ID = "live2d-stage";
const MAGNIFIER_ID = "live2d-magnifier";
const LENS_ID = "live2d-lens";
const HINTS_ID = "live2d-magnifier-hints";
const DEFAULT_VENDOR_PATH = "/live2d-widget/vendor/";
const VENDOR_SCRIPTS = [
    "live2dcubismcore.min.js",
    "pixi.min.js",
    "pixi-live2d-display.min.js"
];

/* 放大镜（聚焦环）参数 */
const LENS_SIZE = 156; // 聚焦环直径（CSS px）
const LENS_ZOOM = 2.2; // 放大倍数
const HEAD_CENTER_RATIO = { x: 0.507, y: 0.273 }; // 头部中心在画布中的相对位置（中键判定用）
const HEAD_RADIUS_RATIO = 0.26; // 头部命中半径（相对画布宽度）
const LENS_DEFAULT_FOCUS_RATIO = { x: 0.507, y: 0.16 }; // 刚弹出时的取景中心（脸部再往上一档）
const LENS_BOUNDS_INSET = 0.04; // 取景范围相对模型占位向内收的比例（太小/太大会顶到或够不到上面的默认取景）
const MIDDLE_BUTTON = 1;
/* 触屏触发：在头部「长按」多久算长按、期间允许的手指抖动范围（px） */
const MAGNIFIER_LONG_PRESS_MS = 380;
const MAGNIFIER_LONG_PRESS_TOLERANCE = 12;

/*
 * 渲染自检参数。
 * 手机上见过「关掉看板娘再打开，只剩身体、头部整块没画出来」这类异常
 * （部件参数、可见性都正常，属于 WebGL 状态 / 合成层的问题），
 * 这里靠像素比例把它认出来，并重建渲染器自愈。
 */
const INTEGRITY_SAMPLE_SIZE = 96; // 采样画布边长（越小越省）
const INTEGRITY_HEAD_RATIO = 0.33; // 画布上三分之一算头部区域（模型是底边对齐、撑满高度的）
const INTEGRITY_MIN_TOTAL = 240; // 采样里至少要有这么多不透明像素，否则当作还没画出来
const INTEGRITY_MIN_HEAD = 0.05; // 头部像素占比低于该比例就判定为「头部丢失」
const INTEGRITY_CHECK_DELAY = 450; // 事件之后延迟自检，等这一帧画完
const INTEGRITY_REBUILD_COOLDOWN = 4000; // 两次重建之间的最小间隔，防抖

/* 放大镜里的气泡文字：取景在头部/身体时分别用不同的话 */
const MAGNIFIER_HINTS = {
    head: [
        "害羞",
        "好近…",
        "激动",
        "心跳加快",
        "别盯着看啦",
        "有点痒",
        "呜…别看",
        "脸红",
        "你、你干嘛",
        "头发要乱啦",
        "耳朵好烫"
    ],
    body: [
        // 害羞
        "唔…好害羞",
        "别、别一直看啦",
        "看这么仔细干嘛",
        "耳朵都在发烫",
        "看、看一眼就够了",
        "羞死了啦…",
        // 训斥
        "喂！眼睛往哪看",
        "看够了没有！",
        "再乱看就咬你",
        "不许乱碰哦",
        "哼，坏蛋",
        "看衣服就看衣服"
    ]
};

/*
 * 打开放大镜时自动切的表情：按关键词从模型「实际存在的表情」里挑，
 * 挑不到就不切，绝不虚构（大肥鱼现有表情：1 口型切换 / 2 三嘴 / 2 龇牙 / 3 脸黑 /
 * 4 脸红 / 5 >< / 5 O O / 6 X X / 7 流口水 / 8 担心嘴 / 8 栗子嘴 / 8 O嘴 / 尾巴消失 / 耳朵消失 / 水印消除）
 */
const MAGNIFIER_EXPRESSION_KEYWORDS = {
    head: ["脸红", "害羞", "blush"],
    body: ["O O", "O嘴", "栗子嘴"]
};

/* 取景中心 y 小于该值算「头部」，以此决定气泡词库、表情和动作 */
const MAGNIFIER_ZONE_SPLIT = 0.36;
const MAGNIFIER_HINT_MAX = 3; // 同时最多几个气泡
/*
 * 气泡节奏是随机的：有时害羞到连冒几句（急促），有时欲言又止停一会儿（慢）。
 * 头部取景（被盯着看）更慌，身体取景更从容。
 */
const MAGNIFIER_HINT_TEMPO = {
    head: { first: [350, 1000], fast: [240, 620], slow: [900, 2400], burstChance: 0.45 },
    body: { first: [500, 1500], fast: [420, 900], slow: [1700, 3600], burstChance: 0.18 }
};

function randomBetween(min, max) {
    return min + Math.random() * (max - min);
}

/*
 * 动作只在模型真的带动作文件（.motion3.json）时才播，
 * 按组名关键词优先找「扭捏 / 害羞」类，找不到就用第一组；没有动作文件就什么都不做。
 */
const MAGNIFIER_MOTION_KEYWORDS = ["扭捏", "害羞", "shy", "fidget", "idle", "tap", "touch"];

let vendorPromise = null;

function loadScript(url) {
    return new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-live2d5-asset="${url}"]`);
        if (existing) {
            if (existing.dataset.loaded === "1") {
                resolve(url);
                return;
            }
            existing.addEventListener("load", () => resolve(url), { once: true });
            existing.addEventListener("error", () => reject(url), { once: true });
            return;
        }
        const script = document.createElement("script");
        script.src = url;
        script.dataset.live2d5Asset = url;
        script.addEventListener("load", () => {
            script.dataset.loaded = "1";
            resolve(url);
        }, { once: true });
        script.addEventListener("error", () => reject(url), { once: true });
        document.head.appendChild(script);
    });
}

function loadVendor(vendorPath, assetVersion) {
    if (vendorPromise) {
        return vendorPromise;
    }
    const suffix = assetVersion ? `?v=${assetVersion}` : "";
    vendorPromise = VENDOR_SCRIPTS.reduce(
        (chain, file) => chain.then(() => loadScript(`${vendorPath}${file}${suffix}`)),
        Promise.resolve()
    ).catch(error => {
        vendorPromise = null;
        throw error;
    });
    return vendorPromise;
}

export default class Cubism5Model {
    constructor(config = {}) {
        this.vendorPath = config.vendorPath || DEFAULT_VENDOR_PATH;
        this.assetVersion = config.assetVersion || "";
        this.canvasId = config.canvasId || CUBISM5_CANVAS_ID;
        this.stageId = config.stageId || STAGE_ID;
        // 用户调过的水平位置（px，正数向右）；null 表示没调过，交给 model3.json 的 OffsetX
        this.storedOffsetX = Number.isFinite(config.horizontalOffset) ? config.horizontalOffset : null;
        this.offsetX = 0;

        this.app = null;
        this.model = null;
        this.modelPath = null;
        this.settings = null;
        this.widgetConfig = {};
        this.persistentParameters = {};
        this.expressionCycle = [];
        this.expressionMessages = [];
        this.expressions = new Map();
        this.appliedParameterIds = new Set();
        this.activeExpression = null;
        this.expressionIndex = 0;
        this.sleepWatcher = null;
        this.sleeping = false;
        this.paused = false;
        this.preparePromise = null;
        this.magnifierOpen = false;
        this.lensFocus = null;
        this.lensDrag = null;
        this.lensBackdrop = null;
        this.longPress = null;
        this.longPressTimer = null;
        this.ignorePointerCancel = false;
        this.integrityTimer = null;
        this.sampleCanvas = null;
        this.rebuilding = false;
        this.lastRebuildAt = 0;
        this.hintsTimer = null;
        this.hintBurstLeft = 0;
        this.lastHint = "";
        this.activeExpressionName = null;
        this.reactionZone = null;
        this.reactionRestoreExpression = null;
        this.reactionRestored = false;
        this.reactionHasMotion = false;

        this.onTick = this.onTick.bind(this);
        // 调试 / 二次开发入口：
        // live2dWidgetCubism5.applyExpression("4 脸红")、.cycleExpression()、.captureToDataUrl()
        window.live2dWidgetCubism5 = this;
    }

    /* ---------------------------------------------------------------- 内部工具 */

    get stageElement() {
        return document.getElementById(this.stageId);
    }

    get canvasElement() {
        return document.getElementById(this.canvasId);
    }

    get magnifierElement() {
        return document.getElementById(MAGNIFIER_ID);
    }

    get hintsElement() {
        return document.getElementById(HINTS_ID);
    }

    get lensElement() {
        return document.getElementById(LENS_ID);
    }

    get boxSize() {
        const stage = this.stageElement;
        const width = stage?.clientWidth || this.canvasElement?.clientWidth || 300;
        const height = stage?.clientHeight || this.canvasElement?.clientHeight || 300;
        return { width, height };
    }

    get coreModel() {
        return this.model?.internalModel?.coreModel ?? null;
    }

    isActive() {
        return Boolean(this.model) && this.stageElement?.dataset.renderer === "cubism5";
    }

    /* ---------------------------------------------------------------- 静态资源 */

    async ensureVendor() {
        await loadVendor(this.vendorPath, this.assetVersion);
        if (!window.PIXI?.live2d?.Live2DModel) {
            throw new Error("pixi-live2d-display 未正确加载");
        }
        return window.PIXI.live2d.Live2DModel;
    }

    createApp() {
        const PIXI = window.PIXI;
        const canvas = this.canvasElement;
        if (!canvas) {
            throw new Error(`缺少 ${this.canvasId} 画布元素`);
        }
        const resolution = Math.min(window.devicePixelRatio || 1, 2);
        // 交给 pixi 管理画布尺寸，CSS 只负责它在页面中的位置
        this.app = new PIXI.Application({
            view: canvas,
            width: this.boxSize.width,
            height: this.boxSize.height,
            backgroundAlpha: 0,
            resolution,
            autoDensity: true,
            autoStart: true,
            // 放大镜需要把画布像素再画进聚焦环，否则 WebGL 缓冲区已经清空读不到内容
            preserveDrawingBuffer: true
        });
        this.app.ticker.add(this.onTick);
        this.bindGlobalListeners();
        this.bindMagnifier();
        this.startSleepWatcher();
        return this.app;
    }

    /* ---------------------------------------------------------------- 放大镜 */

    /**
     * 聚焦环的触发与拖动（按住看、松手收回）
     * - 鼠标中键：按在头部立即弹出
     * - 触屏 / 触控笔：在头部「长按」（约 380ms 且几乎没移动）才弹出，
     *   这样和「拖走看板娘」的手势区分开；弹出后继续按住拖动即可移动取景
     * - 松开（或按 Esc / 切换模型）：聚焦环收回
     * 监听绑在 Cubism 5 的画布上，所以只有大肥鱼会响应
     */
    bindMagnifier() {
        const canvas = this.canvasElement;
        if (!canvas || this.onMagnifierPointerDown) {
            return;
        }
        this.onMagnifierPointerDown = event => {
            if (!this.isActive() || this.paused) {
                return;
            }
            const isMiddle = event.button === MIDDLE_BUTTON;
            const isTouch = event.pointerType === "touch" || event.pointerType === "pen";

            if (this.magnifierOpen) {
                // 环已经开着：这次按下就是拖取景环，别让看板娘一起被拖走
                if (isTouch) {
                    event.stopPropagation();
                }
                this.startLensDrag(event);
                if (isMiddle) {
                    event.preventDefault();
                }
                return;
            }

            if (isMiddle) {
                if (!this.isPointerOnHead(event.clientX, event.clientY)) {
                    return;
                }
                if (!this.toggleMagnifier(true)) {
                    return;
                }
                this.startLensDrag(event);
                event.preventDefault();
                return;
            }

            if (isTouch && this.isPointerOnHead(event.clientX, event.clientY)) {
                this.startMagnifierLongPress(event);
            }
        };
        this.onMagnifierPointerMove = event => {
            const drag = this.lensDrag;
            if (drag && event.pointerId === drag.pointerId) {
                const canvas = this.canvasElement;
                if (!canvas) {
                    return;
                }
                const rect = canvas.getBoundingClientRect();
                const deltaX = event.clientX - drag.startClientX;
                const deltaY = event.clientY - drag.startClientY;
                this.setLensFocus(
                    drag.focusX + deltaX / Math.max(rect.width, 1),
                    drag.focusY + deltaY / Math.max(rect.height, 1)
                );
                event.preventDefault();
                return;
            }
            // 还没进入放大镜：长按期间手指挪太多，就当成「拖看板娘」，取消长按
            const press = this.longPress;
            if (press && event.pointerId === press.pointerId) {
                const moved = Math.hypot(
                    event.clientX - press.startClientX,
                    event.clientY - press.startClientY
                );
                if (moved > MAGNIFIER_LONG_PRESS_TOLERANCE) {
                    this.cancelMagnifierLongPress();
                }
            }
        };
        this.onMagnifierPointerUp = event => {
            // 自己发的 pointercancel（用来让看板娘拖拽收手）不算松手
            if (event.type === "pointercancel" && this.ignorePointerCancel) {
                return;
            }
            const drag = this.lensDrag;
            if (drag && event.pointerId === drag.pointerId) {
                this.endLensDrag();
                // 松手即收回
                this.toggleMagnifier(false);
                return;
            }
            if (this.longPress && event.pointerId === this.longPress.pointerId) {
                this.cancelMagnifierLongPress();
            }
        };
        // 中键默认会触发「自动滚动 / 粘贴」，这里一并拦掉
        this.onMagnifierDefault = event => {
            if (event.button === MIDDLE_BUTTON) {
                event.preventDefault();
            }
        };
        // 触屏长按会弹出系统的「保存图片 / 选中」菜单，放大镜相关手势期间拦掉
        this.onMagnifierContextMenu = event => {
            if (this.longPress || this.lensDrag) {
                event.preventDefault();
            }
        };
        this.onEscapeKey = event => {
            if (event.key === "Escape") {
                this.toggleMagnifier(false);
            }
        };
        canvas.addEventListener("pointerdown", this.onMagnifierPointerDown);
        canvas.addEventListener("mousedown", this.onMagnifierDefault);
        canvas.addEventListener("auxclick", this.onMagnifierDefault);
        canvas.addEventListener("contextmenu", this.onMagnifierContextMenu);
        // move / up 绑在 window 上：看板娘拖动时会给 stage 设 setPointerCapture，
        // 那时指针事件不再落到画布上，只有 window 还能收到
        window.addEventListener("pointermove", this.onMagnifierPointerMove);
        window.addEventListener("pointerup", this.onMagnifierPointerUp);
        window.addEventListener("pointercancel", this.onMagnifierPointerUp);
        window.addEventListener("keydown", this.onEscapeKey);
    }

    unbindMagnifier() {
        const canvas = this.canvasElement;
        this.cancelMagnifierLongPress();
        if (canvas) {
            canvas.removeEventListener("pointerdown", this.onMagnifierPointerDown);
            canvas.removeEventListener("mousedown", this.onMagnifierDefault);
            canvas.removeEventListener("auxclick", this.onMagnifierDefault);
            canvas.removeEventListener("contextmenu", this.onMagnifierContextMenu);
        }
        if (this.onMagnifierPointerMove) {
            window.removeEventListener("pointermove", this.onMagnifierPointerMove);
            window.removeEventListener("pointerup", this.onMagnifierPointerUp);
            window.removeEventListener("pointercancel", this.onMagnifierPointerUp);
        }
        if (this.onEscapeKey) {
            window.removeEventListener("keydown", this.onEscapeKey);
        }
        this.onMagnifierPointerDown = null;
        this.onMagnifierPointerMove = null;
        this.onMagnifierPointerUp = null;
        this.onMagnifierDefault = null;
        this.onMagnifierContextMenu = null;
        this.onEscapeKey = null;
        this.lensDrag = null;
    }

    /** 触屏在头部按下：开始计时，够久且没怎么移动就弹出聚焦环 */
    startMagnifierLongPress(event) {
        this.cancelMagnifierLongPress();
        this.longPress = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY
        };
        this.longPressTimer = setTimeout(() => {
            this.longPressTimer = null;
            const press = this.longPress;
            this.longPress = null;
            if (!press || !this.isActive() || this.paused) {
                return;
            }
            // 长按成立：先让看板娘自己的拖拽手势收手（用按下点坐标，位移算作 0，
            // 这样不会被判定成「上下拽」而滑走），再弹出聚焦环并进入拖动状态
            this.cancelStageDrag(press.pointerId, press.startClientX, press.startClientY);
            if (!this.toggleMagnifier(true)) {
                return;
            }
            this.startLensDrag({
                pointerId: press.pointerId,
                clientX: press.startClientX,
                clientY: press.startClientY
            });
        }, MAGNIFIER_LONG_PRESS_MS);
    }

    cancelMagnifierLongPress() {
        if (this.longPressTimer) {
            clearTimeout(this.longPressTimer);
            this.longPressTimer = null;
        }
        this.longPress = null;
    }

    /**
     * 让看板娘（Layout.astro 里那套拖拽）把手势交出来：
     * 它监听的是同一个 pointerId，发一个 pointercancel 它会复位拖动状态，
     * 后续移动就不会再把整只看板娘拖走。
     *
     * 注意必须带上按下时的坐标：Layout 的 finishDrag 会用
     * `event.clientX - dragState.startX` 判断是不是「上下拽 → 滑到顶/底」，
     * 用默认的 0 会被算成一次巨大的向上拖动，导致长按后看板娘直接滑到顶部。
     */
    cancelStageDrag(pointerId, clientX, clientY) {
        const stage = this.stageElement;
        if (!stage) {
            return;
        }
        try {
            // 标记一下：这次 cancel 是自己发的，别被自己的 pointerup 处理当成松手
            this.ignorePointerCancel = true;
            stage.dispatchEvent(new PointerEvent("pointercancel", {
                pointerId,
                bubbles: true,
                cancelable: true,
                clientX,
                clientY,
                screenX: clientX,
                screenY: clientY,
                pageX: clientX + window.scrollX,
                pageY: clientY + window.scrollY
            }));
        } catch (error) {
            console.warn("Live2D 取消看板娘拖拽失败。", error);
        } finally {
            this.ignorePointerCancel = false;
        }
    }

    /** 开始拖动聚焦环 */
    startLensDrag(event) {
        const canvas = this.canvasElement;
        if (!canvas || !this.magnifierOpen) {
            return null;
        }
        const focus = this.lensFocus || LENS_DEFAULT_FOCUS_RATIO;
        this.lensDrag = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            focusX: focus.x,
            focusY: focus.y
        };
        try {
            canvas.setPointerCapture?.(event.pointerId);
        } catch (error) {
            // 合成事件可能没有真实的 pointerId，忽略即可
        }
        return this.lensDrag;
    }

    endLensDrag() {
        const canvas = this.canvasElement;
        if (this.lensDrag && canvas) {
            try {
                canvas.releasePointerCapture?.(this.lensDrag.pointerId);
            } catch (error) {
                // 同上
            }
        }
        this.lensDrag = null;
    }

    /**
     * 取景中心允许的范围（画布相对坐标 0~1）
     * 以模型实际占位为准，这样聚焦环不会被拖到旁边的空白处（否则环里只有镜片底色）
     */
    getLensFocusRange() {
        const canvas = this.canvasElement;
        const cssWidth = canvas?.clientWidth || 300;
        const cssHeight = canvas?.clientHeight || cssWidth;
        const halfSource = LENS_SIZE / LENS_ZOOM / 2;
        let left = 0;
        let top = 0;
        let right = cssWidth;
        let bottom = cssHeight;

        const bounds = this.model?.getBounds?.();
        if (bounds?.width > 0 && bounds?.height > 0) {
            // 往里收一点，避开模型四周的空白边
            const insetX = bounds.width * LENS_BOUNDS_INSET;
            const insetY = bounds.height * LENS_BOUNDS_INSET;
            left = Math.max(left, bounds.left + insetX);
            right = Math.min(right, bounds.right - insetX);
            top = Math.max(top, bounds.top + insetY);
            bottom = Math.min(bottom, bounds.bottom - insetY);
        }

        const toRatioRange = (min, max, size) => {
            const low = min + halfSource;
            const high = max - halfSource;
            if (low > high) {
                const center = (min + max) / 2;
                return { low: center - halfSource, high: center + halfSource };
            }
            return { low, high };
        };
        const rangeX = toRatioRange(left, right, cssWidth);
        const rangeY = toRatioRange(top, bottom, cssHeight);
        return {
            minX: Math.max(0, rangeX.low / cssWidth),
            maxX: Math.min(1, rangeX.high / cssWidth),
            minY: Math.max(0, rangeY.low / cssHeight),
            maxY: Math.min(1, rangeY.high / cssHeight)
        };
    }

    /** 设置聚焦环的取景中心（画布相对坐标 0~1），会限制在模型范围内 */
    setLensFocus(ratioX, ratioY) {
        const { minX, maxX, minY, maxY } = this.getLensFocusRange();
        const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
        this.lensFocus = {
            x: clamp(ratioX, minX, maxX),
            y: clamp(ratioY, minY, maxY)
        };
        this.positionMagnifier();
        if (this.magnifierOpen) {
            // 拖到头部/身体不同区域时，表情与动作跟着切
            this.syncMagnifierReaction();
            this.updateLens();
        }
    }

    /** 视口坐标是否落在她的头部范围内 */
    isPointerOnHead(clientX, clientY) {
        const canvas = this.canvasElement;
        if (!canvas) {
            return false;
        }
        const rect = canvas.getBoundingClientRect();
        const headX = rect.left + rect.width * HEAD_CENTER_RATIO.x;
        const headY = rect.top + rect.height * HEAD_CENTER_RATIO.y;
        return Math.hypot(clientX - headX, clientY - headY) <= rect.width * HEAD_RADIUS_RATIO;
    }

    /**
     * 开关聚焦环
     * @param {boolean} [open] 不传则切换
     */
    toggleMagnifier(open = !this.magnifierOpen) {
        const next = Boolean(open) && this.isActive() && Boolean(this.model);
        if (this.magnifierOpen === next) {
            return this.magnifierOpen;
        }
        this.magnifierOpen = next;
        if (next) {
            // 每次弹出都回到脸部取景
            this.lensFocus = { ...LENS_DEFAULT_FOCUS_RATIO };
            this.startMagnifierHints();
            this.startMagnifierReaction();
        } else {
            this.cancelMagnifierLongPress();
            this.endLensDrag();
            this.stopMagnifierHints();
            this.stopMagnifierReaction();
        }
        const magnifier = this.magnifierElement;
        if (magnifier) {
            magnifier.dataset.open = next ? "1" : "0";
        }
        if (next) {
            this.positionMagnifier();
        }
        this.applyLensResolution(next);
        if (next) {
            this.updateLens();
        }
        return this.magnifierOpen;
    }

    /** 聚焦环中心跟着取景中心走（left/top 相对 #live2d-stage） */
    positionMagnifier() {
        const magnifier = this.magnifierElement;
        const canvas = this.canvasElement;
        const stage = this.stageElement;
        if (!magnifier || !canvas || !stage) {
            return;
        }
        const focus = this.lensFocus || LENS_DEFAULT_FOCUS_RATIO;
        const canvasRect = canvas.getBoundingClientRect();
        const stageRect = stage.getBoundingClientRect();
        magnifier.style.width = `${LENS_SIZE}px`;
        magnifier.style.height = `${LENS_SIZE}px`;
        magnifier.style.left = `${canvasRect.left - stageRect.left + canvasRect.width * focus.x}px`;
        magnifier.style.top = `${canvasRect.top - stageRect.top + canvasRect.height * focus.y}px`;
    }

    /* ---------------------------------------------------------- 气泡文字 */

    startMagnifierHints() {
        const layer = this.hintsElement;
        if (!layer || this.hintsTimer) {
            return;
        }
        this.lastHint = "";
        this.hintBurstLeft = 0;
        this.scheduleMagnifierHint(true);
    }

    stopMagnifierHints() {
        if (this.hintsTimer) {
            clearTimeout(this.hintsTimer);
            this.hintsTimer = null;
        }
        this.hintBurstLeft = 0;
        const layer = this.hintsElement;
        if (layer) {
            layer.textContent = "";
        }
    }

    /**
     * 排下一个气泡：间隔随机，偶尔进入「急促模式」连冒几句，
     * 其余时候隔久一点，看起来像是害羞到语无伦次 / 欲言又止。
     */
    scheduleMagnifierHint(isFirst = false) {
        const layer = this.hintsElement;
        if (!layer) {
            return;
        }
        const tempo = MAGNIFIER_HINT_TEMPO[this.getMagnifierZone()] || MAGNIFIER_HINT_TEMPO.body;
        let delay;
        if (isFirst) {
            delay = randomBetween(...tempo.first);
        } else if (this.hintBurstLeft > 0) {
            this.hintBurstLeft -= 1;
            delay = randomBetween(...tempo.fast);
        } else if (Math.random() < tempo.burstChance) {
            this.hintBurstLeft = Math.round(Math.random() * 2);
            delay = randomBetween(...tempo.fast);
        } else {
            delay = randomBetween(...tempo.slow);
        }
        this.hintsTimer = setTimeout(() => {
            this.hintsTimer = null;
            this.spawnMagnifierHint();
            this.scheduleMagnifierHint();
        }, delay);
    }

    /** 在聚焦环上方随机位置冒一个气泡，动画结束自动移除 */
    spawnMagnifierHint() {
        const layer = this.hintsElement;
        if (!layer) {
            return;
        }
        if (layer.childElementCount >= MAGNIFIER_HINT_MAX) {
            return;
        }
        const words = MAGNIFIER_HINTS[this.getMagnifierZone()];
        const candidates = words.filter(word => word !== this.lastHint);
        const pool = candidates.length ? candidates : words;
        const text = pool[Math.floor(Math.random() * pool.length)];
        this.lastHint = text;

        // 落在圆环上半圈的弧线上，左右交替避免气泡叠在一起
        this.hintSide = this.hintSide ? -this.hintSide : 1;
        const baseAngle = this.hintSide > 0 ? -58 : -122;
        const angle = ((baseAngle + (Math.random() * 34 - 17)) * Math.PI) / 180;
        const radius = LENS_SIZE * 0.54 + Math.random() * LENS_SIZE * 0.12;
        const bubble = document.createElement("span");
        bubble.textContent = text;
        bubble.style.left = `${LENS_SIZE / 2 + Math.cos(angle) * radius}px`;
        bubble.style.top = `${LENS_SIZE / 2 + Math.sin(angle) * radius}px`;
        bubble.style.setProperty("--tilt", `${(Math.random() * 10 - 5).toFixed(1)}deg`);
        bubble.style.animationDuration = `${(1.7 + Math.random() * 0.8).toFixed(2)}s`;
        bubble.addEventListener("animationend", () => bubble.remove(), { once: true });
        layer.appendChild(bubble);
    }

    /* ------------------------------------------------------ 表情 / 动作联动 */

    /** 取景落在头部还是身体 */
    getMagnifierZone() {
        const focus = this.lensFocus || LENS_DEFAULT_FOCUS_RATIO;
        return focus.y <= MAGNIFIER_ZONE_SPLIT ? "head" : "body";
    }

    /**
     * 打开放大镜时的联动：记住原表情 → 切到模型真实存在的对应表情 →
     * 模型真带动作文件才播动作（没有动作文件就什么都不做，不伪造动作）
     */
    startMagnifierReaction() {
        this.reactionZone = null;
        this.reactionRestored = false;
        this.reactionRestoreExpression = this.activeExpressionName;
        this.syncMagnifierReaction();
    }

    /** 取景在头部/身体之间移动时同步切换表情与动作 */
    syncMagnifierReaction() {
        const zone = this.getMagnifierZone();
        if (zone === this.reactionZone) {
            return;
        }
        this.reactionZone = zone;
        const expression = this.resolveReactionExpression(zone);
        if (expression) {
            this.applyExpression(expression);
        }
        this.reactionHasMotion = this.playReactionMotion();
    }

    /** 从模型实际存在的表情里按关键词挑一个，挑不到返回 null（不虚构表情） */
    resolveReactionExpression(zone) {
        const keywords = MAGNIFIER_EXPRESSION_KEYWORDS[zone] || [];
        const names = [...this.expressions.keys()];
        for (const keyword of keywords) {
            const lowerKeyword = keyword.toLowerCase();
            const hit = names.find(name => name.toLowerCase().includes(lowerKeyword));
            if (hit) {
                return hit;
            }
        }
        return null;
    }

    /**
     * 播模型自带的「扭捏 / 害羞」类动作（按组名关键词匹配，匹配不到用第一组）
     * 模型没有动作文件时返回 false，调用方不做任何补偿动作
     */
    playReactionMotion() {
        const motionManager = this.model?.internalModel?.motionManager;
        const definitions = motionManager?.definitions;
        if (!definitions) {
            return false;
        }
        const groups = Object.keys(definitions).filter(group => definitions[group]?.length);
        if (!groups.length) {
            return false;
        }
        const lowerGroups = groups.map(group => ({ group, lower: group.toLowerCase() }));
        const matched = MAGNIFIER_MOTION_KEYWORDS.map(keyword => keyword.toLowerCase())
            .map(keyword => lowerGroups.find(item => item.lower.includes(keyword)))
            .find(Boolean);
        const group = matched?.group ?? groups[0];
        const count = definitions[group]?.length ?? 1;
        const index = Math.floor(Math.random() * count);
        try {
            const priority = window.PIXI?.live2d?.MotionPriority?.NORMAL ?? 2;
            this.model.motion(group, index, priority);
            return true;
        } catch (error) {
            console.warn("Live2D 动作播放失败。", error);
            return false;
        }
    }

    /** 收起放大镜：恢复原来的表情 */
    stopMagnifierReaction() {
        this.reactionHasMotion = false;
        if (!this.reactionRestored) {
            this.reactionRestored = true;
            this.applyExpression(this.reactionRestoreExpression || null);
        }
    }

    /**
     * 镜片底的画布（按尺寸缓存）
     * 做法：把环覆盖区域的画面 1:1 抠出来、模糊 + 压暗后铺满镜片。
     * 这样底色不透明（挡住后面原始大小的模型，避免重影），又保留周围真实颜色。
     */
    getLensBackdropCanvas(size) {
        if (!this.lensBackdrop || this.lensBackdrop.width !== size) {
            this.lensBackdrop = document.createElement("canvas");
            this.lensBackdrop.width = size;
            this.lensBackdrop.height = size;
        }
        return this.lensBackdrop;
    }

    paintLensBackdrop(context, size, canvas, pixelRatio, cssWidth, cssHeight) {
        const backdrop = this.getLensBackdropCanvas(size);
        const backdropContext = backdrop.getContext("2d");
        const focus = this.lensFocus || LENS_DEFAULT_FOCUS_RATIO;
        const ringLeft = focus.x * cssWidth - LENS_SIZE / 2;
        const ringTop = focus.y * cssHeight - LENS_SIZE / 2;

        backdropContext.setTransform(1, 0, 0, 1, 0, 0);
        backdropContext.clearRect(0, 0, size, size);
        backdropContext.save();
        backdropContext.beginPath();
        backdropContext.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        backdropContext.clip();
        backdropContext.filter = `blur(${Math.max(3, Math.round(size * 0.08))}px) brightness(0.55) saturate(1.1)`;
        backdropContext.drawImage(
            canvas,
            ringLeft * pixelRatio,
            ringTop * pixelRatio,
            LENS_SIZE * pixelRatio,
            LENS_SIZE * pixelRatio,
            0,
            0,
            size,
            size
        );
        backdropContext.filter = "none";
        backdropContext.restore();

        context.drawImage(backdrop, 0, 0, size, size);
    }

    /** 放大时要看清细节，临时把渲染分辨率提到 2 倍 */
    applyLensResolution(boost) {
        const renderer = this.app?.renderer;
        if (!renderer) {
            return;
        }
        const baseResolution = Math.min(window.devicePixelRatio || 1, 2);
        const target = boost ? 2 : baseResolution;
        if (renderer.resolution === target) {
            return;
        }
        renderer.resolution = target;
        renderer.resize(this.boxSize.width, this.boxSize.height);
        this.fit();
    }

    /** 把画布上头部区域放大后画进聚焦环 */
    updateLens() {
        const canvas = this.canvasElement;
        const lens = this.lensElement;
        if (!canvas || !lens) {
            return;
        }
        const context = lens.getContext("2d");
        if (!context) {
            return;
        }
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const size = Math.round(LENS_SIZE * dpr);
        if (lens.width !== size || lens.height !== size) {
            lens.width = size;
            lens.height = size;
        }
        const cssWidth = canvas.clientWidth || canvas.width;
        const cssHeight = canvas.clientHeight || cssWidth;
        const pixelRatio = canvas.width / Math.max(cssWidth, 1);
        const focus = this.lensFocus || LENS_DEFAULT_FOCUS_RATIO;
        const sourceSize = (LENS_SIZE / LENS_ZOOM) * pixelRatio;
        const centerX = cssWidth * focus.x * pixelRatio;
        const centerY = cssHeight * focus.y * pixelRatio;

        context.clearRect(0, 0, size, size);
        // 先铺不透明的镜片底：模型画布是透明的，如果只画放大内容，
        // 放大区域里没有像素的地方就会透出后面原始大小的模型，看起来像重影。
        this.paintLensBackdrop(context, size, canvas, pixelRatio, cssWidth, cssHeight);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.drawImage(
            canvas,
            centerX - sourceSize / 2,
            centerY - sourceSize / 2,
            sourceSize,
            sourceSize,
            0,
            0,
            size,
            size
        );
    }

    /**
     * Cubism 2 内核会自己读取 sessionStorage 的 Sleepy 来播放睡觉动作，
     * Cubism 5 没有对应的动作组，这里同样跟随 Sleepy 状态闭眼待机。
     */
    startSleepWatcher() {
        if (this.sleepWatcher) {
            return;
        }
        this.sleepWatcher = setInterval(() => {
            if (!this.model || this.paused) {
                return;
            }
            let sleeping = false;
            try {
                sleeping = sessionStorage.getItem("Sleepy") === "1";
            } catch (error) {
                sleeping = false;
            }
            this.setSleeping(sleeping);
        }, 600);
    }

    stopSleepWatcher() {
        if (!this.sleepWatcher) {
            return;
        }
        clearInterval(this.sleepWatcher);
        this.sleepWatcher = null;
    }

    /**
     * 视线跟随与自适应：绑定在 window 上，和 Cubism 2 内核的行为保持一致
     * （离开看板娘区域也继续看着光标）
     */
    bindGlobalListeners() {
        if (this.onPointerMove) {
            return;
        }
        this.onPointerMove = event => this.focus(event.clientX, event.clientY);
        this.onWindowResize = () => this.resize();
        window.addEventListener("pointermove", this.onPointerMove, { passive: true });
        window.addEventListener("resize", this.onWindowResize);

        /* 以下都是渲染自检的触发点 */
        this.onPageVisibility = () => {
            if (!document.hidden) {
                this.scheduleIntegrityCheck("visibility");
            }
        };
        this.onPageShow = () => this.scheduleIntegrityCheck("pageshow");
        this.onPageFocus = () => this.scheduleIntegrityCheck("focus");
        document.addEventListener("visibilitychange", this.onPageVisibility);
        window.addEventListener("pageshow", this.onPageShow);
        window.addEventListener("focus", this.onPageFocus);

        // WebGL 上下文丢失（手机后台把隐藏的 canvas 回收掉时会发生）→ 恢复后立刻自检
        const canvas = this.canvasElement;
        if (canvas) {
            this.onContextLost = event => {
                // 调了 preventDefault 浏览器才会尝试恢复上下文
                event.preventDefault();
            };
            this.onContextRestored = () => this.scheduleIntegrityCheck("contextrestored", { immediate: true });
            canvas.addEventListener("webglcontextlost", this.onContextLost);
            canvas.addEventListener("webglcontextrestored", this.onContextRestored);
        }

        // 关掉看板娘时 stage 会缩成 0×0，重新打开再变回来，正好用来做一次自检
        if (window.ResizeObserver) {
            const stage = this.stageElement;
            if (stage) {
                this.stageObserver = new ResizeObserver(() => this.scheduleIntegrityCheck("stage-resize"));
                this.stageObserver.observe(stage);
            }
        }
    }

    unbindGlobalListeners() {
        if (!this.onPointerMove) {
            return;
        }
        window.removeEventListener("pointermove", this.onPointerMove);
        window.removeEventListener("resize", this.onWindowResize);
        document.removeEventListener("visibilitychange", this.onPageVisibility);
        window.removeEventListener("pageshow", this.onPageShow);
        window.removeEventListener("focus", this.onPageFocus);
        const canvas = this.canvasElement;
        if (canvas) {
            canvas.removeEventListener("webglcontextlost", this.onContextLost);
            canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
        }
        this.stageObserver?.disconnect();
        this.stageObserver = null;
        if (this.integrityTimer) {
            clearTimeout(this.integrityTimer);
            this.integrityTimer = null;
        }
        this.onPointerMove = null;
        this.onWindowResize = null;
    }

    async fetchJson(url) {
        const response = await fetch(url, { cache: "no-cache" });
        if (!response.ok) {
            throw new Error(`加载 ${url} 失败：${response.status}`);
        }
        return await response.json();
    }

    /* ---------------------------------------------------------------- 模型加载 */

    /**
     * 切换 / 加载 Cubism 5 模型
     * @param {string} modelUrl model3.json 的完整地址
     */
    async show(modelUrl) {
        if (this.modelPath === modelUrl && this.model) {
            this.resume();
            this.setRenderer("cubism5");
            return this.model;
        }
        if (this.preparePromise && this.modelPath === modelUrl) {
            await this.preparePromise;
            this.resume();
            this.setRenderer("cubism5");
            return this.model;
        }
        this.modelPath = modelUrl;
        this.preparePromise = this.prepare(modelUrl);
        try {
            await this.preparePromise;
        } finally {
            this.preparePromise = null;
        }
        this.setRenderer("cubism5");
        return this.model;
    }

    async prepare(modelUrl) {
        const settings = await this.fetchJson(modelUrl);
        this.settings = settings;
        this.widgetConfig = settings.WidgetConfig || {};
        this.persistentParameters = this.widgetConfig.PersistentParameters || {};
        // 每次换模型都按「用户调过的位置 → model3.json 的 OffsetX → 0」重新取一次
        this.offsetX = this.resolveHorizontalOffset();

        const [Live2DModel] = await Promise.all([
            this.ensureVendor(),
            this.loadExpressions(modelUrl, settings)
        ]);

        if (!this.app) {
            this.createApp();
        }

        const previousModel = this.model;
        this.model = null;
        if (previousModel) {
            this.app.stage.removeChild(previousModel);
            previousModel.destroy();
        }

        const model = await Live2DModel.from(modelUrl, {
            // 鼠标跟随与点击由看板娘自身的交互逻辑统一处理，避免重复绑定
            autoInteract: false,
            autoUpdate: true
        });
        this.model = model;
        this.app.stage.addChild(model);

        this.fit();
        this.sleeping = false;
        this.clearExpression();
        this.applyPersistentParameters();
        this.resume();
        // 加载完也查一次，避免一开始就带着异常状态
        this.scheduleIntegrityCheck("model-ready");
        return model;
    }

    async loadExpressions(modelUrl, settings) {
        this.expressions = new Map();
        this.expressionCycle = [];
        this.expressionMessages = [];
        const baseUrl = modelUrl.slice(0, modelUrl.lastIndexOf("/") + 1);

        const definitions = settings?.FileReferences?.Expressions || [];
        await Promise.all(definitions.map(async definition => {
            const file = definition.File;
            if (!file) {
                return;
            }
            const url = file.startsWith("http") || file.startsWith("/") ? file : `${baseUrl}${file}`;
            try {
                const json = await this.fetchJson(url);
                const parameters = (json.Parameters || [])
                    .filter(item => item && typeof item.Id === "string")
                    .map(item => ({
                        id: item.Id,
                        value: Number.isFinite(item.Value) ? item.Value : 0,
                        blend: item.Blend || "Add"
                    }));
                this.expressions.set(definition.Name || file, parameters);
            } catch (error) {
                console.warn(`Live2D 表情加载失败：${url}`, error);
            }
        }));

        const cycle = this.widgetConfig.ExpressionCycle;
        if (Array.isArray(cycle)) {
            this.expressionCycle = cycle;
        } else {
            this.expressionCycle = [null, ...this.expressions.keys()];
        }
        this.expressionMessages = Array.isArray(this.widgetConfig.ExpressionMessages)
            ? this.widgetConfig.ExpressionMessages
            : [];
    }

    /* ---------------------------------------------------------------- 渲染控制 */

    setRenderer(renderer) {
        const stage = this.stageElement;
        if (stage) {
            stage.dataset.renderer = renderer;
        }
    }

    resume() {
        if (!this.app || !this.paused) {
            return;
        }
        this.paused = false;
        this.app.ticker.start();
    }

    /** 切回 Cubism 2 模型时调用：只暂停，不销毁，切回来无需重新下载 */
    suspend() {
        this.toggleMagnifier(false);
        if (!this.app || this.paused) {
            return;
        }
        this.paused = true;
        this.app.ticker.stop();
    }

    destroy() {
        this.toggleMagnifier(false);
        this.suspend();
        this.unbindGlobalListeners();
        this.unbindMagnifier();
        this.stopSleepWatcher();
        if (this.app) {
            this.app.ticker.remove(this.onTick);
            this.app.destroy(false, { children: true });
            this.app = null;
        }
        this.model = null;
        this.modelPath = null;
    }

    /**
     * 让模型自适应画布（保持比例、底边对齐、水平居中）
     * 注意：model.width / height 反映的是「当前缩放后」的尺寸，
     * 所以要用相对倍数去乘当前 scale，否则反复 resize 会越缩越小。
     */
    fit() {
        if (!this.model || !this.app) {
            return;
        }
        const { width, height } = this.boxSize;
        const scaleFactor = Number.isFinite(this.widgetConfig.Scale) ? this.widgetConfig.Scale : 1;
        const currentScale = this.model.scale.x || 1;
        const fitFactor = Math.min(
            width / Math.max(this.model.width, 1),
            height / Math.max(this.model.height, 1)
        ) * scaleFactor;
        const nextScale = currentScale * fitFactor;
        const offsetY = Number.isFinite(this.widgetConfig.OffsetY) ? this.widgetConfig.OffsetY : 0;
        this.model.anchor.set(0.5, 1);
        this.model.scale.set(nextScale);
        this.model.position.set(width / 2 + this.offsetX, height + offsetY);
    }

    /** 用户存过的水平位置优先，其次 model3.json 的 OffsetX，最后居中 */
    resolveHorizontalOffset() {
        if (Number.isFinite(this.storedOffsetX)) {
            return clampWaifuOffset(this.storedOffsetX);
        }
        return clampWaifuOffset(this.widgetConfig.OffsetX);
    }

    getHorizontalOffset() {
        return this.offsetX;
    }

    /**
     * 左右挪动模型（px，正数向右）。只改坐标、不重算缩放，
     * 所以拖动滑块时不会有缩放抖动。返回夹取后的实际值。
     */
    setHorizontalOffset(value) {
        const next = clampWaifuOffset(value);
        this.storedOffsetX = next;
        this.offsetX = next;
        this.applyHorizontalOffset();
        return next;
    }

    applyHorizontalOffset() {
        if (!this.model) {
            return;
        }
        this.model.position.x = this.boxSize.width / 2 + this.offsetX;
    }

    resize() {
        if (!this.app || !this.model) {
            return;
        }
        const { width, height } = this.boxSize;
        this.app.renderer.resize(width, height);
        this.fit();
    }

    /* ------------------------------------------------------ 渲染自检与自愈 */

    /**
     * 采样当前画布上真正的可见像素，返回总数与「头部区域（画布上三分之一）」像素数。
     * 因为 createApp 开了 preserveDrawingBuffer，这里能直接 drawImage 读 WebGL 画布内容，
     * 拿到的是用户实际看到的画面。
     */
    sampleCanvasPixels(size = INTEGRITY_SAMPLE_SIZE) {
        const canvas = this.canvasElement;
        if (!canvas || !canvas.width || !canvas.height) {
            return null;
        }
        if (!this.sampleCanvas) {
            this.sampleCanvas = document.createElement("canvas");
        }
        const sample = this.sampleCanvas;
        sample.width = size;
        sample.height = size;
        const context = sample.getContext("2d", { willReadFrequently: true });
        if (!context) {
            return null;
        }
        try {
            context.clearRect(0, 0, size, size);
            context.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, size, size);
        } catch (error) {
            return null;
        }
        const { data } = context.getImageData(0, 0, size, size);
        const headRows = Math.max(1, Math.round(size * INTEGRITY_HEAD_RATIO));
        let total = 0;
        let head = 0;
        for (let y = 0; y < size; y += 1) {
            for (let x = 0; x < size; x += 1) {
                if (data[((y * size) + x) * 4 + 3] > 8) {
                    total += 1;
                    if (y < headRows) {
                        head += 1;
                    }
                }
            }
        }
        return { total, head, size };
    }

    /**
     * 自检：画布上「身体在、头部整块没了」是手机上出现过的一种异常，
     * 这里用像素比例认出来，然后重建渲染器。
     */
    checkRenderIntegrity(reason) {
        if (!this.isActive() || this.paused || this.rebuilding || !this.model) {
            return;
        }
        const stage = this.stageElement;
        if (!stage || !stage.clientWidth || !stage.clientHeight) {
            // 看板娘正被隐藏，等重新显示时再查
            return;
        }
        const stats = this.sampleCanvasPixels();
        if (!stats || stats.total < INTEGRITY_MIN_TOTAL) {
            return;
        }
        const headRatio = stats.head / stats.total;
        if (headRatio >= INTEGRITY_MIN_HEAD) {
            return;
        }
        const now = Date.now();
        if (now - this.lastRebuildAt < INTEGRITY_REBUILD_COOLDOWN) {
            return;
        }
        this.lastRebuildAt = now;
        console.warn(
            `Live2D 渲染异常（${reason}：头部像素占比 ${(headRatio * 100).toFixed(1)}%），正在重建渲染器。`,
            stats
        );
        this.rebuildRenderer();
    }

    /** 事件之后延迟自检，等这一帧画完再采样，避免误判 */
    scheduleIntegrityCheck(reason, { immediate = false } = {}) {
        if (this.integrityTimer) {
            clearTimeout(this.integrityTimer);
            this.integrityTimer = null;
        }
        this.integrityTimer = setTimeout(() => {
            this.integrityTimer = null;
            this.checkRenderIntegrity(reason);
        }, immediate ? 0 : INTEGRITY_CHECK_DELAY);
    }

    /**
     * 重建渲染器：换一块全新的 canvas，重新创建 pixi 实例并加载同一个模型。
     * 换节点是为了把旧画布上可能残留的 WebGL / 合成层状态一并丢掉。
     */
    async rebuildRenderer() {
        const modelUrl = this.modelPath;
        const canvas = this.canvasElement;
        if (!modelUrl || !canvas || this.rebuilding) {
            return;
        }
        this.rebuilding = true;
        try {
            this.toggleMagnifier(false);
            this.unbindMagnifier();
            if (this.app) {
                this.app.ticker.remove(this.onTick);
                this.app.destroy(false, { children: true });
                this.app = null;
            }
            this.model = null;
            const fresh = canvas.cloneNode(false);
            fresh.width = this.boxSize.width;
            fresh.height = this.boxSize.height;
            canvas.replaceWith(fresh);
            // prepare 会重新建 app、加载模型与表情，并再次 bindMagnifier
            await this.prepare(modelUrl);
            this.bindMagnifier();
        } catch (error) {
            console.warn("Live2D 渲染器重建失败。", error);
        } finally {
            this.rebuilding = false;
        }
    }

    /**
     * 鼠标跟随
     * Live2DModel.focus 接收的是 pixi 的 global 坐标（canvas 逻辑坐标），
     * 所以先借助 pixi 的事件系统把视口坐标换算过去，避免自己算分辨率和 CSS 缩放。
     */
    focus(clientX, clientY) {
        if (!this.model || this.paused) {
            return;
        }
        try {
            const PIXI = window.PIXI;
            const interaction = this.app?.renderer?.plugins?.interaction;
            const point = this.point || (this.point = new PIXI.Point());
            if (interaction?.mapPositionToPoint) {
                interaction.mapPositionToPoint(point, clientX, clientY);
            } else {
                const canvas = this.canvasElement;
                const rect = canvas.getBoundingClientRect();
                const ratio = canvas.width / Math.max(rect.width, 1) / (this.app?.renderer?.resolution ?? 1);
                point.set((clientX - rect.left) * ratio, (clientY - rect.top) * ratio);
            }
            this.model.focus(point.x, point.y);
        } catch (error) {
            console.warn("Live2D 视线跟随失败。", error);
        }
    }

    /* ---------------------------------------------------------------- 参数与表情 */

    parameterValue(id) {
        const core = this.coreModel;
        if (!core) {
            return 0;
        }
        const index = core.getParameterIndex(id);
        if (index < 0) {
            return 0;
        }
        return core.getParameterDefaultValue(index);
    }

    writeParameter(id, value) {
        const core = this.coreModel;
        if (!core) {
            return;
        }
        if (core.getParameterIndex(id) < 0) {
            return;
        }
        core.setParameterValueById(id, value);
    }

    applyPersistentParameters() {
        for (const [id, value] of Object.entries(this.persistentParameters)) {
            this.writeParameter(id, value);
        }
    }

    applyExpressionParameters() {
        const active = this.activeExpression;
        if (!active) {
            return;
        }
        for (const parameter of active) {
            const base = this.persistentParameters[parameter.id] ?? this.parameterValue(parameter.id);
            this.writeParameter(
                parameter.id,
                parameter.blend === "Multiply" ? base * parameter.value : base + parameter.value
            );
        }
    }

    /** 把上一次表情改过的参数还原为模型默认值 */
    resetExpressionParameters() {
        if (!this.appliedParameterIds.size) {
            this.activeExpression = null;
            return;
        }
        for (const id of this.appliedParameterIds) {
            this.writeParameter(id, this.parameterValue(id));
        }
        this.appliedParameterIds.clear();
        this.activeExpression = null;
    }

    /** 把表情彻底恢复成默认（放大镜收起时用） */
    clearExpression() {
        this.resetExpressionParameters();
        this.activeExpressionName = null;
        this.applyPersistentParameters();
    }

    applyExpression(name) {
        if (!this.model) {
            return false;
        }
        const parameters = name ? this.expressions.get(name) : null;
        this.resetExpressionParameters();
        this.activeExpressionName = parameters ? name : null;
        if (!parameters) {
            this.applyPersistentParameters();
            return false;
        }
        this.activeExpression = parameters;
        for (const parameter of parameters) {
            this.appliedParameterIds.add(parameter.id);
        }
        this.applyExpressionParameters();
        this.applyPersistentParameters();
        return true;
    }

    /**
     * 表情轮换（对应工具栏的「换装」按钮）
     * @returns {string} 需要提示的文案，空字符串表示不提示
     */
    cycleExpression() {
        if (!this.model || !this.expressionCycle.length) {
            return "";
        }
        this.expressionIndex = ((this.expressionIndex ?? 0) + 1) % this.expressionCycle.length;
        const name = this.expressionCycle[this.expressionIndex] ?? null;
        this.applyExpression(name);
        return this.expressionMessages[this.expressionIndex] || "";
    }

    /* ---------------------------------------------------------------- 睡觉状态 */

    setSleeping(sleeping) {
        const normalized = Boolean(sleeping);
        if (this.sleeping === normalized) {
            return;
        }
        this.sleeping = normalized;
        const internalModel = this.model?.internalModel;
        if (!internalModel) {
            return;
        }
        if (normalized) {
            // 关掉自动眨眼，否则眨眼逻辑每帧都会把眼睛重新睁开
            internalModel.__eyeBlink = internalModel.eyeBlink || null;
            internalModel.eyeBlink = null;
            this.writeParameter("ParamEyeLOpen", 0);
            this.writeParameter("ParamEyeROpen", 0);
            this.writeParameter("ParamMouthOpenY", 0.1);
        } else {
            if (internalModel.__eyeBlink) {
                internalModel.eyeBlink = internalModel.__eyeBlink;
            }
            this.writeParameter("ParamEyeLOpen", 1);
            this.writeParameter("ParamEyeROpen", 1);
        }
    }

    /* ---------------------------------------------------------------- 每帧回调 */

    onTick() {
        if (!this.model) {
            return;
        }
        try {
            // 该回调注册在渲染之后，写入的参数会在下一帧生效，
            // 因此不会被眨眼 / 物理等每帧逻辑覆盖。
            this.applyExpressionParameters();
            this.applyPersistentParameters();
            if (this.sleeping) {
                this.writeParameter("ParamEyeLOpen", 0);
                this.writeParameter("ParamEyeROpen", 0);
            }
            if (this.magnifierOpen) {
                if (this.shyWiggleActive) {
                    this.applyShyWiggle();
                }
                // 必须在同一帧、pixi 渲染之后取像，否则 WebGL 缓冲区已被清空
                this.updateLens();
            }
        } catch (error) {
            // 每帧回调一旦抛错会中断 pixi 的渲染循环，这里兜住并只提示一次
            if (!this.tickErrorReported) {
                this.tickErrorReported = true;
                console.warn("Live2D 参数更新失败，已忽略。", error);
            }
        }
    }

    /* ---------------------------------------------------------------- 截图 */

    captureToDataUrl() {
        if (!this.app || !this.model) {
            return null;
        }
        try {
            const canvas = this.app.renderer.extract.canvas(this.app.stage);
            return canvas.toDataURL("image/png");
        } catch (error) {
            console.warn("Live2D 截图失败。", error);
            return null;
        }
    }
}
