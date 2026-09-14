---
title: 图片排版测试
published: 2026-09-04
description: "测试文章内图片居中排版：小图应显示在中间，宽图填满整行。"
image: "./wide.png"
tags: ["测试"]
category: 测试
draft: true
---

这是一篇用于测试正文图片排版的文章。

## 小尺寸图片（未填满宽度，应居中显示）

下面是一张 300×200 的小图片，修改前它靠左显示，现在应该显示在这一行的**中间**：

![小尺寸测试图片](./small.png "这是图片下方说明：小图居中显示")

小图上方，这行文字在图片之后。

## 宽幅图片（填满宽度，效果不变）

下面是一张 1600×600 的宽图片，它会占满整个内容区域宽度：

![宽幅测试图片](./wide.png)

## 混合排版验证

- 列表项一
- 列表项二：后面跟一张小图

![列表后的小图](./small.png "列表后的图片也能带说明")

段落文字继续验证排版正常，前后间距没有异常。

## B 站视频嵌入测试

<iframe src="//player.bilibili.com/player.html?isOutside=true&aid=117080506505776&bvid=BV18muC6aEtc&cid=40829718302&p=1" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>

