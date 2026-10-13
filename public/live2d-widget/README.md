# Live2D Widget（鱼皮自定义版本）

原仓库作者：https://github.com/stevenjoezhang/live2d-widget

模型来源于网络，请勿商用！

## 双渲染内核

本目录同时支持两种 Live2D 模型格式，由 `model/model_list.json` 的 `renderers` 字段决定用哪套内核：

| 值 | 模型格式 | 内核 | 模型目录里的入口文件 |
| --- | --- | --- | --- |
| `cubism2`（默认） | `.moc` + 贴图 | `live2d.min.js` | `index.json` |
| `cubism5` | `.moc3` + `model3.json` | `vendor/` 下的 Cubism Core 5 + pixi-live2d-display | `<目录名>.model3.json` |

- Cubism 5 的三个内核脚本（约 780 KB）是**懒加载**的，只有真正用到 Cubism 5 模型时才会请求，首屏不受影响。
- Cubism 5 模型没有动作文件（`.motion3.json`）也能用：呼吸、眨眼、物理由内核提供，鼠标跟随、表情、睡觉闭眼由 `src/cubism5Model.js` 负责。
- `model3.json` 里额外支持的 `WidgetConfig` 字段（非 Live2D 标准字段，原生播放器会忽略）：
  - `PersistentParameters`：每帧强制写入的参数，例如 `{ "Paramcol_3": 1 }` 用来默认隐藏水印
  - `ExpressionCycle` / `ExpressionMessages`：工具栏「换装」按钮轮换的表情名字与对应台词，`null` 表示恢复默认表情
  - `Scale` / `OffsetX` / `OffsetY`：缩放缓动、左右微调、上下微调

## 调整看板娘的左右位置

工具栏最右边的「位置」按钮（左右双箭头）会展开一个滑块面板，拖动即可让看板娘在面板里左右移动，右边的「↺」一键回到正中间。

- 范围 ±100px（面板固定 300px 宽，再远模型就会被画布裁掉），正数向右。
- 值存在 `localStorage` 的 `waifu-offset-x`，刷新、换模型后都还在；没调过时用 `model3.json` 的 `WidgetConfig.OffsetX`。
- 落地方式：Cubism 5 改模型在画布里的坐标（`Cubism5Model.setHorizontalOffset`），Cubism 2 因为 `live2d.min.js` 没暴露变换接口，直接位移 `#live2d` 画布元素（`LocalModel.applyHorizontalOffset`）。
- 面板里的 pointer 事件都 `stopPropagation` 了，拖滑块不会把看板娘整体拖走、也不会触发点击/睡觉等交互。

## 添加一个 Cubism 5 模型

1. 把模型文件放进 `model/<目录名>/`，并按 `目录名` 命名入口：`model/xxx/xxx.model3.json`、`xxx.moc3`、贴图等。
2. 贴图建议压到 2048px 以内（网页看板娘实际显示约 300px，8192 的贴图有 30 MB，会严重拖慢加载）。
3. 在 `model/model_list.json` 里追加：
   - `models` / `messages` 各加一项；
   - `renderers` 里加 `"xxx": "cubism5"`；
   - 可选：把 `defaultModel` 改成 `"xxx"`，并把 `version` 加 1（版本变化时前端会重置一次模型选择，让新模型立刻生效）。
4. 表情文件用 `FileReferences.Expressions` 列出，闪烁/口型分组用 `Groups`（`EyeBlink` / `LipSync`）声明。

调试入口：控制台里的 `live2dWidgetCubism5`，例如 `live2dWidgetCubism5.applyExpression("4 脸红")`。

## 放大镜（中键 / 触屏长按她的头部）

大肥鱼支持「放大镜」：在她的头部触发后会弹出一个聚焦环，环里是放大的脸部特写，方便看清表情。

交互是「按住看、松手收回」，两种触发方式：

- **鼠标中键**：按在头部立即弹出；按在身体其它部位不会弹出。
- **触屏 / 触控笔**：**长按**头部约 0.38 秒（期间手指几乎不动）才弹出——按下后马上滑动会被判定为「拖走看板娘」，不会弹环；长按成立时会给看板娘自身的拖拽发一个 `pointercancel` 把手势让出来（见 `cancelStageDrag`）。长度与容差由 `MAGNIFIER_LONG_PRESS_MS` / `MAGNIFIER_LONG_PRESS_TOLERANCE` 控制。
  - 坑：这个 `pointercancel` **必须带上按下点的 `clientX / clientY`**。`Layout.astro` 的 `finishDrag` 会用 `event.clientX - dragState.startX` 判断是否「上下拽 → 滑到顶/底」，坐标缺省会取 0，被算成一次巨大的向上拖动，长按后看板娘会直接滑到屏幕顶部。
- **按住不放拖动**：聚焦环跟着走，环移到哪就放大哪里的画面（取景中心被限制在模型占位内，环拖到边缘不会只剩镜片底）。
- 按住期间环的上方会冒出**气泡文字**，节奏是**随机**的：有时害羞到连冒几句（急促），有时欲言又止停一会儿（取景在头部更慌、身体更从容）。文案也分区：头部是 害羞 / 激动 / 心跳加快…，身体是 唔…好害羞 / 喂！眼睛往哪看 / 看够了没有！…（害羞与训斥两种语气混着来）。
- **表情 / 动作联动（只用模型里真实存在的资源，不伪造）**：弹出时从模型「实际存在的表情」里按关键词挑一个切上（头部优先 `脸红` → 命中 `4 脸红`；身体优先 `O O` → 命中 `5 O O`），挑不到就不切，收起时恢复你原来的表情。
- **动作**：只在模型真带 `.motion3.json` 时才播（按组名关键词优先找「扭捏 / 害羞」类，匹配不到用第一组）。大肥鱼本身不含动作文件，所以按住放大镜时不会播放任何动作，也不会用参数去伪造动作。
- **松开**：聚焦环收回（同时还原渲染分辨率）；按 `Esc` 或切换到别的模型同样会收回。
- 注意：手机（`screen.width < 768`）不会加载看板娘本身（`Layout.astro` 里的判断），所以放大镜目前只在平板 / 触屏电脑 / 桌面端可用。
- 控制台也可以手动控制：`live2dWidgetCubism5.toggleMagnifier(true/false)`。

可调参数在 `src/cubism5Model.js` 顶部：

- `LENS_SIZE` / `LENS_ZOOM`：聚焦环直径与放大倍数
- `HEAD_CENTER_RATIO` / `HEAD_RADIUS_RATIO`：中键判定用的头部中心与半径（相对画布比例）
- `LENS_DEFAULT_FOCUS_RATIO`：刚弹出时的取景中心，用来把脸对准环心（往左上/右下微调位置改这里）
- `MAGNIFIER_ZONE_SPLIT`：取景中心 y 小于该值算「头部」，决定词库/表情/动作
- `MAGNIFIER_HINTS`：气泡文字词库（`head` 头部取景、`body` 身体取景两套）
- `MAGNIFIER_HINT_TEMPO`：气泡随机节奏（`head` / `body` 两套：`first` 首个延迟区间、`fast` 急促间隔区间、`slow` 从容间隔区间、`burstChance` 进入急促模式的概率）
- `MAGNIFIER_HINT_MAX`：同时最多几个气泡
- `MAGNIFIER_EXPRESSION_KEYWORDS`：头部/身体分别用哪些关键词去匹配模型真实表情（匹配不到就不切）
- `MAGNIFIER_MOTION_KEYWORDS`：动作组名关键词（模型带动作文件时才生效）

气泡配色跟随站点主题：默认（深色模式）是深色玻璃 + 浅色文字，站点切到浅色模式（`<html>` 去掉 `dark` 类）时自动换成浅色玻璃 + 深色文字，规则在 `waifu.css` 的 `html:not(.dark) #live2d-magnifier-hints span`。
- `MAGNIFIER_EXPRESSIONS`：头部/身体分别自动切到哪个表情（模型里没有同名表情就跳过）
- `SHY_WIGGLE_AMPLITUDE` / `SHY_WIGGLE_SPEED` / `SHY_WIGGLE_RAMP`：兜底「扭捏」摆动的幅度、速度、渐入时间

两个实现要点（改的时候别踩坑）：

- **镜片底**：模型画布是透明的。如果镜片只画放大内容，放大区域里的空白处就会透出后面**原始大小**的模型，看起来像重影。所以镜片会先把环覆盖的区域做「模糊 + 压暗」铺满镜片，再把放大画面叠上去。
- **取景范围**：`setLensFocus()` 会把取景中心限制在模型实际占位（`model.getBounds()` 内缩 10%）之内，否则环能被拖到旁边的空白处，镜片里只剩一层底色。
- 为了让放大后依旧清晰，打开聚焦环时会临时把渲染分辨率提到 2 倍；模型画布开启了 `preserveDrawingBuffer`（否则 WebGL 缓冲区已清空，`drawImage` 读不到画面）。
- 改这些 JS 参数后需要 `npm run build` 重新打包。

## 渲染自检与自愈

手机上出现过「点关闭按钮把看板娘收起来，再打开，只剩身体、头部整块没画出来」的情况。查过之后确认模型本身没问题：部件参数（`Paramcol_*` / `PARAM_EXP*`）、绘制对象的透明度与可见性、绘制对象遮罩数量全都正常，物理也没被超大帧间隔打爆，属于 WebGL 状态 / 合成层那一侧的问题，在桌面和无头浏览器里都复现不出来。

所以做成「自检 + 自愈」而不是继续猜原因：

- `sampleCanvasPixels()`：把 WebGL 画布 `drawImage` 采样成 96×96，统计不透明像素总数与**上三分之一（头部区域）**的像素数。模型是底边对齐、撑满高度的，所以头部固定落在画布上方三分之一。
- `checkRenderIntegrity()`：总像素够多（说明身体在画）但头部占比 < 5%（`INTEGRITY_MIN_HEAD`）→ 判定异常，打一条 `console.warn` 并 `rebuildRenderer()`。
- `rebuildRenderer()`：把旧 canvas **换成新节点**（旧节点上残留的 WebGL / 合成层状态一起丢掉），重建 pixi 实例并重新加载同一个模型。重建受 `INTEGRITY_REBUILD_COOLDOWN` 限流，不会反复重建。
- 触发时机（都在 `bindGlobalListeners()` 里）：`ResizeObserver` 观察到 stage 从 0×0 变回正常尺寸（即关闭 → 重新打开）、`visibilitychange` / `pageshow` / `focus`、`webglcontextlost` / `webglcontextrestored`（丢失时 `preventDefault()` 让浏览器恢复）、以及模型刚加载完。

健康状态下的实测值：总像素 ≈ 1950、头部 ≈ 565（占比 28.9%），离 5% 的阈值很远，正常渲染不会误判；把画布上方三分之一擦掉模拟异常时，头部占比变 0%，能立刻认出来并重建，重建后恢复到 28.9%。

## 构建

改动 `src/` 后需要重新打包（产物是根目录的 `waifu-tips.js`）：

```bash
npm run build
```
