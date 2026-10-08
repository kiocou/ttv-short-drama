# design-proposals · 原型与设计稿存档

> 本目录是**原型与设计稿存档，不是现状说明**。与代码不一致时，**以代码 + `CHANGELOG.md` 为准**。
> 各预览页都是零外链、零构建的静态 HTML，双击即开。

## 目录

| 路径 | 是什么 | 状态 |
| --- | --- | --- |
| [`player-designs-preview.html`](./player-designs-preview.html) | 播放器控制岛设计稿：顶部标题岛 + 底部操控坞 + 垂直音量调节器 + 清晰度/倍速气泡 + 80 集选集大弹窗，顶部还有「磨砂透光度 / 模糊半径」的无级滑块 | **已落地**为「方案 D 温润亚克力 2.0」—— `src/styles/crystal.css:2` 的文件头就写着这个命名，`crystal-*` 类名与设计稿一一对应（播放器结构件在 `src/components/player/PlayerHud.tsx`） |
| [`launch-animation/`](./launch-animation/) | 启动进入动画 10 套方案（`index.html` 预览 + `README.md` 设计说明） | **已采用 05「轨道汇聚」并落地** —— `src/components/layout/LaunchAnimation.tsx`、`src/styles/launch.css`（`:2` 写明方案 05）、`src/services/launchAudio.ts` |
| [`category-bar/`](./category-bar/index.html) | 发现页「题材栏」重新设计：5 套方案 + 现状基线，每套的栏高是 JS 实测的 | **已落地（方案 A「分段 + 溢出面板」）** —— 现为 `src/components/common/CategoryBar.tsx`（折叠行 + 全量溢出面板），见 `CHANGELOG.md:202` |
| [`random-pick-v2/`](./random-pick-v2/index.html) | 发现页「猜你喜欢」区域重新设计：5 套方案实时对比，核心读数是「下方内容位移」 | **已落地（方案 C「并轨到『继续观看』行」）** —— 现为 `src/components/common/RandomWatchSection.tsx`，与「继续观看」并轨同排、共用 `PICK_CARD_SHELL` |

## 对原 README 的修正

本文件原先是一段对话口吻的播放器设计稿预览说明，其中三条说法已失效，按现状更正：

- 「所有改动完全保留在项目代码库外部（`src/` 源码 0 改动）」—— **已失效**：设计稿的材质与结构件早已入库（`src/styles/crystal.css`、`src/components/player/PlayerHud.tsx` 等）。
- 「原版蓝色主按钮（`bg-blue-600`）」—— 现状是 Fluent 蓝 `--fluent-blue`（`src/styles/crystal.css:24`）。
- 「透过底部控制栏与顶部标题岛，可以清晰看到下方正在播放的视频画面流动」—— 在**播放器舞台内被有意推翻**：`.ttv-video-stage` 下的玻璃面板一律 `backdrop-filter: none`（`src/styles/crystal.css:106-112`）。理由是不去模糊画面才能让 NVIDIA VSR / HEVC 硬解正常工作（同文件 `:95-102` 的实测记录），"看清视频"优先于"玻璃质感"。

预览页里保留的原版要素仍然有效：顶部标题岛、进度条、播放/暂停/快进快退按键组、垂直音量调节器、清晰度与倍速气泡、80 集选集大弹窗。
