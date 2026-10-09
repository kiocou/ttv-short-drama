# TTV Short Drama

**Windows 专属**的短剧 / 漫剧 / 动漫桌面播放器。无边框窗口 + Windows 11 Mica 纯白玻璃质感，播放内核是 WebView2 里的 `<video>`。

当前版本：`0.2.22`（Windows x64）。安装包发布在 [GitHub Releases](https://github.com/kiocou/ttv-short-drama/releases)，应用内的「设置 → 版本与更新」可以直接拉取最新包。

> ⚠️ **仅供个人学习与技术研究**。本项目不托管任何内容，所有剧集数据与视频流均来自公开的第三方站点 / 接口，版权归各自权利人所有。请勿用于商业用途或二次分发。详见文末[免责声明](#免责声明)。

---

## 内容来源

四条链路并存，各自独立、互不影响：

| 频道 | 来源 | 说明 |
| --- | --- | --- |
| 短剧 / 漫剧 | 红果官网 + App API | 网页抓取目录，App API 取播放地址；整集下载解密后本地播放 |
| 短剧 / 漫剧 | guoapp 外部站源（19 个，其中 6 个 18+） | 通过 `duanju_core.dll` FFI 承接目录 / 搜索 / 详情 / 分集 / 真实清晰度 / 取流；剧集 ID 统一为 `guo:<source>:<id>`。**红果被显式排除在这条链路外**（红果 id 是裸 `series_id`） |
| 动漫 | 动漫共和国 / 暴风资源（兜底） | 经**非公开接口**取直链；不可用时自动回退公开兜底源 |

外部站源的可用性由**站方**决定，且**死源无法在代码里修活**——因此应用带一套五步链路体检（入口与目录 → 分集目录 → 播放地址与播放列表 → 播放密钥 → 媒体连接），在「设置 → 站源状态」可逐源现场跑一次并看到每一步的 host / HTTP 状态 / 耗时。没体检过的一律显示「未检测」，**不显示成「可用」**。

成人内容源（6 个）由「设置 → 内容源分级」统一控制，默认关闭；关闭时若正选中受控源会立即切回红果。

## 功能

- **发现 / 搜索**：多频道多源，题材与受众筛选、排序切换；搜索历史以浮层挂在顶部搜索框下方，回车或点历史**直接进结果页**（没有多余的中转页）
- **搜索联想下拉**：300ms 防抖 + LRU 缓存、命中片段高亮；**中文输入法拼词期间绝不发请求**（拼到一半按回车必须是"上屏候选词"而不是"提交搜索"）
- **无限滚动**：分页按 `hasMoreBySource` 逐源推进，到底的源整个从请求列表剔除
- **动漫专区**：独立数据源与独立播放器，分类芯片来自真实分类表
- **播放器**：悬浮玻璃控制岛、选集抽屉、连播圆环倒计时、清晰度与倍速、全屏
- **无缝连播**：解析预取 + **首帧预解池**（解析成功即后台把新一集解到 `canplay`），进下一集直接出画；卡住时看门狗分级自愈（原地重试 → 重装载同一集 → 才停）
- **画中画小窗**：把正在看的一集交给一个**独立置顶无边框窗口**继续播，可拖动、八向拉伸改大小；主窗口照常浏览，播放权同一时刻只属于一个窗口
- **断点续播**：整集本地缓存，回看与换集秒开；缓存自动清理（7 天 / 1GB 全局预算，LRU）
- **观看历史 / 追剧收藏**：SQLite 持久化，支持分组与筛选；卡片上按「想看 / 在看 / 已看」三态显示
- **长按临时加速**：按住 ← / → 固定 2 倍速（基准档位已 ≥ 2x 时不动、也不弹提示），松开只恢复原速、不跳转；速率与阈值只在 `src/services/boostController.ts` 一处定义
- **启动进入动画**：方案 05「轨道汇聚」（6 张迷你海报公转 → 依次汇聚 → 品牌弹簧回弹），配一段用振荡器现场合成的启动音（一个音频文件都没有；可在设置里关闭）
- **检查更新**：从 GitHub Releases 拉取最新安装包，**下载完成后自动静默安装**（安装器启动后应用退出）。动手前要过四道校验——路径 `canonicalize` 后必须仍在下载目录内、扩展名必须是 `.exe`、文件头必须是 `MZ`、体积 ≥ 1 MB；任一条不过就拒绝执行，并回落成「打开安装包所在文件夹」如实提示原因。启动时自动检查（6 小时一次），**是否立即更新由用户选**

## 技术栈

- **前端**：React 19 + TypeScript + Vite 6 + Tailwind CSS（`src/`）
- **后端**：Tauri 2 + Rust（`src-tauri/src/`，13 个模块）
- **随包运行时**：嵌入式 CPython + 解析 worker + ffmpeg + **guo-core**（Go 编译的 `duanju_core.dll`）。ffmpeg 住在 `resources/mpv/` 目录下，但该目录**只装 ffmpeg**——mpv 已于 0.2.15 随外部播放兜底一起移除
- **外部站源内核**：`src-tauri/guo-core/`（Go module `duanjuapp/native`，整棵入库），Rust 侧只经 FFI 调用，不在 Rust 里重写站源解析
- **数据**：SQLite（历史 / 收藏 / 设置，WAL）

## 快速开始

```bash
npm ci                  # 严格按锁文件安装（CI 用这个）
npm run dev             # Vite dev server → http://127.0.0.1:5175
npm run tauri dev       # 桌面窗口（Windows 专属）

npx tsc --noEmit        # 类型检查
npm run build           # tsc + vite build → dist/
npm run verify:boost    # 长按加速状态机用例（36 项，假时钟 + 假 video，不依赖真实定时器）
```

后端检查（与 CI 一致）：

```bash
cargo fmt   --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml --bins
```

改了 `src-tauri/guo-core/**/*.go` 还要在 `src-tauri/guo-core/` 下跑 `go test ./...`（需要 Go 1.24+），
必要时用 `pwsh -File src-tauri/guo-core/build.ps1` 重新产出 `duanju_core.dll`——**CI 不跑 Go**，Go 侧回归全靠本地；
前端那条 `npm run verify:boost` 也不在 CI 里，改长按加速时记得手动跑。

### 发布

```powershell
pwsh -NoProfile -File release.ps1              # 版本号取自 src-tauri/tauri.conf.json
pwsh -NoProfile -File release.ps1 -SkipChecks  # 已单独跑过检查时
pwsh -NoProfile -File release.ps1 -NoPublish   # 只构建，先本地验包
```

发布前先把 `CHANGELOG.md` 的 `## Unreleased` 改成 `## X.Y.Z - 日期`，并同步三处版本号（`package.json` / `src-tauri/Cargo.toml` / `src-tauri/tauri.conf.json`）。

脚本固化了四个手工必踩的坑：cargo 的绝对路径与 `TEMP` 落项目盘、必须走 `npm run tauri build`（自动带 `custom-protocol`）、MSI 约 106 MB 超过 GitHub Release 单文件 100 MB 上限所以只发 NSIS 的 `*-setup.exe`、release notes 直接取自 CHANGELOG 对应段落。

## 随包资源与 Git LFS

发布所需的运行时资源已随仓库纳入版本控制，克隆后即可构建。`ffmpeg.exe` 超过 GitHub 的单文件限制，使用 Git LFS 存储；首次克隆后请确认已安装 Git LFS 并执行 `git lfs pull`。

| 路径 | 内容 | 获取方式 |
| --- | --- | --- |
| `src-tauri/resources/mpv/ffmpeg.exe` | 解密与转码用 ffmpeg | `git lfs pull` |
| `src-tauri/resources/python/` | 嵌入式 CPython 运行时 | 已随仓库提供 |
| `src-tauri/resources/shortdrama-worker/site-packages/` | worker 的 Python 依赖 | 已随仓库提供 |
| `src-tauri/resources/guo-core/` | 外部站源的 `duanju_core.dll` + 头文件 | 已随仓库提供 |

> ⚠️ `guo-core/duanju_core.dll`（15.2 MB）**缺了应用起不来**（`GuoProvider::new` 直接返回错误），
> 但它**目前不在 CI 的资源校验清单里**（CI 只校验 python / worker / ffmpeg 三项）——克隆与打包时别漏。
> `mpv/` 是历史遗留的目录名，里面**只有 `ffmpeg.exe`**。

CI 会启用 LFS 并校验这些资源存在，避免生成缺少运行时文件的安装包。

## 目录结构

```text
TTV Short Drama/
├── src/
│   ├── types/                    # 领域契约（catalog / series / playback / history / favorite / settings）
│   ├── services/                 # 后端入口与专职模块：ipc / pip / updater / hlsAttach / animePlayback
│   │                             #   / boostController / launchAudio / playbackTrace / windowFx / guoSources
│   ├── stores/                   # Context 状态机：app / catalog / playback / animePlayer / history / favorites / settings
│   ├── components/               # layout · common · player · views
│   └── styles/                   # mica.css（底衬）· crystal.css（玻璃材质）· launch.css（启动动画）
├── src-tauri/
│   ├── src/
│   │   ├── main.rs               # 窗口装配、全部 Tauri 命令、全屏、WebView2 启动参数、18+ 门闩
│   │   ├── provider.rs           # 红果官网抓取（目录 / 题材路由 / 搜索）
│   │   ├── short_drama_app.rs    # 红果 App-API 桥（凭据 / worker 调度 / 整集解密 / 缓存预算）
│   │   ├── guo_provider.rs       # guo 外部站源桥（duanju_core.dll FFI）
│   │   ├── anime_provider.rs     # 动漫源分发（dmghg 正式源 / 暴风兜底）
│   │   ├── dmghg_bridge.rs       # 动漫共和国桥接（electron_bridge.dll）
│   │   ├── media_enhance.rs      # H.264 本地 HLS 转码（驱动侧 RTX VSR 的前提）
│   │   ├── hls_proxy.rs          # 本地 HLS 代理（带访问令牌）
│   │   ├── pip.rs                # 画中画小窗
│   │   ├── update.rs             # 检查更新与安装包下载 / 四道校验 / 静默安装
│   │   ├── storage.rs            # SQLite（历史 / 收藏 / 设置）
│   │   ├── models.rs             # 跨 IPC 的 serde 契约
│   │   └── trace.rs              # 诊断日志（环形缓冲 + 落盘 + 接管 stderr）
│   ├── guo-core/                 # Go 内核源码（module duanjuapp/native → duanju_core.dll）
│   └── resources/                # 随包运行时（Python / worker / ffmpeg / guo-core）
├── release.ps1                   # 一键发布
├── scripts/verify-boost.mjs      # 长按加速状态机的确定性用例（npm run verify:boost）
└── CHANGELOG.md                  # 变更记录（含根因与实测数据）
```

## 开发约定

改代码前请先读 `src/` / `src-tauri/` 里的文件头注释——**必须遵守的不变量与踩过的坑都写在代码旁边**（会话号判定、连播闸门、兜底开关复位、CSP 只在生产注入、画中画播放权唯一等）。**改动行为后请同步更新 `CHANGELOG.md`。**

## 文档

本仓库公开的内容只有三份 Markdown：

| 文档 | 用途 |
| --- | --- |
| 本 `README.md` | 项目定位、功能、随包资源、目录结构 |
| [`CHANGELOG.md`](./CHANGELOG.md) | 每个版本的根因与实测数据（不是改动清单）；发布说明直接取自它 |
| [`LICENSE`](./LICENSE) | 授权范围与第三方内容说明 |

设计与架构稿、阶段性调研记录属于维护者本地材料，**不在公开仓库内**。
实现层面的约定（不变量、踩过的坑、为什么不能那样写）都在源码注释里，以**代码 + `CHANGELOG.md`** 为准。

## 免责声明

- 本项目**不存储、不托管、不传播**任何视频内容，仅为播放器前端；所有剧集数据与媒体流均来自第三方公开接口，请求由用户本机直接发出。
- 项目中的第三方站点适配部分来自**非公开接口**调研，仅用于**接口互通性研究**；仓库不包含也未分发任何第三方客户端二进制。
- 请自行确认在所在地区的合法性，**禁止用于商业用途**。因使用本项目产生的任何后果由使用者自行承担。
- 若权利人认为本项目侵犯其权益，请提 Issue 联系删除相关适配代码。

## 许可

见 [`LICENSE`](./LICENSE)。
