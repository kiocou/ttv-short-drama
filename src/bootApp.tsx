/**
 * 主窗口入口：只负责把 App 挂上去。
 *
 * 为什么单独一个文件：`main.tsx` 必须按**窗口标签**分流（主窗口 / 画中画小窗），
 * 而分流只能用动态 `import()`——静态 `import App from './App'` 会把整个主界面
 * 模块图（所有视图、store、服务）打进小窗的加载路径，小窗只是 380×214 的一块
 * 播放面，却要为那几百 KB 的模块图付一次冷启动时间。
 *
 * 拆成两个入口文件之后，Rollup 会为两边生成独立 chunk：小窗只下载
 * `bootPip` 那一份（MiniPlayer + ipc + 播放服务），主窗口那一份原样保留。
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

export function mountApp(root: HTMLElement): void {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
