# AGENTS.md

给在本仓库工作的 AI 代理的入口文档。**先读这一份，再读代码。**

## 1. 项目是什么

TTV Short Drama —— **Windows 专属**的短剧 / 漫剧 / 动漫桌面播放器。

- 前端：React 19 + TypeScript + Vite 6 + Tailwind（`src/`）
- 后端：Tauri 2 + Rust（`src-tauri/src/`）
- 随包运行时：嵌入式 CPython + 解析 worker + ffmpeg + mpv（`src-tauri/resources/`）
- 窗口：无边框（`decorations: false`）+ Windows 11 Mica 纯白玻璃质感
- 播放内核：**WebView2 里的 `<video>`**，不是 libmpv（见 §6 文档偏差）

内容来源三条链路并存：红果（短剧/漫剧，官网 + App API）、动漫共和国 dmghg（动漫正式源）、暴风资源（动漫兜底源）。

## 2. 常用命令

```bash
# 前端
npm ci                      # 严格按锁文件安装（CI 用这个）
npm run dev                 # Vite dev server → http://127.0.0.1:5175
npx tsc --noEmit            # 类型检查（CI 第一步）
npm run build               # tsc + vite build → dist/
npm run preview             # 预览构建产物 → 127.0.0.1:4173

# Rust
cargo fmt   --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml --bins   # 纯逻辑单测，不需要网络

# 桌面
npm run tauri dev
npm run tauri build         # 自动带上 custom-protocol 特性，别手写 cargo build --release
```

Windows 批处理脚本（本机环境专用，含硬编码路径）：

| 脚本 | 用途 |
| --- | --- |
| `start-dev.bat` | `npm run dev -- --open` |
| `build.bat` | 按绝对路径调 cargo，并把 `TEMP`/`TMP` 指向项目内 `.tmp` |
| `start-dev-safe.bat` | C 盘满盘兜底：临时目录与 WebView2 user-data 全落项目盘，再拉起 exe |
| `release.ps1` / `release.bat` | 一键发布：检查 → 构建 → 抽 CHANGELOG → 发 GitHub Release（见 §2.1） |

**改完必须跑的验证**：`npx tsc --noEmit` + `cargo clippy ... -D warnings` + `cargo test --bins`。CI 就这三项加 `npm run build`（见 `.github/workflows/ci.yml`）。

### 2.1 发布流程

```powershell
pwsh -NoProfile -File release.ps1              # 版本号取自 src-tauri/tauri.conf.json
pwsh -NoProfile -File release.ps1 -SkipChecks  # 已单独跑过检查时
pwsh -NoProfile -File release.ps1 -NoPublish   # 只构建，先本地验包
```

发布前先把 `CHANGELOG.md` 的 `## Unreleased` 改成 `## X.Y.Z - 日期`，并同步三处版本号
（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`）。脚本只校验"工作区干净"，
不会替你改版本号。

脚本固化了四个手工必踩的坑：cargo 的绝对路径与 `TEMP` 落项目盘、必须走 `npm run tauri build`
（自动带 `custom-protocol`）、**MSI 约 106 MB 超过 GitHub Release 单文件 100 MB 上限所以只发
NSIS 的 `*-setup.exe`**、release notes 直接取自 CHANGELOG 对应段落（手抄必与正文脱节）。

## 3. 前端结构

```
src/
├── types/        严格领域契约（catalog / series / playback / history / favorite / settings）
├── services/
│   ├── ipc.ts        唯一后端入口 + sessionId 分配 + 详情缓存 + localStorage 降级
│   ├── mockData.ts   Web/演示模式的高保真数据源
│   ├── hlsAttach.ts  m3u8 挂载与 hls.js 生命周期
│   └── windowFx.ts   原生全屏唯一入口
├── stores/       Context 状态机：app / catalog / playback / history / favorites / settings
├── components/   layout · common · player · views
└── styles/       mica.css · crystal.css（玻璃材质与动效）
```

约定：

- **前端不拼接解析 URL、不读缓存路径、不直接操作播放器进程**。所有后端交互都过 `ipcService`，靠 `isTauriEnvironment()` 分流到 Tauri 命令或 mock。
- 视图切换是**常驻 DOM + `hidden`**，不卸载。这既是动效需要，也是多个历史 bug 的来源（见 §5）。
- 新领域状态建独立 store，不要往 `useAppStore` 或单个大 store 里堆。

## 4. Rust 后端结构

| 模块 | 职责 |
| --- | --- |
| `main.rs` | 窗口/状态装配、全部 Tauri 命令、全屏前置处理、WebView2 启动参数、数据根目录 |
| `provider.rs` | 红果官网抓取：目录分页、题材路由、搜索（含中文数字归一 + App 联想合并） |
| `short_drama_app.rs` | 红果 App-API 桥：设备凭据、worker 调度、预签名、整集解密下载、缓存预算与淘汰 |
| `anime_provider.rs` | 动漫源分发：dmghg 正式源 / 暴风兜底源，按 id 前缀与源可用性选择 |
| `dmghg_bridge.rs` | 驱动厂商 `electron_bridge.dll`（JSON RPC），目录/详情/播放地址/清晰度档位 |
| `hls_proxy.rs` | 本地 HLS 代理（127.0.0.1，带访问令牌，分块流式转发） |
| `storage.rs` | SQLite：历史、收藏、设置 |
| `models.rs` | 跨 IPC 的 serde 契约 |

单元测试写在各自 `.rs` 底部的 `#[cfg(test)] mod tests`；需要真机/联网的冒烟测试标 `#[ignore]`（如 `dmghg_smoke`），默认不跑。

Python 侧：`resources/shortdrama-worker/worker.py` 是**单次调用的无状态进程**，`stdout` 逐行输出 JSON（`{"event":"progress"}` / `{"ok":true}` / `{"ok":false,"error"}`），由 Rust 注入 `TTV_SD_*` 环境变量。子命令：`resolve` / `stream` / `album`。

## 5. 必须遵守的不变量（都是踩过的坑）

1. **只有一块 `<video>`**（`VideoSurface`，常驻 DOM）。离开播放器必须 `stopPlayback()`；离开动漫专区必须 `releaseAttachedSource()`（只拆 hls.js、**不动 `src`**），不能用 `detachSource()` —— 后者清 `src` 会把旧帧刷成黑屏。
2. **会话号是唯一真相**。每次换集/换源/换清晰度 `sessionId` 递增；所有异步续体的起播点都要复查会话（`pauseIfStale`），stale 即暂停。新增任何 `await` 之后的 `setSrc`/`play()` 都要接入这套判定。
3. **自动连播四重闸门**：触发所属集必须就是画面里实际装载的集、期间无更新的切换在途、源装载后 2s 结算期、同一次装载只允许自动跳一集。删任何一条都会回到"一次跳好几集"。
4. **三级兜底开关必须复位**：`hasTriedBackupRef` / `hasTriedBlobRef` / `hasTriedNativeResolveRef` 语义是"本会话已试过"，进入非动漫路径前必须统一复位，否则播完一次动漫后其他源全部播不了。
5. **全屏只走** `windowFx.enterFullscreen()` / `leaveFullscreen()`，进全屏前由 Rust `window_prepare_fullscreen` **静默**解除最大化（`SetWindowPlacement`）。直接调 `unmaximize()` 会带系统还原动画（实测高度 1019 → 920 → 1067 的"回弹"）。
6. **CSP 只在生产构建注入**，开发态完全不生效。新增任何域名或协议（`img-src` / `media-src` / `connect-src` / `worker-src`）都必须同步 `src-tauri/tauri.conf.json`，否则打包后才炸。hls.js 的 blob worker 被拒走的是异步 error 事件，`try/catch` 兜不住。
7. **数据目录不要改回去**：`app_storage_root()` 只在 exe 确实位于 cargo `target/{debug,release}` 时用项目内 `.app-data`，其余一律交给 Tauri `app_data_dir()`。历史上无条件回退两级，把 SQLite 与 WebView2 数据写到了 `%APPDATA%` 的上一级。
8. **诚实报告边界**：`settings_save` 会把 `default_quality` 强制为 `auto`、`preferred_engine` 强制为 `off`、缓存读数为 0。补帧与 RTX VSR 已在 0.2.5 整体移除，**不要在 UI 上把不存在的档位显示成可用**，也不要为了菜单好看伪造清晰度档位 —— 档位必须来自源流实测。
9. **动漫 id 判定一律看前缀**：剧集 id 带 `dmghg:`，集 id 编码为 `线路|集名`。`channelBySeriesId` 是内存 Map，页面重载 / HMR 后为空，从收藏或历史进入也不会填，不能作为来源判定依据。
10. **HEVC 依赖 WebView2 `PlatformHEVCDecoderSupport`**。不要加回 `--disable-gpu-compositing`：它会让全部渲染退回软件光栅（界面有 30 处 `backdrop-blur`）并让平台 HEVC 硬解失效，直接导致"该媒体无法由 WebView 解码"。
11. **整集解析是单飞（leader/follower）**。预取与前台换集可能同时打同一集，只有 leader 跑 worker，follower 等产物。按 mtime 清理缓存时**不能删除很新的 `.part.mp4` / `.source.tmp`**，那是并发 worker 正在写的半成品。
12. 前端错误文案**不泄露**内部 URL、令牌、文件路径；`external_player_open` 只接受 `https://` 且不得把用户输入直接当命令行参数。

## 6. 文档与现实存在偏差（重要）

本仓库的文档描述的是**目标架构**，代码是**兼容期实现**。不要照文档写代码：

- `docs/frontend-design.md` / `docs/backend-architecture.md` 讲的是 libmpv actor、`mpv_render_context` + D3D11 合成、小黄鸭/RIFE 补帧、`commands/mod.rs` 拆分迁移。**现状**：WebView2 `<video>` + MSE(hls.js)，补帧引擎已整体移除，mpv 仅用于 `external_player_open` 外部播放兜底。
- `README.md` 提到的 `src/stores/useEnhancementStore.tsx`、`src-tauri/src/rtx_vsr.rs`、`lossless_scaling.rs` 都**不存在**（`Cargo.toml` 里关于它们的注释也是残留）。
- 前端设计文档里"主导航只保留发现/历史/设置"也已过时：现在还有动漫、收藏、搜索。

**冲突时以代码 + `CHANGELOG.md` 为准。** 改动行为后同步更新 `CHANGELOG.md`（它的写法是记录根因与实测数据，不是罗列改动）。

## 7. 代码风格

- 注释用中文，解释**为什么**，并带上实测根因、反例或历史事故。"这段代码在做什么"式的复述注释不要写。
- 修改保持外科手术式：只动任务涉及的部分。仓库里有很多大文件（`short_drama_app.rs` 2.2k 行、`usePlaybackStore.tsx` 2k 行），**不要顺手重构**。
- 保留既有注释，尤其是带历史结论的那些。
- 负面结论要如实保留（"这条链路实测固定 2.16s"、"该模式会漏掉 108 个 .pyd"），它们防止后来者重走弯路。

## 8. 环境陷阱

- 仓库只能在 **Windows** 上构建运行（WebView2 / Mica / Win32 API）；CI 跑 `windows-latest`。
- `ffmpeg.exe` / `mpv.exe` 走 **Git LFS**，克隆后需 `git lfs pull`。这两个文件和 `resources/python`、`resources/shortdrama-worker/site-packages` 都是**构建必需**，CI 会校验存在性 —— 删掉或忽略它们会产出能装但跑不起来的包。
- `.gitignore` 里刻意用 `*.pyc` 而不是 `*.py[cod]`：后者会连带忽略 `.pyd`（Python C 扩展，运行必需）。
- Vite 的文件监听带路径谓词过滤 + watcher error 降级（`vite.config.ts`）。Windows 上 `fs.watch` 的 EBUSY 曾两次让 dev server 直接退出，不要把这个逻辑简化掉。
- 开发态数据落在 `src-tauri/.app-data/`，运行期数据在 `%LOCALAPPDATA%\com.ttv.shortdrama`（设备凭据 + 剧集缓存），WebView2 数据在 `.app-data/webview-data`。这些目录**绝不入库**。
- 根目录的 `短剧/` 是空目录，`VidCom图标库/`、`design-proposals/` 是素材与预览，不参与构建。

## 9. 提交前检查清单

- [ ] `npx tsc --noEmit` 通过
- [ ] `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --bins` 通过
- [ ] 触及播放链路时：会话号判定、连播闸门、兜底开关复位是否都被照顾到
- [ ] 触及网络/CSP/新域名时：`tauri.conf.json` 的 `csp` 已同步
- [ ] 触及交互的改动在 **Tauri 窗口里**（不是浏览器）验证过 —— 全屏、HEVC、CSP、WebView2 省电暂停这些只在窗口里才暴露
- [ ] `CHANGELOG.md` 已按"根因 + 实测"风格更新