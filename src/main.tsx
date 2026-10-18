import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { MiniPlayer } from './components/player/MiniPlayer';
import { isPipWindow } from './services/pip';
import { applyTheme, readTheme, watchSystemTheme } from './services/theme';
import './index.css';

// 首次渲染之前就要落到 <html> 上：暗色用户不该先看到一帧浅色界面。
// `readTheme()` 内部会解析「跟随系统」——选了它的话，这里取到的就是系统此刻的值。
applyTheme(readTheme());
// 挂上系统配色监听：用户在 Windows 设置里改应用模式时，"跟随系统"要立刻跟上。
// 必须在首帧之后也一直有效，所以挂在这里（进程级、只挂一次），而不是某个组件里
// ——组件会随视图切换卸载，那时"跟随"就会静默失效。
watchSystemTheme();

const rootElement = document.getElementById('root');
if (rootElement) {
  // 同一个 index.html 承担两个入口：主界面与画中画小窗。分流依据是**窗口标签**
  // （min 前缀的窗口由 Rust 侧 pip.rs 创建），而不是查询参数——生产环境前端走
  // asset 协议，URL 参数的处理规则与 dev server 并不一致，标签才是唯一稳定的依据。
  const pipWindow = isPipWindow();
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {pipWindow ? <MiniPlayer /> : <App />}
    </React.StrictMode>,
  );
}
