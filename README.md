# TTV Short Drama

**Windows 专属**的短剧 / 漫剧 / 动漫桌面播放器。无边框窗口 + Windows 11 Mica 纯白玻璃质感，播放内核是 WebView2 里的 `<video>`。

当前版本：`0.2.13`（Windows x64）。安装包发布在 [GitHub Releases](https://github.com/kiocou/ttv-short-drama/releases)，应用内的「设置 → 版本与更新」可以直接拉取最新包。

> ⚠️ **仅供个人学习与技术研究**。本项目不托管任何内容，所有剧集数据与视频流均来自公开的第三方站点 / 接口，版权归各自权利人所有。请勿用于商业用途或二次分发。详见文末[免责声明](#免责声明)。

---

## 内容来源

四条链路并存，各自独立、互不影响：

| 频道 | 来源 | 说明 |
| --- | --- | --- |
| 短剧 / 漫剧 | 红果官网 + App API | 网页抓取目录，App API 取播放地址；整集下载解密后本地播放 |
| 短剧 / 漫剧 | guoapp 外部站源（18+ 源） | 通过 `duanju_core.dll` FFI 承接目录 / 搜索 / 详情 / 分集 / 真实清晰度 / 取流；剧集 ID 统一为 `guo:<source>:<id>` |
| 动漫 | 动漫共和国（正式源）/ 暴风资源（兜底） | 动漫共和国驱动厂商桥接取直链；不可用时自动回退公开兜底源 |

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
- **检查更新**：从 GitHub Releases 拉取最新安装包（只下载并定位文件，**不会自动安装**）

## 技术栈

- **前端**：React 19 + TypeScript + Vite 6 + Tailwind CSS
- **后端**：Tauri 2 + Rust（`src-tauri/src/`）
- **随包运行时**：嵌入式 CPython + 解析 worker + ffmpeg
- **数据**：SQLite（历史 / 收藏 / 设置）

## 快速开始

```bash
npm ci                  # 严格按锁文件安装
npm run dev             # Vite dev server → http://127.0.0.1:5175
npm run tauri dev       # 桌面窗口（Windows 专属）

npx tsc --noEmit        # 类型检查
npm run build           # tsc + vite build → dist/
```

后端检查（与 CI 一致）：

```bash
cargo fmt   --manifest-path src-tauri/Cargo.toml --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test  --manifest-path src-tauri/Cargo.toml --bins
```

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

CI 会启用 LFS 并校验这些资源存在，避免生成缺少运行时文件的安装包。

## 目录结构

```text
TTV Short Drama/
├── docs/                         # 设计与逆向资料
├── design-proposals/             # 方案预览（播放器设计稿、随机推荐页 10 套方案，不参与构建）
├── src/
│   ├── types/                    # 领域契约（catalog / series / playback / history / favorite / settings）
│   ├── services/
│   │   ├── ipc.ts                # 唯一后端入口 + sessionId 分配 + 详情缓存
│   │   ├── guoSources.ts         # guo 外部站源静态表（结构性属性 + 分级）
│   │   ├── pip.ts                # 画中画小窗交接协议
│   │   ├── updater.ts            # 检查更新（GitHub Releases）
│   │   ├── hlsAttach.ts          # m3u8 挂载与 hls.js 生命周期
│   │   ├── animePlayback.ts      # 动漫链路挂载
│   │   ├── windowFx.ts           # 原生全屏唯一入口
│   │   └── mockData.ts           # Web / 演示模式数据源
│   ├── stores/                   # Context 状态机：app / catalog / playback / anime / history / favorites / settings
│   ├── components/
│   │   ├── layout/               # TitleBar, NavigationRail, ToastContainer
│   │   ├── common/               # MicaCard, FluentButton, CoverImage, SeriesCard, …
│   │   ├── player/               # VideoSurface, AnimeVideoSurface, MiniPlayer, PlayerControls, …
│   │   └── views/                # Explore / Anime / Detail / Search / History / Favorites / Settings
│   └── styles/                   # mica.css, crystal.css
├── src-tauri/
│   ├── src/
│   │   ├── main.rs               # 窗口装配、Tauri 命令、WebView2 启动参数
│   │   ├── provider.rs           # 红果官网抓取
│   │   ├── short_drama_app.rs    # 红果 App-API 桥（签名 / 整集解析 / CENC 解密 / 缓存预算）
│   │   ├── guo_provider.rs       # guo 外部站源桥（duanju_core.dll FFI）
│   │   ├── anime_provider.rs     # 动漫源分发
│   │   ├── dmghg_bridge.rs       # 动漫共和国桥接
│   │   ├── hls_proxy.rs          # 本地 HLS 代理
│   │   ├── pip.rs                # 画中画小窗
│   │   ├── update.rs             # 检查更新与安装包下载
│   │   └── storage.rs            # SQLite
│   └── resources/                # 随包运行时（Python / worker / ffmpeg / guo-core）
├── release.ps1                   # 一键发布
└── CHANGELOG.md                  # 变更记录（含根因与实测数据）
```

## 开发约定

见 [`AGENTS.md`](./AGENTS.md)——它记录了必须遵守的不变量与踩过的坑（会话号判定、连播闸门、CSP 只在生产注入、画中画播放权唯一等）。**改动行为后请同步更新 `CHANGELOG.md`。**

## 免责声明

- 本项目**不存储、不托管、不传播**任何视频内容，仅为播放器前端；所有剧集数据与媒体流均来自第三方公开接口，请求由用户本机直接发出。
- 项目中的第三方站点适配部分（含 `docs/dmghg-reverse/` 的调研记录）仅用于**接口互通性研究**，不包含也未分发任何第三方客户端二进制。
- 请自行确认在所在地区的合法性，**禁止用于商业用途**。因使用本项目产生的任何后果由使用者自行承担。
- 若权利人认为本项目侵犯其权益，请提 Issue 联系删除相关适配代码。

## 许可

见 [`LICENSE`](./LICENSE)。
