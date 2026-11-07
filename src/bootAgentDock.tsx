/**
 * 智能体悬浮窗入口（label: `agentdock`）。
 *
 * 与 `bootApp` / `bootPip` 分文件的理由相同：悬浮窗只是卡片大的一点界面，
 * 不该为整个主界面的模块图（所有视图、store、目录服务）付冷启动时间——
 * 它出现的时机恰恰是"用户刚切走、注意力在别处"，慢一拍就很明显。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import { AgentDockWindow } from './components/player/AgentDockWindow';

export function mountAgentDock(root: HTMLElement): void {
  // 透明窗口：底色必须是 transparent，否则圆角外会露出 WebView 的默认白底。
  document.documentElement.style.background = 'transparent';
  document.body.style.background = 'transparent';
  root.style.background = 'transparent';
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AgentDockWindow />
    </React.StrictMode>,
  );
}
