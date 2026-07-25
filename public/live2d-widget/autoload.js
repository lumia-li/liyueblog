// live2d_path 参数建议使用绝对路径
const live2d_path = "./";
//const live2d_path = "/live2d-widget/";

// 封装异步加载资源的方法
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

// 加载 waifu.css live2d.min.js waifu-tips.js
if (screen.width >= 768) {
	Promise.all([
		loadExternalResource(`${live2d_path}waifu.css`, "css"),
		loadExternalResource(`${live2d_path}live2d.min.js`, "js"),
		loadExternalResource(`${live2d_path}waifu-tips.js`, "js"),
	]).then(() => {
		// 配置选项的具体用法见 README.md
		initWidget({
			isLocalModel: true, // 使用本地模型
			waifuPath: `${live2d_path}waifu-tips.json`,
			modelsPath: `${live2d_path}model`,
			modelListPath: `${live2d_path}model/model_list.json`,
			tools: [
				"hitokoto",
				"asteroids",
				"switch-model",
				"switch-texture",
				"photo",
				"info",
				"mute",
				"quit",
			],
		});

		// 添加摸头效果
		const isWaifuMuted = () => {
			try {
				return localStorage.getItem("waifu-muted") === "1";
			} catch (error) {
				console.warn("Failed to read waifu mute state.", error);
				return false;
			}
		};
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
			"喵喵喵！?",
			"其实……再摸一下也不是不行。",
			"嗯哼，再来一点点？",
			"好了啦，差不多可以停了。",
			"喂，不许趁机乱碰。",
		];

		const live2dElement = document.getElementById("live2d");
		if (live2dElement) {
			live2dElement.addEventListener("mousemove", (e) => {
				const rect = live2dElement.getBoundingClientRect();
				const x = e.clientX - rect.left;
				const y = e.clientY - rect.top;

				// 扩大头部检测区域（适应不同模型）
				const isInHeadArea = x > 80 && x < 220 && y > 20 && y < 150;

				if (isInHeadArea) {
					// 检测左右移动
					if (lastX > 0) {
						const deltaX = Math.abs(x - lastX);
						if (deltaX > 3) {
							headPatCount++;
							// 降低触发门槛，提高频率
							if (headPatCount > 1 && !headPatting) {
								if (isWaifuMuted()) {
									headPatCount = 0;
									lastX = x;
									return;
								}
								headPatting = true;
								// 显示摸头提示语
								const randomMessage =
									headPatMessages[
										Math.floor(Math.random() * headPatMessages.length)
									];
								const tipsElement = document.getElementById("waifu-tips");
								if (tipsElement) {
									tipsElement.innerHTML = randomMessage;
									tipsElement.classList.add("waifu-tips-active");
									// 2秒后隐藏，减少冷却时间
									setTimeout(() => {
										tipsElement.classList.remove("waifu-tips-active");
										headPatting = false;
										headPatCount = 0;
									}, 2000);
								}
							}
						}
					}
					lastX = x;
				} else {
					// 离开头部区域时重置
					lastX = 0;
					headPatCount = 0;
				}
			});
		}
	});
}

console.log(`
  く__,.ヘヽ.        /  ,ー､ 〉
           ＼ ', !-─‐-i  /  /´
           ／｀ｰ'       L/／｀ヽ､
         /   ／,   /|   ,   ,       ',
       ｲ   / /-‐/  ｉ  L_ ﾊ ヽ!   i
        ﾚ ﾍ 7ｲ｀ﾄ   ﾚ'ｧ-ﾄ､!ハ|   |
          !,/7 '0'     ´0iソ|    |
          |.从"    _     ,,,, / |./    |
          ﾚ'| i＞.､,,__  _,.イ /   .i   |
            ﾚ'| | / k_７_/ﾚ'ヽ,  ﾊ.  |
              | |/i 〈|/   i  ,.ﾍ |  i  |
             .|/ /  ｉ：    ﾍ!    ＼  |
              kヽ>､ﾊ    _,.ﾍ､    /､!
              !'〈//｀Ｔ´', ＼ ｀'7'ｰr'
              ﾚ'ヽL__|___i,___,ンﾚ|ノ
                  ﾄ-,/  |___./
                  'ｰ'    !_,.:
`);
