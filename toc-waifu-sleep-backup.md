# 备份：TOC 栏与看板娘睡觉触发相关代码

> 备份时间：2026-07-22
> 来源：
> - [src/layouts/MainGridLayout.astro](../src/layouts/MainGridLayout.astro)
> - [src/layouts/Layout.astro](../src/layouts/Layout.astro)

---

## 一、TOC 栏代码

来源文件：`src/layouts/MainGridLayout.astro`

```astro
<!-- The things that should be under the banner, only the TOC for now -->
<div class="absolute w-full z-0 hidden lg:block">
    <div class="relative max-w-[var(--page-width)] mx-auto">
        <!-- TOC component -->
        {(siteConfig.toc.enable || isPostsRoute) && <div id="toc-wrapper" style="--toc-width-safe: var(--toc-width, 18rem);" class:list={["hidden lg:block transition absolute top-0 -right-[var(--toc-width-safe)] w-[var(--toc-width-safe)] items-center",
            {"toc-hide": enableBanner && !isPostsRoute}]}>
            <div id="toc-inner-wrapper" class="fixed top-14 bottom-8 w-[var(--toc-width-safe)] overflow-y-auto overflow-x-hidden hide-scrollbar">
                <div id="toc" class="w-full h-full transition-swup-fade ">
                    <div class="h-8 w-full"></div>
                    {siteConfig.toc.enable && <TOC headings={headings}></TOC>}
                    <BusuanziStats></BusuanziStats>
                    <div class="h-8 w-full"></div>
                </div>
            </div>
        </div>}

        <!-- #toc needs to exist for Swup to work normally -->
        {!(siteConfig.toc.enable || isPostsRoute) && <div id="toc"></div>}
    </div>
</div>
```

### 相关 import（在 MainGridLayout.astro 顶部）

```astro
import type { MarkdownHeading } from "astro";
import TOC from "../components/widget/TOC.astro";
import BusuanziStats from "@components/widget/BusuanziStats.astro";
```

---

## 二、看板娘睡觉触发相关代码

来源文件：`src/layouts/Layout.astro`

### 1. 看板娘 CSS 引用（在 `<head>` 内）

```astro
<link rel="stylesheet" href={url("/live2d-widget/waifu.css?v=20260313-1")} />
```

### 2. Live2D 初始化与睡觉交互脚本（在 `</body>` 前的完整 `<script>` 块）

```astro
<!-- Live2D 模型初始化 -->
<script>
    // @ts-nocheck
    // live2d_path 模型资源路径
    const live2d_path = "/live2d-widget/";
    const live2d_asset_version = "20260313-2";
    const live2d_asset = (path: string) => `${live2d_path}${path}?v=${live2d_asset_version}`;

    // 加载外部资源的方法
    function loadExternalResource(url, type) {
        return new Promise((resolve, reject) => {
            let tag;

            if (type === "css") {
                tag = document.createElement("link");
                tag.rel = "stylesheet";
                tag.href = url;
            } else if (type === "js") {
                tag = document.createElement("script");
                tag.src = url;
            }
            if (tag) {
                tag.onload = () => resolve(url);
                tag.onerror = () => reject(url);
                document.head.appendChild(tag);
            }
        });
    }

    async function normalizeLive2DModelSelection(modelListPath) {
        const parseStoredInt = (key) => {
            const rawValue = localStorage.getItem(key);
            if (rawValue === null) {
                return null;
            }
            const parsedValue = Number.parseInt(rawValue, 10);
            return Number.isInteger(parsedValue) ? parsedValue : null;
        };

        let nextModelId = parseStoredInt("modelId");
        let nextTextureId = parseStoredInt("modelTexturesId");

        try {
            const response = await fetch(modelListPath, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`Failed to load model list: ${response.status}`);
            }
            const modelList = await response.json();
            const models = Array.isArray(modelList?.models) ? modelList.models : [];

            if (!models.length) {
                throw new Error("Model list is empty");
            }

            if (
                nextModelId === null ||
                nextModelId < 0 ||
                nextModelId >= models.length
            ) {
                nextModelId = 0;
            }

            const selectedModel = models[nextModelId];
            if (Array.isArray(selectedModel)) {
                if (
                    nextTextureId === null ||
                    nextTextureId < 0 ||
                    nextTextureId >= selectedModel.length
                ) {
                    nextTextureId = 0;
                }
            } else {
                nextTextureId = 0;
            }
        } catch (error) {
            console.warn("Live2D model cache invalid, reset to defaults.", error);
            nextModelId = 0;
            nextTextureId = 0;
        }

        localStorage.setItem("modelId", String(nextModelId));
        localStorage.setItem("modelTexturesId", String(nextTextureId));
    }

    // 加载 live2d.min.js waifu-tips.js（waifu.css 走静态 <head> 链接）
    if (screen.width >= 768) {
        Promise.all([
            loadExternalResource(live2d_asset("live2d.min.js"), "js"),
            loadExternalResource(live2d_asset("waifu-tips.js"), "js")
        ]).then(async () => {
            await normalizeLive2DModelSelection(
                live2d_asset("model/model_list.json")
            );
            // 初始化 Live2D 模型，具体配置见 README.md
            initWidget({
                isLocalModel: true, // 使用本地模型
                waifuPath: live2d_asset("waifu-tips.json"),
                modelsPath: live2d_path + "model",
                modelListPath: live2d_asset("model/model_list.json"),
                tools: ["hitokoto", "asteroids", "switch-model", "switch-texture", "photo", "info", "mute", "quit"]
            });

            const initWaifuInteractions = () => {
                const waifuElement = document.getElementById("waifu");
                const live2dElement = document.getElementById("live2d");
                if (!waifuElement || !live2dElement) {
                    return false;
                }
                if (waifuElement.dataset.dragReady === "1") {
                    return true;
                }
                waifuElement.dataset.dragReady = "1";

                const waifuToolElement = document.getElementById("waifu-tool");
                const waifuPositionStorageKey = "waifu-position";
                const toolbarPlacementStorageKey = "waifu-toolbar-placement";
                const waifuMuteStorageKey = "waifu-muted";
                const waifuSleepStorageKey = "Sleepy";
                const waifuSleepTimerStorageKey = "SleepyTimer";
                const tapResetMaxDelayMs = 360;
                const tapResetMaxDistancePx = 30;
                const tapResetMaxMovementPx = 10;
                const tapResetMaxDurationMs = 260;
                const resetMessages = [
                    "双击收到，我回左下角待机啦。",
                    "归位完成，我在左下角等你。",
                    "已回到左下角，随时听候召唤~"
                ];
                const sleepingMessages = [
                    "唔……还没睡够，让我再眯一会儿。",
                    "呼……现在是睡觉时间。",
                    "别吵嘛，我还在做梦呢……",
                    "好困……让我再睡一小会儿。"
                ];
                const wakeUpMessages = [
                    "唔……你把我叫醒啦？",
                    "早呀，我醒过来了~",
                    "睡饱啦，继续陪你一会儿。",
                    "我醒啦，有什么事吗？"
                ];
                const randomPick = (messages: string[]) =>
                    messages[Math.floor(Math.random() * messages.length)];
                const readStoredPosition = () => {
                    try {
                        const rawValue = localStorage.getItem(waifuPositionStorageKey);
                        if (!rawValue) {
                            return null;
                        }
                        const parsed = JSON.parse(rawValue);
                        if (
                            parsed &&
                            Number.isFinite(parsed.left) &&
                            Number.isFinite(parsed.bottom)
                        ) {
                            return {
                                left: parsed.left,
                                bottom: parsed.bottom
                            };
                        }
                    } catch (error) {
                        console.warn("Failed to parse waifu position cache.", error);
                    }
                    return null;
                };
                const writeStoredPosition = (left: number, bottom: number) => {
                    try {
                        localStorage.setItem(
                            waifuPositionStorageKey,
                            JSON.stringify({ left, bottom })
                        );
                    } catch (error) {
                        console.warn("Failed to persist waifu position.", error);
                    }
                };
                const readStoredToolbarPlacement = () => {
                    try {
                        return localStorage.getItem(toolbarPlacementStorageKey) === "right"
                            ? "right"
                            : "bottom";
                    } catch (error) {
                        console.warn("Failed to read waifu toolbar placement.", error);
                        return "bottom";
                    }
                };
                const writeStoredToolbarPlacement = (placement: "bottom" | "right") => {
                    try {
                        localStorage.setItem(
                            toolbarPlacementStorageKey,
                            placement === "right" ? "right" : "bottom"
                        );
                    } catch (error) {
                        console.warn("Failed to persist waifu toolbar placement.", error);
                    }
                };
                const isWaifuMuted = () => {
                    try {
                        return localStorage.getItem(waifuMuteStorageKey) === "1";
                    } catch (error) {
                        console.warn("Failed to read waifu mute state.", error);
                        return false;
                    }
                };
                const isWaifuSleeping = () => {
                    try {
                        return sessionStorage.getItem(waifuSleepStorageKey) === "1";
                    } catch (error) {
                        console.warn("Failed to read waifu sleep state.", error);
                        return false;
                    }
                };
                let waifuTipTimer: ReturnType<typeof window.setTimeout> | 0 = 0;
                const hideWaifuMessage = () => {
                    const tipsElement = document.getElementById("waifu-tips");
                    if (!tipsElement) {
                        return;
                    }
                    if (waifuTipTimer) {
                        clearTimeout(waifuTipTimer);
                        waifuTipTimer = 0;
                    }
                    tipsElement.classList.remove("waifu-tips-active");
                };
                const showWaifuMessage = (
                    text: string,
                    duration = 2400,
                    options: {
                        force?: boolean;
                    } = {}
                ) => {
                    const { force = false } = options;
                    if (!text || (isWaifuMuted() && !force)) {
                        return false;
                    }
                    const tipsElement = document.getElementById("waifu-tips");
                    if (!tipsElement) {
                        return false;
                    }
                    if (waifuTipTimer) {
                        clearTimeout(waifuTipTimer);
                        waifuTipTimer = 0;
                    }
                    tipsElement.innerHTML = text;
                    tipsElement.classList.add("waifu-tips-active");
                    waifuTipTimer = setTimeout(() => {
                        tipsElement.classList.remove("waifu-tips-active");
                        waifuTipTimer = 0;
                    }, duration);
                    return true;
                };
                window.addEventListener("waifu:mutechange", hideWaifuMessage);
                const updateToolbarSide = () => {
                    if (!waifuToolElement) {
                        return;
                    }
                    if (waifuToolElement.dataset.placement !== "right") {
                        return;
                    }
                    const waifuRect = waifuElement.getBoundingClientRect();
                    const waifuCenterX = waifuRect.left + (waifuRect.width / 2);
                    waifuToolElement.dataset.side =
                        waifuCenterX >= (window.innerWidth / 2) ? "left" : "right";
                };
                const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
                const getBounds = () => ({
                    maxLeft: Math.max(0, window.innerWidth - waifuElement.offsetWidth),
                    maxBottom: Math.max(0, window.innerHeight - waifuElement.offsetHeight)
                });
                const getCurrentPosition = () => {
                    const computedStyle = window.getComputedStyle(waifuElement);
                    return {
                        left: Number.parseFloat(computedStyle.left) || 0,
                        bottom: Number.parseFloat(computedStyle.bottom) || 0
                    };
                };
                const applyPosition = (left, bottom, options = {}) => {
                    const { persist = false } = options;
                    const { maxLeft, maxBottom } = getBounds();
                    const clampedLeft = clamp(left, 0, maxLeft);
                    const clampedBottom = clamp(bottom, 0, maxBottom);
                    waifuElement.style.left = `${clampedLeft}px`;
                    waifuElement.style.bottom = `${clampedBottom}px`;
                    if (persist) {
                        writeStoredPosition(clampedLeft, clampedBottom);
                    }
                    updateToolbarSide();
                    return {
                        left: clampedLeft,
                        bottom: clampedBottom
                    };
                };
                const persistCurrentPosition = () => {
                    const { left, bottom } = getCurrentPosition();
                    writeStoredPosition(left, bottom);
                };

                const dragState = {
                    active: false,
                    pointerId: null,
                    startX: 0,
                    startY: 0,
                    startTime: 0,
                    baseLeft: 0,
                    baseBottom: 0,
                    isGliding: false,
                    glideRafId: 0,
                    glideLeft: 0,
                    glideBottom: 0,
                    glideVelocity: 0,
                    glideLastTime: 0,
                    glideLastBottom: 0,
                    stopRafId: 0
                };
                const tapState = {
                    lastTapTime: 0,
                    lastTapX: 0,
                    lastTapY: 0
                };
                let suppressCanvasClickUntil = 0;

                const toolbarToggleButtonId = "waifu-tool-placement";
                const setToolbarPlacement = (
                    placement: "bottom" | "right",
                    options: {
                        persist?: boolean;
                    } = {}
                ) => {
                    const { persist = true } = options;
                    if (!waifuToolElement) {
                        return;
                    }
                    const normalizedPlacement =
                        placement === "right" ? "right" : "bottom";
                    waifuToolElement.dataset.placement = normalizedPlacement;
                    if (normalizedPlacement === "right") {
                        updateToolbarSide();
                    } else {
                        waifuToolElement.dataset.side = "right";
                    }
                    if (persist) {
                        writeStoredToolbarPlacement(normalizedPlacement);
                    }
                };
                const toggleToolbarPlacement = () => {
                    if (!waifuToolElement) {
                        return;
                    }
                    const currentPlacement =
                        waifuToolElement.dataset.placement === "right"
                            ? "right"
                            : "bottom";
                    setToolbarPlacement(
                        currentPlacement === "right" ? "bottom" : "right"
                    );
                };
                const mountToolbarToggleButton = () => {
                    if (!waifuToolElement || document.getElementById(toolbarToggleButtonId)) {
                        return;
                    }
                    const quitButton = document.getElementById("waifu-tool-quit");
                    const buttonHtml =
                        `<span id="${toolbarToggleButtonId}">&#10565;</span>`;
                    if (quitButton) {
                        quitButton.insertAdjacentHTML("beforebegin", buttonHtml);
                    } else {
                        waifuToolElement.insertAdjacentHTML("beforeend", buttonHtml);
                    }
                    const toggleButton = document.getElementById(toolbarToggleButtonId);
                    if (toggleButton) {
                        toggleButton.addEventListener("click", (event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleToolbarPlacement();
                        });
                    }
                };

                mountToolbarToggleButton();
                setToolbarPlacement(readStoredToolbarPlacement(), { persist: false });

                const clearMotionFrames = () => {
                    if (dragState.glideRafId) {
                        cancelAnimationFrame(dragState.glideRafId);
                        dragState.glideRafId = 0;
                    }
                    if (dragState.stopRafId) {
                        cancelAnimationFrame(dragState.stopRafId);
                        dragState.stopRafId = 0;
                    }
                };

                const getIsAutoMoving = () => dragState.isGliding || dragState.stopRafId !== 0;
                const restoreTransition = () => {
                    waifuElement.style.transition = "";
                };
                const animateToPosition = (targetLeft, targetBottom, options = {}) => {
                    const { persist = false } = options;
                    clearMotionFrames();
                    dragState.isGliding = false;
                    dragState.glideVelocity = 0;

                    const startPosition = getCurrentPosition();
                    const distance = Math.hypot(
                        targetLeft - startPosition.left,
                        targetBottom - startPosition.bottom
                    );
                    const duration = Math.min(700, Math.max(280, distance * 1.3));

                    waifuElement.style.transition = "none";
                    if (distance < 1) {
                        applyPosition(targetLeft, targetBottom, { persist });
                        restoreTransition();
                        return;
                    }

                    const startTime = performance.now();
                    const easeOutCubic = (progress) => 1 - ((1 - progress) ** 3);
                    const tick = (now) => {
                        const progress = Math.min(1, (now - startTime) / duration);
                        const eased = easeOutCubic(progress);
                        dragState.glideLeft =
                            startPosition.left +
                            ((targetLeft - startPosition.left) * eased);
                        dragState.glideBottom =
                            startPosition.bottom +
                            ((targetBottom - startPosition.bottom) * eased);
                        applyPosition(dragState.glideLeft, dragState.glideBottom);

                        if (progress < 1) {
                            dragState.stopRafId = requestAnimationFrame(tick);
                        } else {
                            dragState.stopRafId = 0;
                            applyPosition(targetLeft, targetBottom, { persist });
                            restoreTransition();
                        }
                    };

                    dragState.stopRafId = requestAnimationFrame(tick);
                };
                const resetWaifuPositionToCorner = () => {
                    stopGlideImmediately();
                    animateToPosition(0, 0, { persist: true });
                    showWaifuMessage(randomPick(resetMessages));
                };
                const wakeWaifu = () => {
                    try {
                        const sleepTimer = Number.parseInt(
                            sessionStorage.getItem(waifuSleepTimerStorageKey) || "",
                            10
                        );
                        if (Number.isFinite(sleepTimer)) {
                            clearTimeout(sleepTimer);
                        }
                        sessionStorage.removeItem(waifuSleepTimerStorageKey);
                        sessionStorage.setItem(waifuSleepStorageKey, "0");
                    } catch (error) {
                        console.warn("Failed to update waifu sleep state.", error);
                    }
                    showWaifuMessage(randomPick(wakeUpMessages));
                };
                const handleWaifuTap = (clientX, clientY) => {
                    const now = performance.now();
                    const elapsed = now - tapState.lastTapTime;
                    const deltaDistance = Math.hypot(
                        clientX - tapState.lastTapX,
                        clientY - tapState.lastTapY
                    );
                    if (
                        elapsed <= tapResetMaxDelayMs &&
                        deltaDistance <= tapResetMaxDistancePx
                    ) {
                        tapState.lastTapTime = 0;
                        suppressCanvasClickUntil = now + tapResetMaxDelayMs;
                        if (isWaifuSleeping()) {
                            wakeWaifu();
                        } else {
                            resetWaifuPositionToCorner();
                        }
                        return true;
                    }
                    tapState.lastTapTime = now;
                    tapState.lastTapX = clientX;
                    tapState.lastTapY = clientY;
                    if (isWaifuSleeping()) {
                        suppressCanvasClickUntil = now + tapResetMaxDelayMs;
                        showWaifuMessage(randomPick(sleepingMessages));
                    }
                    return false;
                };

                const stopGlideImmediately = () => {
                    clearMotionFrames();
                    if (getIsAutoMoving()) {
                        applyPosition(dragState.glideLeft, dragState.glideBottom);
                    }
                    dragState.isGliding = false;
                    dragState.glideVelocity = 0;
                    restoreTransition();
                    persistCurrentPosition();
                };

                const softStopGlide = () => {
                    if (!dragState.isGliding) {
                        if (dragState.stopRafId) {
                            cancelAnimationFrame(dragState.stopRafId);
                            dragState.stopRafId = 0;
                        }
                        return;
                    }

                    const fromLeft = dragState.glideLeft;
                    const fromBottom = dragState.glideBottom;
                    const { maxBottom } = getBounds();
                    const extraDistance = clamp(dragState.glideVelocity * 140, -90, 90);
                    const targetBottom = clamp(fromBottom + extraDistance, 0, maxBottom);

                    clearMotionFrames();
                    dragState.isGliding = false;
                    dragState.glideVelocity = 0;
                    waifuElement.style.transition = "none";

                    if (Math.abs(targetBottom - fromBottom) < 1) {
                        applyPosition(fromLeft, fromBottom, { persist: true });
                        restoreTransition();
                        return;
                    }

                    const duration = 220;
                    const startTime = performance.now();
                    const easeOutQuart = (progress) => 1 - ((1 - progress) ** 4);
                    const tick = (now) => {
                        const progress = Math.min(1, (now - startTime) / duration);
                        const eased = easeOutQuart(progress);
                        dragState.glideLeft = fromLeft;
                        dragState.glideBottom = fromBottom + ((targetBottom - fromBottom) * eased);
                        applyPosition(dragState.glideLeft, dragState.glideBottom);

                        if (progress < 1) {
                            dragState.stopRafId = requestAnimationFrame(tick);
                        } else {
                            dragState.stopRafId = 0;
                            restoreTransition();
                            persistCurrentPosition();
                        }
                    };

                    dragState.stopRafId = requestAnimationFrame(tick);
                };

                const startVerticalGlide = (direction) => {
                    clearMotionFrames();
                    const currentPosition = getCurrentPosition();
                    const { maxBottom } = getBounds();
                    const targetBottom = direction > 0 ? maxBottom : 0;
                    const distance = Math.abs(targetBottom - currentPosition.bottom);
                    if (distance < 1) {
                        return;
                    }

                    const duration = Math.min(1100, Math.max(320, distance * 1.5));
                    const startBottom = currentPosition.bottom;
                    const startTime = performance.now();

                    waifuElement.style.transition = "none";
                    dragState.isGliding = true;
                    dragState.glideLeft = currentPosition.left;
                    dragState.glideBottom = currentPosition.bottom;
                    dragState.glideVelocity = 0;
                    dragState.glideLastTime = startTime;
                    dragState.glideLastBottom = startBottom;

                    const easeOutCubic = (progress) => 1 - ((1 - progress) ** 3);
                    const tick = (now) => {
                        if (!dragState.isGliding) {
                            return;
                        }
                        const progress = Math.min(1, (now - startTime) / duration);
                        const easedProgress = easeOutCubic(progress);
                        const nextBottom = startBottom + ((targetBottom - startBottom) * easedProgress);
                        const deltaTime = Math.max(1, now - dragState.glideLastTime);
                        dragState.glideVelocity = (nextBottom - dragState.glideLastBottom) / deltaTime;
                        dragState.glideLastTime = now;
                        dragState.glideLastBottom = nextBottom;
                        dragState.glideBottom = nextBottom;
                        applyPosition(dragState.glideLeft, dragState.glideBottom);

                        if (progress < 1) {
                            dragState.glideRafId = requestAnimationFrame(tick);
                        } else {
                            dragState.isGliding = false;
                            dragState.glideRafId = 0;
                            dragState.glideVelocity = 0;
                            restoreTransition();
                            persistCurrentPosition();
                        }
                    };

                    dragState.glideRafId = requestAnimationFrame(tick);
                };

                const isVerticalTug = (deltaX, deltaY, elapsedMs) => {
                    const verticalDistance = Math.abs(deltaY);
                    const horizontalDistance = Math.abs(deltaX);
                    const verticalSpeed = verticalDistance / Math.max(1, elapsedMs);
                    const minReactionMs = 80;
                    return (
                        elapsedMs >= minReactionMs &&
                        verticalDistance >= 14 &&
                        verticalDistance >= (horizontalDistance + 6) &&
                        (verticalSpeed >= 0.04 || verticalDistance >= 42)
                    );
                };

                live2dElement.style.touchAction = "none";

                // The Live2D runtime treats every window mousemove as a wake-up signal.
                // Keep those events away from it until the explicit double tap wakes her.
                window.addEventListener("mousemove", (event) => {
                    if (!isWaifuSleeping()) {
                        return;
                    }
                    event.stopImmediatePropagation();
                }, true);

                const keepSleepingUntilDoubleTap = (event) => {
                    if (!isWaifuSleeping()) {
                        return;
                    }
                    event.preventDefault();
                    event.stopImmediatePropagation();
                };
                live2dElement.addEventListener(
                    "mousedown",
                    keepSleepingUntilDoubleTap,
                    true
                );
                live2dElement.addEventListener("click", (event) => {
                    if (
                        !isWaifuSleeping() &&
                        performance.now() > suppressCanvasClickUntil
                    ) {
                        return;
                    }
                    event.preventDefault();
                    event.stopImmediatePropagation();
                }, true);

                waifuElement.addEventListener("pointerdown", (event) => {
                    if (!getIsAutoMoving()) {
                        return;
                    }
                    if (dragState.isGliding) {
                        softStopGlide();
                    } else {
                        stopGlideImmediately();
                    }
                    event.preventDefault();
                    event.stopPropagation();
                }, true);

                live2dElement.addEventListener("pointerdown", (event) => {
                    if (event.button !== undefined && event.button !== 0) {
                        return;
                    }
                    if (getIsAutoMoving()) {
                        if (dragState.isGliding) {
                            softStopGlide();
                        } else {
                            stopGlideImmediately();
                        }
                        event.preventDefault();
                        return;
                    }

                    const { left, bottom } = getCurrentPosition();
                    dragState.active = true;
                    dragState.pointerId = event.pointerId;
                    dragState.startX = event.clientX;
                    dragState.startY = event.clientY;
                    dragState.startTime = performance.now();
                    dragState.baseLeft = left;
                    dragState.baseBottom = bottom;

                    waifuElement.style.transition = "none";
                    if (live2dElement.setPointerCapture) {
                        live2dElement.setPointerCapture(event.pointerId);
                    }
                    event.preventDefault();
                });

                live2dElement.addEventListener("pointermove", (event) => {
                    if (!dragState.active || event.pointerId !== dragState.pointerId) {
                        return;
                    }
                    const deltaX = event.clientX - dragState.startX;
                    const deltaY = event.clientY - dragState.startY;
                    const elapsedMs = performance.now() - dragState.startTime;

                    if (isVerticalTug(deltaX, deltaY, elapsedMs)) {
                        const glideDirection = deltaY < 0 ? 1 : -1;
                        const activePointerId = dragState.pointerId;
                        dragState.active = false;
                        dragState.pointerId = null;
                        if (
                            activePointerId !== null &&
                            live2dElement.releasePointerCapture
                        ) {
                            live2dElement.releasePointerCapture(activePointerId);
                        }
                        startVerticalGlide(glideDirection);
                        event.preventDefault();
                        return;
                    }
                    applyPosition(
                        dragState.baseLeft + deltaX,
                        dragState.baseBottom - deltaY
                    );
                    event.preventDefault();
                });

                const finishDrag = (event) => {
                    if (!dragState.active || event.pointerId !== dragState.pointerId) {
                        return;
                    }

                    const totalX = event.clientX - dragState.startX;
                    const totalY = event.clientY - dragState.startY;
                    const dragDuration = performance.now() - dragState.startTime;
                    const activePointerId = dragState.pointerId;
                    dragState.active = false;
                    dragState.pointerId = null;
                    if (
                        activePointerId !== null &&
                        live2dElement.releasePointerCapture
                    ) {
                        live2dElement.releasePointerCapture(activePointerId);
                    }

                    if (isVerticalTug(totalX, totalY, dragDuration)) {
                        startVerticalGlide(totalY < 0 ? 1 : -1);
                        return;
                    }
                    if (
                        event.type === "pointerup" &&
                        Math.hypot(totalX, totalY) <= tapResetMaxMovementPx &&
                        dragDuration <= tapResetMaxDurationMs
                    ) {
                        if (handleWaifuTap(event.clientX, event.clientY)) {
                            return;
                        }
                    }
                    restoreTransition();
                    persistCurrentPosition();
                };

                live2dElement.addEventListener("pointerup", finishDrag);
                live2dElement.addEventListener("pointercancel", finishDrag);

                window.addEventListener("resize", () => {
                    stopGlideImmediately();
                    const currentPosition = getCurrentPosition();
                    applyPosition(currentPosition.left, currentPosition.bottom, {
                        persist: true
                    });
                });
                setTimeout(() => {
                    const cachedPosition = readStoredPosition();
                    if (cachedPosition) {
                        applyPosition(
                            cachedPosition.left,
                            cachedPosition.bottom
                        );
                    } else {
                        persistCurrentPosition();
                    }
                }, 0);

                let headPatting = false;
                let lastX = 0;
                let headPatCount = 0;
                const headPatMessages = [
                    "欸，突然摸头干嘛呀？",
                    "好啦好啦，别一直摸嘛。",
                    "有点痒，你轻一点。",
                    "住手住手，我发型要乱了！",
                    "讨厌，你怎么又来逗我。",
                    "摸头之前至少先说一声嘛。",
                    "唔……这样好像还挺舒服的。",
                    "坏蛋，就知道趁机欺负我。",
                    "别闹啦，我都快不好意思了。",
                    "其实……再摸一下也不是不行。",
                    "嗯哼，再来一点点？",
                    "好了啦，差不多可以停了。",
                    "喂，不许趁机乱碰。"
                ];

                live2dElement.addEventListener("mousemove", (e) => {
                    if (dragState.active || getIsAutoMoving()) {
                        return;
                    }
                    if (isWaifuSleeping()) {
                        lastX = 0;
                        headPatCount = 0;
                        return;
                    }
                    const rect = live2dElement.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    const isInHeadArea = x > 80 && x < 220 && y > 20 && y < 150;

                    if (!isInHeadArea) {
                        lastX = 0;
                        headPatCount = 0;
                        return;
                    }
                    if (lastX > 0) {
                        const deltaX = Math.abs(x - lastX);
                        if (deltaX > 3) {
                            headPatCount += 1;
                            if (headPatCount > 1 && !headPatting) {
                                headPatting = true;
                                const randomMessage = headPatMessages[
                                    Math.floor(Math.random() * headPatMessages.length)
                                ];
                                const didShowMessage = showWaifuMessage(randomMessage, 2000);
                                if (!didShowMessage) {
                                    headPatting = false;
                                    headPatCount = 0;
                                    return;
                                }
                                setTimeout(() => {
                                    headPatting = false;
                                    headPatCount = 0;
                                }, 2000);
                            }
                        }
                    }
                    lastX = x;
                });

                return true;
            };

            if (!initWaifuInteractions()) {
                let retryCount = 0;
                const retryTimer = setInterval(() => {
                    retryCount += 1;
                    if (initWaifuInteractions() || retryCount >= 50) {
                        clearInterval(retryTimer);
                    }
                }, 120);
            }
        }).catch((error) => {
            console.error("Live2D initialization failed.", error);
        });
    }
</script>
```

---

## 备注

- 当前仓库中未发现独立的“看板娘自动进入睡眠”触发器代码（即没有通过 `setTimeout` 在空闲后把 `Sleepy` 设为 `1` 的逻辑）。
- 上文中与“睡觉”直接相关的部分包括：
  - 存储键：`Sleepy` / `SleepyTimer`
  - 状态读取：`isWaifuSleeping()`
  - 唤醒逻辑：`wakeWaifu()`
  - 睡觉期间的事件拦截：`keepSleepingUntilDoubleTap`、`mousemove` 拦截
  - 睡觉提示语：`sleepingMessages`、`wakeUpMessages`
  - 双击/点击交互中对睡眠状态的处理：`handleWaifuTap()`
