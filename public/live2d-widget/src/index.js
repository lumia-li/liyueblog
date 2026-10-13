import Model from "./model.js";
import showMessage from "./message.js";
import randomSelection from "./utils.js";
import tools from "./tools.js";
import LocalModel from "./localModel.js";
import createPositionControl from "./positionControl.js";

function loadWidget(config) {
    const model = config.isLocalModel ? new LocalModel(config) : new Model(config);
    // 「位置」工具的回调需要模型实例，只能在这里注入；
    // 远端模型（非本地）没有左右移动能力，就不注册这个按钮
    const positionControl = typeof model.setHorizontalOffset === "function"
        ? createPositionControl(model)
        : null;
    localStorage.removeItem("waifu-display");
    sessionStorage.removeItem("waifu-text");
    document.body.insertAdjacentHTML("beforeend", `<div id="waifu">
            <div id="waifu-tips"></div>
            <div id="live2d-stage" data-renderer="cubism2">
                <canvas id="live2d" width="800" height="800"></canvas>
                <canvas id="live2d-cubism5"></canvas>
                <div id="live2d-magnifier" data-open="0">
                    <canvas id="live2d-lens"></canvas>
                    <div id="live2d-magnifier-hints"></div>
                </div>
            </div>
            <div id="waifu-tool"></div>
        </div>`);
    // https://stackoverflow.com/questions/24148403/trigger-css-transition-on-appended-element
    setTimeout(() => {
        document.getElementById("waifu").style.bottom = 0;
    }, 0);

    (function registerTools() {
        tools["switch-model"].callback = () => model.loadOtherModel();
        tools["switch-texture"].callback = () => model.loadRandModel();
        tools["position"].callback = () => positionControl?.toggle();
        if (!Array.isArray(config.tools)) {
            config.tools = Object.keys(tools);
        }
        if (!positionControl) {
            config.tools = config.tools.filter(tool => tool !== "position");
        }
        for (let tool of config.tools) {
            if (tools[tool]) {
                const { icon, callback, mounted } = tools[tool];
                const toolElementId = `waifu-tool-${tool}`;
                document.getElementById("waifu-tool").insertAdjacentHTML("beforeend", `<span id="${toolElementId}">${icon}</span>`);
                const toolElement = document.getElementById(toolElementId);
                toolElement.addEventListener("click", callback);
                if (typeof mounted === "function") {
                    mounted(toolElement);
                }
            }
        }
    })();

    function welcomeMessage(time) {
        if (location.pathname === "/") { // 如果是主页
            for (let { hour, text } of time) {
                const now = new Date(),
                    after = hour.split("-")[0],
                    before = hour.split("-")[1] || after;
                if (after <= now.getHours() && now.getHours() <= before) {
                    return text;
                }
            }
        }
        const text = `欢迎阅读<span>「${document.title.split(" - ")[0]}」</span>`;
        let from;
        if (document.referrer !== "") {
            const referrer = new URL(document.referrer),
                domain = referrer.hostname.split(".")[1];
            const domains = {
                "baidu": "百度",
                "so": "360搜索",
                "google": "谷歌搜索"
            };
            if (location.hostname === referrer.hostname) return text;

            if (domain in domains) from = domains[domain];
            else from = referrer.hostname;
            return `Hello！来自 <span>${from}</span> 的朋友<br>${text}`;
        }
        return text;
    }

    function registerEventListener(result) {
        const pageType = document.body?.dataset?.pageType || document.documentElement?.dataset?.pageType || "";
        const notFoundMessages = Array.isArray(result.message.notFound) ? result.message.notFound : [];
        const isNotFoundPage = pageType === "404" && notFoundMessages.length > 0;
        // 检测用户活动状态，并在空闲时显示消息
        let userAction = false,
            userActionTimer,
            messageArray = isNotFoundPage ? [...notFoundMessages] : result.message.default,
            lastHoverSelector,
            lastHoverElement;
        const interactionMessageIndex = new Map();
        const devtoolsMessagePriority = 12;
        const hoverMessageDuration = 4000;
        const hoverMoveThrottle = 200;
        const sameElementHoverCooldown = 2500;
        let lastDevtoolsNoticeAt = 0;
        let lastHoverTriggeredAt = 0;
        let lastHoverProcessedAt = 0;
        const nextInteractionMessage = (key, textList) => {
            if (!Array.isArray(textList)) {
                return textList;
            }
            const currentIndex = interactionMessageIndex.get(key) || 0;
            interactionMessageIndex.set(key, (currentIndex + 1) % textList.length);
            return textList[currentIndex];
        };
        const resetHoverState = () => {
            lastHoverSelector = null;
            lastHoverElement = null;
            lastHoverTriggeredAt = 0;
        };
        const showDevtoolsMessage = () => {
            const now = Date.now();
            if (now - lastDevtoolsNoticeAt < 1500) {
                return;
            }
            lastDevtoolsNoticeAt = now;
            showMessage(result.message.console, 6000, devtoolsMessagePriority);
        };
        const isDevtoolsShortcut = event => {
            const key = String(event.key || "").toLowerCase();
            if (key === "f12") {
                return true;
            }
            if ((event.ctrlKey || event.metaKey) && event.shiftKey) {
                return key === "i" || key === "j" || key === "c";
            }
            return false;
        };
        const getElementText = element => {
            if (!element) {
                return "";
            }
            const innerText = element.innerText?.trim();
            if (innerText) {
                return innerText;
            }
            const title = element.getAttribute?.("title")?.trim();
            if (title) {
                return title;
            }
            const ariaLabel = element.getAttribute?.("aria-label")?.trim();
            if (ariaLabel) {
                return ariaLabel;
            }
            return "";
        };
        const getElementCount = element => {
            if (!(element instanceof Element)) {
                return "";
            }
            const ownCount = element.getAttribute("data-waifu-count")?.trim();
            if (ownCount) {
                return ownCount;
            }
            const countElement = element.querySelector("[data-waifu-count]");
            if (!countElement) {
                return "";
            }
            return countElement.getAttribute("data-waifu-count")?.trim() || getElementText(countElement);
        };
        const getElementDisplayText = element => {
            if (!(element instanceof Element)) {
                return getElementText(element);
            }
            const ownText = element.getAttribute("data-waifu-text")?.trim();
            if (ownText) {
                return ownText;
            }
            const textElement = element.querySelector("[data-waifu-text]");
            return getElementText(textElement) || getElementText(element);
        };
        const getMatchedTextParts = (matchedElement, targetElement) => {
            return {
                text: getElementDisplayText(matchedElement) || getElementDisplayText(targetElement),
                count: getElementCount(matchedElement) || getElementCount(targetElement)
            };
        };
        const fillInteractionTemplate = (template, matchedElement, targetElement) => {
            const { text, count } = getMatchedTextParts(matchedElement, targetElement);
            return template
                .split("{text}").join(text)
                .split("{count}").join(count);
        };
        const handleHoverInteraction = event => {
            if (!(event.target instanceof Element)) {
                resetHoverState();
                return;
            }

            const now = Date.now();
            if (event.type === "mousemove" && now - lastHoverProcessedAt < hoverMoveThrottle) {
                return;
            }
            lastHoverProcessedAt = now;

            for (let { selector, text } of result.mouseover) {
                const matchedElement = event.target.closest(selector);
                if (!matchedElement) continue;

                const isSameHoverTarget = lastHoverSelector === selector && lastHoverElement === matchedElement;
                if (isSameHoverTarget && now - lastHoverTriggeredAt < sameElementHoverCooldown) {
                    return;
                }

                lastHoverSelector = selector;
                lastHoverElement = matchedElement;
                lastHoverTriggeredAt = now;
                text = nextInteractionMessage(`mouseover:${selector}`, text);
                text = fillInteractionTemplate(text, matchedElement, event.target);
                showMessage(text, hoverMessageDuration, 8);
                return;
            }

            resetHoverState();
        };
        window.addEventListener("mousemove", () => userAction = true);
        window.addEventListener("keydown", event => {
            userAction = true;
            if (isDevtoolsShortcut(event)) {
                showDevtoolsMessage();
            }
        });
        setInterval(() => {
            if (userAction) {
                userAction = false;
                clearInterval(userActionTimer);
                userActionTimer = null;
            } else if (!userActionTimer) {
                userActionTimer = setInterval(() => {
                    showMessage(messageArray, 6000, 9);
                }, 20000);
            }
        }, 1000);
        const initialMessage = isNotFoundPage
            ? (result.message.notFoundWelcome || notFoundMessages[0] || welcomeMessage(result.time))
            : welcomeMessage(result.time);
        showMessage(initialMessage, 7000, 11);
        window.addEventListener("mouseover", handleHoverInteraction);
        window.addEventListener("mousemove", handleHoverInteraction);
        window.addEventListener("mouseout", event => {
            if (
                !lastHoverElement ||
                !(event.relatedTarget instanceof Element) ||
                !lastHoverElement.contains(event.relatedTarget)
            ) {
                resetHoverState();
            }
        });
        window.addEventListener("click", event => {
            if (!(event.target instanceof Element)) return;
            for (let { selector, text } of result.click) {
                const matchedElement = event.target.closest(selector);
                if (!matchedElement) continue;
                text = nextInteractionMessage(`click:${selector}`, text);
                text = fillInteractionTemplate(text, matchedElement, event.target);
                showMessage(text, 4000, 8);
                return;
            }
        });
        result.seasons.forEach(({ date, text }) => {
            const now = new Date(),
                after = date.split("-")[0],
                before = date.split("-")[1] || after;
            if ((after.split("/")[0] <= now.getMonth() + 1 && now.getMonth() + 1 <= before.split("/")[0]) && (after.split("/")[1] <= now.getDate() && now.getDate() <= before.split("/")[1])) {
                text = randomSelection(text);
                text = text.replace("{year}", now.getFullYear());
                messageArray.push(text);
            }
        });

        window.addEventListener("copy", () => {
            showMessage(result.message.copy, 6000, 9);
        });
        window.addEventListener("visibilitychange", () => {
            if (!document.hidden) showMessage(result.message.visibilitychange, 6000, 9);
        });
    }

    (function initModel() {
        let modelId = localStorage.getItem("modelId"),
            modelTexturesId = localStorage.getItem("modelTexturesId");
        if (modelId === null) {
            // 首次访问加载 指定模型 的 指定材质
            modelId = 1; // 模型 ID
            modelTexturesId = 53; // 材质 ID
        }
        model.loadModel(modelId, modelTexturesId);
        fetch(config.waifuPath)
            .then(response => response.json())
            .then(registerEventListener)
            .catch(error => {
                console.error("Failed to load waifu tips.", error);
            });
    })();
}

function initWidget(config, apiPath) {
    if (typeof config === "string") {
        config = {
            waifuPath: config,
            apiPath
        };
    }
    document.body.insertAdjacentHTML("beforeend", `<div id="waifu-toggle">
            <span>看板娘</span>
        </div>`);
    const toggle = document.getElementById("waifu-toggle");
    toggle.addEventListener("click", () => {
        toggle.classList.remove("waifu-toggle-active");
        if (toggle.getAttribute("first-time")) {
            loadWidget(config);
            toggle.removeAttribute("first-time");
        } else {
            localStorage.removeItem("waifu-display");
            document.getElementById("waifu").style.display = "";
            setTimeout(() => {
                document.getElementById("waifu").style.bottom = 0;
            }, 0);
        }
    });
    if (localStorage.getItem("waifu-display") && Date.now() - localStorage.getItem("waifu-display") <= 86400000) {
        toggle.setAttribute("first-time", true);
        setTimeout(() => {
            toggle.classList.add("waifu-toggle-active");
        }, 0);
    } else {
        loadWidget(config);
    }
}

export default initWidget;
