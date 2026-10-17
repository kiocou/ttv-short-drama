import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { MiniPlayer } from './components/player/MiniPlayer';
import { isPipWindow } from './services/pip';
import { applyTheme, readTheme } from './services/theme';
import './index.css';

// 首次渲染之前就要落到 <html> 上：暗色用户不该先看到一帧浅色界面。
applyTheme(readTheme());

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
