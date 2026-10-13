import showMessage from "./message.js";
import { WAIFU_OFFSET_LIMIT } from "./utils.js";

/*
 * 「位置」调节面板（工具栏最右边的滑块）：
 * 拖动即可让看板娘在面板里左右移动，值的存取与落地由 LocalModel.setHorizontalOffset 负责，
 * 这里只管交互与展示。
 */
const PANEL_ID = "waifu-offset";
const RANGE_ID = "waifu-offset-range";
const VALUE_ID = "waifu-offset-value";
const RESET_ID = "waifu-offset-reset";
const TOOL_ID = "waifu-tool-position";
const OPEN_HINT = "左右拖一下，我就挪过去啦～";

function formatOffset(value) {
    const offset = Math.round(value) || 0;
    if (offset === 0) {
        return "居中";
    }
    return offset > 0 ? `右 ${offset}` : `左 ${-offset}`;
}

export default function createPositionControl(model) {
    let panel = null;
    let range = null;
    let valueLabel = null;
    let open = false;

    const currentOffset = () => Math.round(model.getHorizontalOffset?.() ?? 0);

    const syncDisplay = value => {
        const offset = Math.round(value) || 0;
        if (range) {
            range.value = String(offset);
        }
        if (valueLabel) {
            valueLabel.textContent = formatOffset(offset);
        }
    };

    const apply = value => {
        const next = model.setHorizontalOffset(value);
        syncDisplay(next);
        return next;
    };

    const close = () => {
        if (!open) {
            return;
        }
        open = false;
        if (panel) {
            panel.dataset.open = "0";
        }
        document.getElementById(TOOL_ID)?.removeAttribute("data-active");
        document.removeEventListener("pointerdown", onDocumentPointerDown, true);
    };

    const onDocumentPointerDown = event => {
        const target = event.target;
        if (!(target instanceof Element)) {
            close();
            return;
        }
        // 面板内部（拖滑块、点居中）和工具栏按钮自己处理，其余位置一律收起
        if (target.closest(`#${PANEL_ID}`) || target.closest(`#${TOOL_ID}`)) {
            return;
        }
        close();
    };

    const ensurePanel = () => {
        if (panel) {
            return panel;
        }
        const waifu = document.getElementById("waifu");
        if (!waifu) {
            return null;
        }
        waifu.insertAdjacentHTML("beforeend", `
            <div id="${PANEL_ID}" data-open="0" role="group" aria-label="调整看板娘左右位置">
                <span id="waifu-offset-icon" aria-hidden="true">⇔</span>
                <input id="${RANGE_ID}" type="range" min="${-WAIFU_OFFSET_LIMIT}" max="${WAIFU_OFFSET_LIMIT}" step="1" value="0" aria-label="看板娘左右位置" />
                <span id="${VALUE_ID}">居中</span>
                <span id="${RESET_ID}" role="button" tabindex="0" title="回到正中间">↺</span>
            </div>`);
        // 都从刚插进去的节点里找，避免看板娘被重复初始化时抓到旧面板
        panel = waifu.lastElementChild;
        range = panel.querySelector(`#${RANGE_ID}`);
        valueLabel = panel.querySelector(`#${VALUE_ID}`);
        const reset = panel.querySelector(`#${RESET_ID}`);
        // 面板里的操作（拖滑块、点居中）不要冒泡出去，免得惊动看板娘自身的拖拽 / 点击逻辑
        ["pointerdown", "pointermove", "pointerup", "click"].forEach(type => {
            panel.addEventListener(type, event => event.stopPropagation());
        });
        range.addEventListener("input", () => apply(range.value));
        const resetOffset = () => {
            apply(0);
            showMessage("回到正中间啦。", 2400, 9);
        };
        reset.addEventListener("click", resetOffset);
        reset.addEventListener("keydown", event => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                resetOffset();
            }
        });
        syncDisplay(currentOffset());
        return panel;
    };

    return {
        isOpen: () => open,
        close,
        toggle() {
            const node = ensurePanel();
            if (!node) {
                return;
            }
            if (open) {
                close();
                return;
            }
            open = true;
            node.dataset.open = "1";
            document.getElementById(TOOL_ID)?.setAttribute("data-active", "true");
            syncDisplay(currentOffset());
            document.addEventListener("pointerdown", onDocumentPointerDown, true);
            showMessage(OPEN_HINT, 2600, 9);
        }
    };
}
