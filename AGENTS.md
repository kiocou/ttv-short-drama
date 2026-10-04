# AGENTS.md

给在本仓库工作的 AI 代理的入口文档。**先读这一份，再读代码。**

## 1. 项目是什么

TTV Short Drama —— **Windows 专属**的短剧 / 漫剧 / 动漫桌面播放器。

- 前端：React 19 + TypeScript + Vite 6 + Tailwind（`src/`）
- 后端：Tauri 2 + Rust（`src-tauri/src/`）
- 随包运行时：嵌入式 CPython + 解析 worker + ffmpeg + mpv + **guo-core（Go 编译的 `duanju_core.dll`）**（`src-tauri/resources/`）
- 窗口：无边框（`decorations: false`）+ Windows 11 Mica 纯白玻璃质感
- 播放内核：**WebView2 里的 `<video>`**，不是 libmpv（见 §6 文档偏差）

内容来源四条链路并存：

| 链路 | 覆盖内容 | 实现 |
| --- | --- | --- |
| 红果 | 短剧 / 漫剧 | 官网抓取（`provider.rs`）+ App API 与 worker 解密链路（`short_drama_app.rs`） |
| guoapp 外部站源 | 短剧 / 漫剧（19 个站源） | Go 内核 `duanju_core.dll`，Rust 侧 `guo_provider.rs` 走 FFI |
| dmghg | 动漫正式源 | 厂商 `electron_bridge.dll`（`dmghg_bridge.rs`） |
| 暴风资源 | 动漫兜底源 | `anime_provider.rs` 内部分发 |

**红果被显式排除在 guo 链路之外**：`catalog_list` / `catalog_fast_search` / `catalog_categories` 里都是 `if source != "hongguo"` 才走 `guo_provider`。红果的剧集 id 是**裸 `series_id`**，guo 的是 `guo:<source>:<id>`。这条分界决定了很多设计（见 §5-14、§5-18）。

## 2. 常用命令

```bash
# 前端
npm ci                      # 严格按锁文件安装（CI 用这个）
npm run dev                 # Vite dev server → http://127.0.0.1:5175（strictPort）
npx tsc --noEmit            # 类型检查（CI 第一步）
npm run build               # tsc + vite build → dist/
npm run preview             # 预览构建产物 → 127.0.0.1:4173

# Rust
cargo fmt   --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml --bins   # 纯逻辑单测，不需要网络

# guo-core（Go module `duanjuapp/native` → c-shared DLL，仅在改 Go 侧站源逻辑时才需要）
pwsh -File src-tauri/guo-core/build.ps1   # 需要 Go 1.24+ 与 MinGW-w64 gcc，产出 resources/guo-core/duanju_core.dll
cd src-tauri/guo-core; go test ./...      # 必须在该目录下跑，Go 没有 --manifest-path

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

**改完必须跑的验证**：`npx tsc --noEmit` + `cargo clippy ... -D warnings` + `cargo test --bins`。CI 就这三项加 `npm run build`（见 `.github/workflows/ci.yml`）。改了 `src-tauri/guo-core/**/*.go` 还要 `go test ./...` 与 `pwsh -File src-tauri/guo-core/build.ps1` —— **CI 不跑 Go**，Go 侧回归全靠本地。

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
│   ├── guoSources.ts 19 个 guo 站源的静态清单（kind / adult）+ tab 与启用集过滤
│   ├── animePlayback.ts 动漫专区独立播放内核（源形态判定 / hls.js 挂载 / 出帧看门狗）
│   ├── hlsAttach.ts  m3u8 挂载与 hls.js 生命周期
│   ├── windowFx.ts   原生全屏唯一入口
│   ├── pip.ts        画中画小窗交接协议（窗口标签判定 / 交接包 / 进度回传）
│   └── updater.ts     检查更新（GitHub Releases，走 Rust 不走 CSP）
├── stores/       Context 状态机：app / catalog / playback / animePlayer / history / favorites / settings
├── components/   layout · common · player · views
└── styles/       mica.css · crystal.css（玻璃材质与动效）
```

约定：

- **前端不拼接解析 URL、不读缓存路径、不直接操作播放器进程**。所有后端交互都过 `ipcService`，靠 `isTauriEnvironment()` 分流到 Tauri 命令或 mock。
- **视图切换是常驻 DOM + `hidden`**，不卸载（`App.tsx` 里每个 view 一行 `block`/`hidden`）。这既是动效需要，也是多个历史 bug 的来源（见 §5）。
- 新领域状态建独立 store，不要往 `useAppStore` 或单个大 store 里堆。
- **`usePlaybackStore.tsx`（2.7k 行）是短剧/漫剧主链路**，`useAnimePlayerStore.tsx`（740 行）是动漫专区，两者**完全独立**；画中画小窗是第三块播放面（`MiniPlayer.tsx`）。改动漫不会碰短剧，反之亦然。

## 4. Rust 后端结构

| 模块 | 行数 | 职责 |
| --- | --- | --- |
| `main.rs` | 1422 | 窗口/状态装配、全部 Tauri 命令、全屏前置处理、WebView2 启动参数、数据根目录、搜索缓存、18+ 门闩 |
| `provider.rs` | 2602 | 红果官网抓取：目录分页、题材路由、搜索（含中文数字归一 + App 联想合并） |
| `short_drama_app.rs` | 2225 | 红果 App-API 桥：设备凭据、worker 调度、预签名、整集解密下载、缓存预算与淘汰 |
| `guo_provider.rs` | 1472 | guo 站源桥：FFI 加载、19 源目录/详情/分集/取流、封面缓存、画质探测、死源冷却、代理模式、错误脱敏 |
| `dmghg_bridge.rs` | 1074 | 驱动厂商 `electron_bridge.dll`（JSON RPC），目录/详情/播放地址/清晰度档位 |
| `anime_provider.rs` | 526 | 动漫源分发：dmghg 正式源 / 暴风兜底源，按 id 前缀与源可用性选择 |
| `hls_proxy.rs` | 488 | 本地 HLS 代理（127.0.0.1，带访问令牌，分块流式转发） |
| `pip.rs` | 412 | 画中画小窗（label: `mini`）：置顶无边框窗口创建/复用、交接包与进度回传、关闭回报 |
| `update.rs` | 559 | 客户端更新：查 GitHub Releases、下载安装包到下载目录、定位文件（不自动安装） |
| `storage.rs` | 310 | SQLite：历史、收藏、设置 |
| `models.rs` | 353 | 跨 IPC 的 serde 契约 |

**`src-tauri/guo-core/` 是第三方 Go 源码**（Go module `duanjuapp/native`，已整棵入库）：`bridge/main.go` 是 c-shared 导出层（`DuanjuRequest` / `DuanjuFree`），`core/` 是各站源 provider，`diag/probe_sources.py` 是逐源体检脚本。Rust 侧只经 `guo_provider.rs` 的 FFI 调它，**不要在 Rust 里重写站源解析，也不要在 Go 里塞 UI 概念**。

单元测试写在各自 `.rs` 底部的 `#[cfg(test)] mod tests`；需要真机/联网的冒烟测试标 `#[ignore]`（如 `dmghg_smoke`），默认不跑。`guo_provider.rs` 里有几条不加载 DLL 也能跑的纯函数测试（`next_sequence` / `retain_recent_sessions` / `catalog_cooldown_active` / 分类归一化），另有 `bridge_loads_and_initializes` 会真去 LoadLibrary。

Python 侧：`resources/shortdrama-worker/worker.py` 是**单次调用的无状态进程**，`stdout` 逐行输出 JSON（`{"event":"progress"}` / `{"ok":true}` / `{"ok":false,"error"}`），由 Rust 注入 `TTV_SD_*` 环境变量。子命令：`resolve` / `stream` / `album`。

## 5. 必须遵守的不变量（都是踩过的坑）

1. **同一时刻只有一路在播，三块 `<video>` 各自的作用域不同**：`VideoSurface`（短剧/漫剧，**常驻 DOM**）、`AnimeVideoSurface`（动漫，**按需挂载**，进入播放才创建、退出即销毁）、`MiniPlayer`（画中画小窗，独立窗口）。离开短剧播放器必须 `stopPlayback()`；离开动漫专区必须 `releaseAttachedSource()`（只拆 hls.js、**不动 `src`**），不能用 `detachSource()` —— 后者清 `src` 会把旧帧刷成黑屏。
2. **会话号是唯一真相**。每次换集/换源/换清晰度 `sessionId` 递增；所有异步续体的起播点都要复查会话（`pauseIfStale`），stale 即暂停。新增任何 `await` 之后的 `setSrc`/`play()` 都要接入这套判定。
3. **自动连播四重闸门**：触发所属集必须就是画面里实际装载的集、期间无更新的切换在途、源装载后 2s 结算期、同一次装载只允许自动跳一集。删任何一条都会回到"一次跳好几集"。
4. **三级兜底开关必须复位**：`hasTriedBackupRef` / `hasTriedBlobRef` / `hasTriedNativeResolveRef` 语义是"本会话已试过"，进入非动漫路径前必须统一复位，否则播完一次动漫后其他源全部播不了。
5. **全屏只走** `windowFx.enterFullscreen()` / `leaveFullscreen()`，进全屏前由 Rust `window_prepare_fullscreen` **静默**解除最大化（`SetWindowPlacement`）。直接调 `unmaximize()` 会带系统还原动画（实测高度 1019 → 920 → 1067 的"回弹"）。
6. **CSP 只在生产构建注入**，开发态完全不生效。新增任何域名或协议（`img-src` / `media-src` / `connect-src` / `worker-src`）都必须同步 `src-tauri/tauri.conf.json`，否则打包后才炸。hls.js 的 blob worker 被拒走的是异步 error 事件，`try/catch` 兜不住。guo 的封面走 `asset:` 协议、媒体走 guo-core 本地媒体服务的 `127.0.0.1`，两者都已在 CSP 与 `assetProtocol.scope` 里放行。
7. **数据目录不要改回去**：`app_storage_root()` 只在 exe 确实位于 cargo `target/{debug,release}` 时用项目内 `.app-data`，其余一律交给 Tauri `app_data_dir()`。历史上无条件回退两级，把 SQLite 与 WebView2 数据写到了 `%APPDATA%` 的上一级。guo-core 的数据目录是 `<app_dir>/guo-core`（含 `covers-v1/` 与它自己的 `resource-settings.json`），**TTV 侧不存第二份**。
8. **诚实报告边界**：`settings_save` 会把 `default_quality` 强制为 `auto`、`preferred_engine` 强制为 `off`、缓存读数为 0。补帧与 RTX VSR 已在 0.2.5 整体移除，**不要在 UI 上把不存在的档位显示成可用**，也不要为了菜单好看伪造清晰度档位 —— 档位必须来自源流实测。同理：guo 源的健康度**没有体检过就显示"未检测"**，不显示成"可用"（`guoSources.ts` 里手填的 `status` 字段已全部清空、仅留兼容位）。
9. **动漫 id 判定一律看前缀**：剧集 id 带 `dmghg:`，集 id 编码为 `线路|集名`。`channelBySeriesId` 是内存 Map，页面重载 / HMR 后为空，从收藏或历史进入也不会填，不能作为来源判定依据。
10. **HEVC 依赖 WebView2 `PlatformHEVCDecoderSupport`**。不要加回 `--disable-gpu-compositing`：它会让全部渲染退回软件光栅（界面有 30 处 `backdrop-blur`）并让平台 HEVC 硬解失效，直接导致"该媒体无法由 WebView 解码"。
11. **整集解析是单飞（leader/follower）**。预取与前台换集可能同时打同一集，只有 leader 跑 worker，follower 等产物。按 mtime 清理缓存时**不能删除很新的 `.part.mp4` / `.source.tmp`**，那是并发 worker 正在写的半成品。
12. 前端错误文案**不泄露**内部 URL、令牌、文件路径；`external_player_open` 只接受 `https://` 且不得把用户输入直接当命令行参数。guo 侧的错误统一过 `sanitize_guo_error`（剥 URL/域名/IP，把 `HTTP 404/403/429`、`context deadline exceeded`、`no such host` 翻译成人话），原始错误只进 stderr。
13. **画中画小窗是第三块 `<video>`，但播放权同一时刻只属于一个窗口**（小窗 = 独立置顶窗口 `mini`，见 `src-tauri/src/pip.rs` + `src/services/pip.ts`）。交接时主窗口先 `pause()` 再离开播放器视图（`stopPlayback` 作废会话 + 落盘）；主窗口要自己起播时先 `dismissPip()` 收掉小窗。交接包里传的是**身份 + 播放参数**（seriesId / episodeId / 秒数 / 音量 / 静音 / 倍速 / 连播设置 / 集列表），**不传播放地址**——动漫链路主窗口挂的是 hls.js 的 MSE `blob:`（跨窗口不可用），所以小窗自己按同一条 IPC 命令重新解析。另：两个窗口各自持有一份前端会话号计数（都从 100 起），靠"播放权唯一"避开撞号；若将来允许两路同时播，必须把会话号收口到后端。
    （补充：创建小窗的 `pip_open` **必须是 `async` 命令** —— 同步命令跑在主线程上，而 `WebviewWindowBuilder::build()` 在主线程里要内联建窗口、又需要事件循环继续泵消息，两边互等会让这次 IPC 永不返回、小窗停在 `about:blank`。小窗起播还必须容忍 WebView2 的省电暂停：小窗刚创建时还没有前台激活权限，首次 `play()` 几乎必定抛 `AbortError`，而小窗的常态就是"别的窗口在前台"，所以要靠"播放意图 + 周期重试"自己接上，不能只挂 `focus`/`visibilitychange`。）
    （补充二：**停播必须自己动手，不能指望"窗口没了声音就停"**。窗口 `hide()` 之后音频照旧在播（Chromium 标准行为），而页面的 `document.visibilityState` 仍是 `visible` —— 前端根本发现不了自己被藏起来，"声音停掉"曾完全依赖销毁 webview，而 `destroy()` 是异步投递且可能失败。因此 `pip.rs` 里停播、隐藏、销毁是**三步分开的**：先注入停播脚本（`pause()` + 清 `src` + `load()`）→ 再 `hide()` → 留 150ms 排空 → 最后销毁；销毁失败退化为 `close()` 并写 stderr，不得静默吞错。系统关闭路径（Alt+F4）同样要在 **`CloseRequested`** 里补停播，`Destroyed` 是事后的、什么都来不及。另：那 150ms 内窗口可能被 `pip_open` 重新 `show()` 复用，销毁前必须先看可见性，否则会出现"点了画中画、小窗闪一下就没"。）
    （补充三：**「检查更新」的网络请求放在 Rust 侧**（`update.rs`），不走前端 `fetch`——前端 CSP 收得很紧且**只在生产构建注入**，页面里试通、打包后才挂是这类功能的经典翻车方式。另外：仓库是私有时 GitHub 的 `/releases/latest` 对未认证请求返回 **404**（而不是 403，避免泄露私有资源是否存在），这条要写成可读的提示，不要笼统一句「检查更新失败」。下载完成后**只定位文件、不得自动安装**。）
    （补充四：**与 GitHub 相关的请求要自己挂系统代理**。reqwest 只认 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量，**不读 Windows 的「Internet 设置」**；而本机代理写在注册表里（实测 `127.0.0.1:10808`）。两者不一致会产生很迷惑的现象——`api.github.com` 直连能通（「检查更新」看起来正常），但资产下载域名 `objects.githubusercontent.com` 直连失败，只报一句 `error sending request`，而同一地址用 PowerShell 下载却有 4.88 MB/s。`update.rs` 的 `system_proxy()` 会读 `ProxyEnable`/`ProxyServer` 并挂到下载客户端上。）
14. **guo 的播放 sequence 是 guo-core 的全局高水位，不是会话号**。`nativeBeginPlayback` 把 sequence 当高水位用（`sequence <= engine.playbackSequence` 直接回 `context.Canceled`），每发新的还会先掐掉上一次 resolve。**绝不能把前端 `session_id` 裸当 sequence 传**——它从 100 起，第一次起播就把水位抬过 100，此后任何画质探测必被 Cancel（这正是"guo 画质从第二集起恒为空"的根因），而画中画两个窗口各自持有一份从 100 起的计数，还会互相撞车。正确做法是 `guo_provider.rs` 里的 `AtomicU64`，基数 `SEQUENCE_BASE = 1_000_000`，起播与探测共用。
15. **guo bridge 是全局单锁，锁内绝不能 `.await`**。`GuoBridge::request` 跨 FFI 可能耗时数百毫秒到数十秒（死源实测 25–60s），持锁等待会把**所有** guo 调用（其它源目录、封面、起播、轮询）一起堵在排队上。`guo_source_check` 的轮询就是标准写法：起锁发一枪就放掉，每轮 sleep 之后再取。拿 `category_index` / `sessions` 锁时也不要顺手调 bridge。
16. **guo 源的分类必须做 id 映射**。前端题材栏回传的是中文**显示名**，而各源的分类 id 体系互不相同（黄果视频要纯数字、黄果 AI 要 slug、duanju 系要英文键），直接把"全部/爱情"发过去会被 guo-core 的分类校验**整体拒绝**——连默认首屏都挂（表现是所有 guo 源一律"目录加载失败"）。`guo_provider.rs` 的 `category_id()` 负责映射（分类表按源缓存，查不到回退"全部"而不是报错）。
17. **死源要有冷却，别让它拖死首屏**。guo 的失败**不写目录缓存**，不设冷却的话每次首屏都会被最慢的源拖 25–60s（前端 `Promise.allSettled` 等所有源）。`CATALOG_COOLDOWN` 记 10 分钟，期内 0ms 快速失败，到期自动再探。根治要把 DLL 调用模型异步化，那是另一件事。
18. **guo 弹幕接不上，不要再接一遍**。guo-core 的 `danmaku` action 压根没有 drama/chapter 入参，弹幕身份只挂在播放会话上，而能产出会话的前提是 `guo:hongguo:<id>` —— 红果被 `main.rs` 显式排除在 guo 链路外，这个前缀**永远产生不出来**。曾经实现过整条链路（前端 overlay + IPC + 后端转发）后整段删除，结论留在 `guo_provider.rs` 顶部与 `usePlaybackStore.tsx`。
19. **18+ 源门闩在前后端各存一份名单，改一处必须改另一处**。前端 `src/services/guoSources.ts` 的 `adult` 决定勾选与聚合，后端 `GUO_SOURCES` 的 `adult` 是**门闩的唯一权威**（前端过滤能被 `invoke('catalog_list', …)` 绕过）。有 `GUO_SOURCES.len() == 19` 与 `source_is_adult_matches_the_frontend_list` 两条测试钉住。门闩的两种姿态要分清：**目录/搜索类静默回落红果**（用户只是选了个源，报错会凭空多出红卡片），**直达类报错**（`series_detail` / `playback_open` / `guo_cover` / `anime_qualities`——后两个最容易漏，`guo_cover` 漏了会留下一排 18+ 缩略图）。`catalog_fast_search` 的守卫必须早于缓存查表，否则受控源的结果会以"红果的结果"落进同一个 cache key。
20. **仓库里没有 ErrorBoundary，一处渲染异常就是整棵 React 树白屏**。凡是后端返回结构与前端断言不符的接口（典型：`guo_source_check` 返回的是整条源状态记录，体检报告嵌在 `.health` 下；后端失败时返回 `{error}` 而不是 `Err`），前端都要显式解包并把异常形态转成抛错，否则 `undefined.length` 直接炸在渲染期。
21. **`play()` 必须有界**。装载链上其余每个等待都有超时兜底（preload 探针 10s、adopt firstFrame 8s、webFirstFrame 8s），唯独 `video.play()` 没有：本地 asset 请求被并发探针顶住、或远端连接吊死时，promise 永不落定，`openEpisode` 的 await 永不返回——错误卡与三级降级全在它后面，永远轮不到。`playBounded()` 给 `play()` 挂 8 秒保底；超时时先看 `readyState >= 3 && !video.error`（迟到但画面已在推进，按成功算），否则交给既有降级链。
22. **首帧预解池（`PREPARED_POOL_MAX = 3`）的边界**：探针是不挂进文档流的隐藏 video（不产生额外合成层），换剧/退出/淘汰时**必须走 `disposePrepared`（`pause + removeAttribute('src') + load()`）**——只删 Map 不释放，解码器会一直挂在脱离文档流的 video 上。命中条件收紧到 `startPosition === 0`（带历史进度重入时 `currentTime` 对不上，硬用会跳帧）。适用面只有**本地整集文件 / 直链**（`playLocalFile`，即红果 drama/comic）；guo 走 `playDirect`（有 `backupUrl` 防盗链兜底）、dmghg/暴风是 m3u8（预解会把 MSE 建起来、主播放器接管时要重建）。
23. **卡死看门狗是"自愈"不是"提示"**。短剧侧 `startDramaStallWatchdog`：连续 10 秒「本该在播」却既没有时钟推进、又没有新解码帧、也没有新数据进入 → ① 原地重试（`currentTime = currentTime`）→ ② 2 秒未恢复则重装载**同一集** → ③ 失败才停。三个判据别删：排除 `paused`/`seeking`、**排除 `ended`**（播完后 `paused` 仍是 false，不排除就会把"播完了"当卡死，倒带重生再立刻播回结尾）、**不看 `readyState`**（解码卡死时它恒停在 2，与缓冲观感一样）、**缓冲时不卸**（解码卡死时 `waiting` 照样派发且再也不回来，卸掉恰好漏掉要治的症状）。恢复动作一律先过 `activeSessionRef.current === sessionId`，**绝不推进下一集**（`autoAdvanceLatchRef` / `tryClaimAutoAdvance` 一行不碰）。
24. **guo 源的站源网络默认直连，不要改回 `auto`**。guo-core 出厂是 `auto`（跟随系统代理），而 19 个站全是境内 CDN：实测挂着系统代理访问 `www.zywest263.com` 恒 403、直连 200。首次运行（`resource-settings.json` 不存在）写直连，设置页「视频源 → 站源网络」可切。`set_proxy_mode` 回写**必须带全字段**——Go 侧按 JSON unmarshal 进 struct，缺字段即零值，会把 `proxyUrl` / `downloadBySource` 静默清空，而那是唯一的持久化。

## 6. 文档与现实存在偏差（重要）

本仓库的文档描述的是**目标架构**，代码是**兼容期实现**。不要照文档写代码：

- `docs/frontend-design.md` / `docs/backend-architecture.md` 讲的是 libmpv actor、`mpv_render_context` + D3D11 合成、小黄鸭/RIFE 补帧、`commands/mod.rs` 拆分迁移。**现状**：WebView2 `<video>` + MSE(hls.js)，补帧引擎已整体移除，mpv 仅用于 `external_player_open` 外部播放兜底。
- `README.md` 提到的 `src/stores/useEnhancementStore.tsx`、`src-tauri/src/rtx_vsr.rs`、`lossless_scaling.rs` 都**不存在**。`Cargo.toml` 里关于它们的注释同样是残留 —— 那段注释提到的 `Win32_System_LibraryLoader` 现在有真实用途：`guo_provider.rs` 用它 `LoadLibraryA` 加载 `duanju_core.dll`。
- 前端设计文档里"主导航只保留发现/历史/设置"也已过时：现在还有动漫、收藏、搜索。
- 根目录的分析报告（`红果短剧抓包分析报告*.md`、`画质档位分辨率实测验证.md`、`短剧画质链路集成实施方案.md`）是**阶段性调研记录**，不随代码更新，读它们时以代码为准。

**冲突时以代码 + `CHANGELOG.md` 为准。** 改动行为后同步更新 `CHANGELOG.md`（它的写法是记录根因与实测数据，不是罗列改动）。

## 7. 代码风格

- 注释用中文，解释**为什么**，并带上实测根因、反例或历史事故。"这段代码在做什么"式的复述注释不要写。负面结论要如实保留（"这条链路实测固定 2.16s"、"该模式会漏掉 108 个 .pyd"、"guo 弹幕不可达"），它们防止后来者重走弯路。
- 修改保持外科手术式：只动任务涉及的部分。仓库里有很多大文件（`provider.rs` 2.6k 行、`usePlaybackStore.tsx` 2.7k 行、`guo-core/core/` 整棵 Go 树），**不要顺手重构**。`guo-core/` 是上游代码，改动前先确认它是不是应该在本仓库改。
- 保留既有注释，尤其是带历史结论的那些。
- 写不变量时把"为什么不能那样写"一起写进去：本仓库的注释密度高是刻意的，它们是下一个人唯一能拿到的实测数据。

## 8. 环境陷阱

- 仓库只能在 **Windows** 上构建运行（WebView2 / Mica / Win32 API / cgo）；CI 跑 `windows-latest`。
- 随包资源都在 `src-tauri/resources/`，**都是构建/运行必需**，CI 会校验 `python/python.exe`、`shortdrama-worker/worker.py`、`mpv/ffmpeg.exe` 存在。`resources/guo-core/duanju_core.dll`（15.2 MB）**CI 暂未校验** —— 但缺了它应用起不来（`GuoProvider::new` 直接 Err），别把它加进 `.gitignore`。
- `ffmpeg.exe`（101.9 MiB）与 `mpv.exe`（114.8 MiB）走 **Git LFS**（都超 GitHub 单文件 100 MiB 硬限制），克隆后需 `git lfs pull`。`duanju_core.dll` 是普通入库二进制（`.gitattributes` 里 `*.dll binary`）。
- `.gitignore` 里刻意用 `*.pyc` 而不是 `*.py[cod]`：后者会连带忽略 `.pyd`（Python C 扩展，运行必需，实测会漏掉 108 个）。
- Vite 的文件监听带路径谓词过滤 + watcher error 降级（`vite.config.ts`）。Windows 上 `fs.watch` 的 EBUSY 曾两次让 dev server 直接退出，不要把这个逻辑简化掉。
- 开发态数据落在 `src-tauri/.app-data/`（含 WebView2 的 `.app-data/webview-data`），运行期数据在 `%LOCALAPPDATA%\com.ttv.shortdrama`（设备凭据 + 剧集缓存 + `guo-core/`）。这些目录**绝不入库**。
- `VidCom图标库/`、`design-proposals/` 是素材与预览，不参与构建。
- `TTV_GUO_CORE_DLL` 环境变量可覆盖 DLL 查找路径（调试用）；`TTV_BOX_MPV` 同理覆盖外部播放器的 mpv 路径。
- 抓包/站点分析产物在 `.har-analysis/`（实测单个就有 43MB），是临时材料，别入库也别当参考资料。

## 9. 提交前检查清单

- [ ] `npx tsc --noEmit` 通过
- [ ] `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --bins` 通过
- [ ] 动了 `src-tauri/guo-core/**/*.go`：`go test ./...` 通过，必要时重跑 `build.ps1` 并更新入库的 DLL
- [ ] 触及播放链路时：会话号判定、连播闸门、兜底开关复位、`playBounded` 兜底是否都被照顾到
- [ ] 触及 guo 链路时：sequence 高水位、bridge 单锁不跨 await、分类 id 映射、18+ 门闩两侧名单是否同步
- [ ] 触及网络/CSP/新域名时：`tauri.conf.json` 的 `csp` 与 `assetProtocol.scope` 已同步
- [ ] 触及交互的改动在 **Tauri 窗口里**（不是浏览器）验证过 —— 全屏、HEVC、CSP、WebView2 省电暂停这些只在窗口里才暴露
- [ ] `CHANGELOG.md` 已按"根因 + 实测"风格更新
