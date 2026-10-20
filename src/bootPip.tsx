/**
 * 画中画小窗入口：只挂 MiniPlayer。
 *
 * 与 `bootApp` 分开的意义见那个文件的注释：小窗不该为整个主界面的模块图付
 * 冷启动时间。
 *
 * 顺手做一次 hls.js 预热：小窗起播短剧时用的是整集 HLS（与主播放器同一条链路），
 * 而 hls.js 是动态 `import()` 的 600KB 级 chunk。等真正换源那一刻再下载/解析，
 * 就会直接体现在"点开小窗要等一下才开始播"上；这里在页面加载的同一拍发起，
 * 与窗口出现、首帧渲染并行，用户感知不到。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { MiniPlayer } from './components/player/MiniPlayer';
import { reserveSessionIds } from './services/ipc';

/** 小窗的会话号段起点：与主窗口（100 起、逐次 +1）刻意拉开，永不重叠。 */
const PIP_SESSION_BASE = 900_000_000;

export function mountPip(root: HTMLElement): void {
  // 会话号必须先抬到独立号段再挂载：小窗开播用的是整集 HLS（`open_stream` 按
  // sessionId 管产物与本地服务路径），与主窗口同号会互相顶掉对方的转码会话。
  reserveSessionIds(PIP_SESSION_BASE);
  void import('hls.js').catch(() => {
    // 预热失败不影响任何功能：真正需要时 hlsAttach 还会再 import 一次。
  });
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <MiniPlayer />
    </React.StrictMode>,
  );
  // 窗口不在这里 show：那件事由 MiniPlayer 在**自己首帧提交之后**做，
  // 它才知道界面上已经画出了什么（见那个组件里的 revealWindow）。
}
