# TTV Short Drama - Windows 云母 (Mica) 极简纯白短剧播放器

当前发布版本：`0.1.1`（Windows x64）。安装包发布在 [GitHub Releases](https://github.com/kiocou/ttv-short-drama/releases)。

本项目专为 **短剧与漫剧** 桌面播放场景打造，深度遵循 [`docs/frontend-design.md`](./docs/frontend-design.md) 与 [`docs/backend-architecture.md`](./docs/backend-architecture.md) 规范。

以 **Windows 11 Fluent Mica（云母）纯白透亮质感** 为视觉核心，以 **60/120 FPS 极致流畅动效** 为交互准则，具备完备的领域状态机与解耦的 IPC 架构。

---

## 🌟 视觉与交互特色

1. **Windows 11 Mica 纯白流光美学**：
   - 多层级透光漫反射：底层光晕 + 32px 高饱和高斯模糊 (`backdrop-filter: blur(32px) saturate(190%)`)。
   - 细微边缘高光（1px 白色半透微光边框与自然落下的 Fluent 投影）。
   - 极简、清爽、呼吸感十足的纯白界面，杜绝暗沉沉闷感。

2. **超流畅动效系统 (60/120 FPS)**：
   - 采用 Windows 11 Spring 物理阻尼曲线 `cubic-bezier(0.16, 1, 0.3, 1)`。
   - 导航 Rail 滑块胶囊无缝移动、卡片悬浮浮起 (-3px) 与光斑扩展。
   - 播放控制 HUD 自动呼吸隐现（静止 2.5 秒丝滑淡出，轻触即显）。
   - 侧边抽屉平滑滑出、圆环倒计时连播气泡、吸附式时间进度条。

3. **完整功能模块**：
   - **应用壳 (App Shell)**：自定义 Mica 标题栏（无边框拖拽、窗口控制、全局状态胶囊）+ 响应式侧边导航栏。
   - **发现页 (Explore)**：短剧/漫剧频道切换、多维分类与受众筛选、排序切换、“继续观看”断点续播卡片、高燃剧集海报网格。
   - **详情页 (Detail)**：沉浸式画卷大图、简介展开/折叠、多季选集分组（支持已看标记与进度条）、多解析源健康度看板。
   - **播放器核心工作区 (Player Workspace)**：
     - 悬浮云母玻璃操控岛（播放/暂停、快进退5s、上一集/下一集、时间刻度、吸附进度条、垂直音量气泡、清晰度选择、倍速选择、全屏）。
     - 侧边选集抽屉（播放中无感切集）。
     - 完播连播倒计时悬浮气泡（带环形倒计时动画与取消/立即连播）。
     - 画质增强胶囊（小黄鸭 AI 插帧 120 FPS / RIFE DirectML / 兼容重采样切换）。
     - 实时全链路诊断面板（SessionID、解码与输出 FPS、丢帧数、缓冲余量、延迟）。
     - 快捷键支持（空格播放暂停、←/→ 快进退、↑/↓ 音量、F 全屏、[/] 换集）。
   - **观看历史页 (History)**：时间线记录、进度百分比、单条删除与清空二次确认。
   - **系统设置页 (Settings)**：清晰度偏好、连播倒计时滑块、插帧引擎、缓存一键清理、匿名日志导出。

4. **双模式 IPC 架构**：
   - **Tauri 桌面模式**：直接通过 `@tauri-apps/api` 与 Rust 后端通信。
   - **Web / 演示模式**：内置高保真实时 Mock 数据与 LocalStorage 持久化，无需后端即可在任意现代浏览器中流畅体验与测试全部功能！

---

## 🚀 启动与使用

### 1. 快速启动开发服务器
双击根目录下的 `start-dev.bat`，或者在终端执行：

```bash
npm run dev
```

启动后在浏览器打开 `http://127.0.0.1:5175` 即可立即体验！

### 2. 生产构建打包
```bash
npm run build
```
输出位于 `dist/` 目录，准备就绪可直接供 Tauri 打包为 Windows 原生桌面应用。

---

## 🔧 随包资源与 Git LFS

发布所需的运行时资源已经随仓库纳入版本控制，克隆后即可构建。`ffmpeg.exe` 超过 GitHub 的单文件限制，使用 Git LFS 存储；首次克隆或切换提交后请确认已安装 Git LFS 并执行 `git lfs pull`。

| 路径 | 内容 | 恢复方式 |
| --- | --- | --- |
| `src-tauri/resources/mpv/ffmpeg.exe` | 解密与转码用 ffmpeg（Git LFS） | `git lfs pull` |
| `src-tauri/resources/python/` | 嵌入式 CPython 运行时 | 已随仓库提供 |
| `src-tauri/resources/shortdrama-worker/site-packages/` | worker 的 Python 依赖 | 已随仓库提供 |

`worker.py`、`liushen/`（签名实现）等本项目自有源码也已纳入版本控制。CI 会启用 LFS 并校验这些资源存在，避免生成缺少运行时文件的安装包。

## 🚢 发布前检查

```bash
npm ci
npm run build
npm run tauri build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml --bins
```

生产 Windows 包使用 GUI 子系统，不会额外打开终端窗口；应用 WebView 的右键浏览器菜单也已禁用。

---

## 📁 目录结构

```text
TTV Short Drama/
├── docs/
│   ├── backend-architecture.md   # 后端与架构设计规范
│   └── frontend-design.md        # 前端设计规范
├── src/
│   ├── types/                    # 严格领域契约 (catalog, series, playback, enhancement, history, settings)
│   ├── services/                 # 统一 IPC 客户端与 Mock 数据生成器
│   │   ├── ipc.ts                # Tauri / Mock 桥接层与 sessionId 管理
│   │   └── mockData.ts           # 真实可用短剧、漫剧与视频流
│   ├── stores/                   # 模块化上下文与状态机
│   │   ├── useAppStore.tsx       # 全局视图路由、导航、Toast
│   │   ├── useCatalogStore.tsx   # 发现页、频道、分类、分页
│   │   ├── usePlaybackStore.tsx  # 播放器核心、进度节流、连播倒计时
│   │   ├── useEnhancementStore.tsx # 小黄鸭 / RIFE / 兼容插帧状态与遥测
│   │   ├── useHistoryStore.tsx   # 观看历史与断点持久化
│   │   └── useSettingsStore.tsx  # 用户偏好与缓存释放
│   ├── components/
│   │   ├── layout/               # TitleBar, NavigationRail, ToastContainer
│   │   ├── common/               # MicaCard, FluentButton, FluentSlider, StatusBadge
│   │   ├── player/               # VideoSurface, PlayerControls, ProgressBar, EpisodeDrawer, NextCountdown, DiagnosticsModal, EnhancementFlyout
│   │   └── views/                # ExploreView, DetailView, HistoryView, SettingsView
│   ├── styles/
│   │   └── mica.css              # Windows 11 Mica 材质、阴影与动画
│   ├── App.tsx
│   ├── index.css
│   └── main.tsx
├── package.json
├── vite.config.ts
└── start-dev.bat
```
