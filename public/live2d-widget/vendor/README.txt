本目录存放 Cubism 5（moc3 / model3.json）模型所需的渲染内核，
只在切换到使用 Cubism 5 的模型时才由 src/cubism5Model.js 懒加载。

live2dcubismcore.min.js
  来源：Live2D Cubism SDK for Web 5-r.4 → Core/live2dcubismcore.min.js
  说明：Live2D Cubism Core，属于 Live2D 协议中的 "Redistributable Code"，
       可随应用一并分发；文件头部保留了原始授权声明。
  版权：© Live2D Inc.
  协议：https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html

pixi.min.js
  来源：PixiJS 6.5.10（https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js）
  协议：MIT

pixi-live2d-display.min.js
  来源：pixi-live2d-display 0.4.0 的 cubism4 构建
       （https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js）
  说明：负责 moc3 模型的加载、遮罩、物理与眨眼，运行时挂载在全局 PIXI.live2d 上。
  协议：MIT
