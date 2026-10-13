import Cubism5Model from "./cubism5Model.js";
import showMessage from "./message.js";
import randomSelection, { readStoredWaifuOffset, writeStoredWaifuOffset } from "./utils.js";

/**
 * 本地加载模型
 * https://github.com/liyupi
 *
 * 支持两种渲染内核，由 model_list.json 的 renderers 字段指定：
 * - cubism2（默认）：.moc + index.json，走 live2d.min.js
 * - cubism5：.moc3 + model3.json，走 vendor 目录下的 Cubism Core 5 + pixi-live2d-display
 */
const CUBISM2_RENDERER = "cubism2";
const CUBISM5_RENDERER = "cubism5";
const STAGE_ID = "live2d-stage";
const CUBISM5_CANVAS_ID = "live2d-cubism5";
const CUBISM2_CANVAS_ID = "live2d";

class LocalModel {
    constructor(config) {
        // modelListPath: 模型列表 json 文件路径(可不填，就是约定 modelsPath 下的 model_list.json)；modelsPath：模型的跟路径
        const { modelListPath, modelsPath, vendorPath, assetVersion } = config;

        if (!modelsPath) {
            throw "LocalModel requires modelListPath and modelsPath!";
        }
        const safeModelsPath = modelsPath.endsWith("/") ? modelsPath : modelsPath + "/";
        // 确保路径以 / 结尾
        this.modelsPath = safeModelsPath;
        this.modelListPath = modelListPath ?? safeModelsPath + "model_list.json";
        this.vendorPath = vendorPath ?? "/live2d-widget/vendor/";
        this.assetVersion = assetVersion ?? "";
        this.cubism5 = null;
        // 水平位置：用户存过的值优先（null = 没调过，用模型自带的 OffsetX）
        this.offsetX = readStoredWaifuOffset();

        // 「拍照」工具优先走 Cubism 5 的截图，未激活时返回 false 由原逻辑兜底
        window.waifuCapturePhoto = () => this.capturePhoto();
    }

    async loadModelList() {
        // 加载 JSON 文件
        const loadJsonFile = async (path) => {
            // 浏览器环境
            const response = await fetch(path);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return await response.json();
        }

        try {
            this.modelList = await loadJsonFile(this.modelListPath);
            console.log(this.modelListPath, this.modelList);

            if (!this.modelList.models || !this.modelList.messages) {
                throw "Invalid model list format!";
            }
        } catch (error) {
            console.error("Failed to load model list:", error);
            throw "Failed to load model list!";
        }
    }

    getModelName(target) {
        return Array.isArray(target) ? target[0] : target;
    }

    getRenderer(target) {
        const renderers = this.modelList?.renderers ?? {};
        return renderers[this.getModelName(target)] || CUBISM2_RENDERER;
    }

    resolveCubism5ModelUrl(target) {
        const name = this.getModelName(target);
        if (typeof name === "string" && name.endsWith(".model3.json")) {
            return name.startsWith("/") ? name : `${this.modelsPath}${name}`;
        }
        return `${this.modelsPath}${name}/${name}.model3.json`;
    }

    setRenderer(renderer) {
        const stage = document.getElementById(STAGE_ID);
        if (stage) {
            stage.dataset.renderer = renderer;
        }
        if (renderer !== CUBISM5_RENDERER) {
            this.cubism5?.suspend();
        }
    }

    /** 当前生效的水平位置：用户调过就用用户的值，否则取 Cubism 5 模型的 OffsetX 兜底 */
    getHorizontalOffset() {
        if (Number.isFinite(this.offsetX)) {
            return this.offsetX;
        }
        return this.cubism5?.getHorizontalOffset?.() ?? 0;
    }

    /**
     * 左右挪动看板娘（px，正数向右）：
     * - Cubism 5：改模型在画布里的坐标（超出画布的部分被裁掉，仍是「在面板里挪」）
     * - Cubism 2：live2d.min.js 没对外暴露变换接口，直接位移画布元素
     * 值会写进 localStorage，刷新与换模型后都还在。
     */
    setHorizontalOffset(value) {
        this.offsetX = writeStoredWaifuOffset(value);
        this.applyHorizontalOffset();
        return this.offsetX;
    }

    applyHorizontalOffset() {
        const offset = Number.isFinite(this.offsetX) ? this.offsetX : 0;
        // Cubism 5 的模型坐标随时同步，切回 moc3 模型时立刻落在调好的位置
        this.cubism5?.setHorizontalOffset?.(offset);
        const legacyCanvas = document.getElementById(CUBISM2_CANVAS_ID);
        if (legacyCanvas) {
            legacyCanvas.style.transform = offset === 0 ? "" : `translateX(${offset}px)`;
        }
    }

    async loadCubism5Model(target) {
        if (!this.cubism5) {
            this.cubism5 = new Cubism5Model({
                vendorPath: this.vendorPath,
                assetVersion: this.assetVersion,
                canvasId: CUBISM5_CANVAS_ID,
                stageId: STAGE_ID,
                horizontalOffset: this.offsetX
            });
        }
        await this.cubism5.show(this.resolveCubism5ModelUrl(target));
    }

    capturePhoto() {
        if (!this.cubism5?.isActive()) {
            return false;
        }
        const dataUrl = this.cubism5.captureToDataUrl();
        if (!dataUrl) {
            return false;
        }
        const link = document.createElement("a");
        link.href = dataUrl;
        link.download = "photo.png";
        link.click();
        return true;
    }

    async loadModel(modelId, modelTexturesId, message) {
        // 保存当前模型状态
        localStorage.setItem("modelId", modelId);
        localStorage.setItem("modelTexturesId", modelTexturesId);

        // 显示消息
        showMessage(message, 4000, 10);

        // 确保模型列表已加载
        if (!this.modelList) {
            await this.loadModelList();
        }

        // 获取目标模型，可能是值，也可能是数组
        const target = randomSelection(this.modelList.models[Number.parseInt(modelId, 10)]);

        // Cubism 5 模型（moc3）走独立渲染内核
        if (this.getRenderer(target) === CUBISM5_RENDERER) {
            await this.loadCubism5Model(target);
            console.log(`Live2D 模型 ${this.getModelName(target)} 加载完成`);
            return;
        }

        // 加载模型
        this.setRenderer(CUBISM2_RENDERER);
        loadlive2d("live2d", `${this.modelsPath}${target}/index.json`);
        // 换模型时画布尺寸会被内核重算，把用户调好的水平位置重新贴上去
        this.applyHorizontalOffset();
        console.log(`Live2D 模型 ${target} 加载完成`);
    }

    async loadRandModel() {
        const modelId = localStorage.getItem("modelId");
        const modelTexturesId = localStorage.getItem("modelTexturesId");

        if (!this.modelList) {
            await this.loadModelList();
        }

        const currentModel = this.modelList.models[modelId];

        // Cubism 5 模型没有多套贴图，这里用来轮换表情
        if (this.getRenderer(currentModel) === CUBISM5_RENDERER) {
            const message = this.cubism5?.cycleExpression() || "";
            showMessage(message || "我还没有其他衣服呢！", 4000, 10);
            return;
        }

        if (Array.isArray(currentModel)) {
            // 对于数组类型的模型，随机选择一个不同的贴图
            let newTextureId;
            do {
                newTextureId = Math.floor(Math.random() * currentModel.length);
            } while (newTextureId === Number.parseInt(modelTexturesId, 10) && currentModel.length > 1);

            if (newTextureId === Number.parseInt(modelTexturesId, 10)) {
                showMessage("我还没有其他衣服呢！", 4000, 10);
                return;
            }

            this.loadModel(modelId, newTextureId, "我的新衣服好看嘛？");
        } else {
            showMessage("我还没有其他衣服呢！", 4000, 10);
        }
    }

    async loadOtherModel() {
        let modelId = Number.parseInt(localStorage.getItem("modelId"), 10);

        if (!this.modelList) {
            await this.loadModelList();
        }

        // 切换到下一个模型，如果到达末尾则回到开始
        const index = ++modelId >= this.modelList.models.length ? 0 : modelId;
        this.loadModel(index, 0, this.modelList.messages[index]);
    }
}

export default LocalModel;
