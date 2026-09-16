# 项目改动记录（增强播放任务）

> 本文档记录「增强播放 / 帧生成 / 缩放」任务对项目所做的全部改动。
> 生成方式：`git status` / `git diff --stat` 实测核对，非凭记忆。

## 一、代码改动：本任务只贡献 1 行

| 文件 | 改动 | 位置 |
| --- | --- | --- |
| `src-tauri/src/short_drama_app.rs` | `fn resource_base()` 改为 `pub fn resource_base()` | 约 446 行 |

diff 原文：

```diff
-fn resource_base() -> Option<PathBuf> {
+pub fn resource_base() -> Option<PathBuf> {
```

**原因**：新的增强播放命令需要复用这个函数来定位 `resources/` 目录（它已按
「环境变量 → 可执行文件旁 → 当前目录 → CARGO_MANIFEST_DIR」的顺序探测，是项目里
唯一靠谱的资源定位逻辑）。

**注意**：`short_drama_app.rs` 本身共有 73 行改动，其中 72 行**不是本任务产生的**，
属于此前已有的工作。

## 二、新增的资源文件（git 未跟踪）

### `src-tauri/resources/mpv/`

| 文件 | 大小 | 用途 | 是否必需 |
| --- | --- | --- | --- |
| `mpv.exe` | 114.77 MB | 增强播放内核（v0.41.0） | ✅ 必需 |
| `mpv.com` | 约 0 MB | 控制台版入口 | ✅ 保留 |
| `d3dcompiler_43.dll` | 4.27 MB | mpv 运行依赖 | ✅ 保留 |
| `vsscript.dll` | 0.07 MB | 实验残留副本 | ⚠️ 可删 |
| `libvapoursynth.dll` | 1.22 MB | 实验残留副本 | ⚠️ 可删 |
| `libvapoursynthfilters.dll` | 2.39 MB | 实验残留副本 | ⚠️ 可删 |
| `libvapoursynthfilters_avx2.dll` | 2.46 MB | 实验残留副本 | ⚠️ 可删 |
| `libvapoursynthfilters_zn4.dll` | 2.76 MB | 实验残留副本 | ️ 可删 |

`mpv.exe` 来源：`shinchiro/mpv-winbuild-cmake`，release `20260903`，
包名 `mpv-x86_64-20260903-git-69e63f425a.7z`。
选它的理由：项目里原有的 `ffmpeg.exe` 正是同一项目构建的（其编译路径含
`/__w/mpv-winbuild-cmake/`），同源可最大程度避免滤镜行为差异。

### `src-tauri/resources/vapoursynth/`

| 路径 | 说明 | 是否必需 |
| --- | --- | --- |
| `python/vapoursynth/` | VapourSynth R79 运行时 | 🔶 仅 RIFE 阶段需要 |
| `python/vapoursynth-79.dist-info/` | wheel 元数据 |  同上 |
| `scripts/passthrough.vpy` | 验证 mpv↔VapourSynth 桥接的最小脚本 | 🔶 同上 |
| 包目录内的 `python312.dll`(6.62MB)、`python312.zip`(3.66MB)、`python.exe`、`pythonw.exe`、`python3.dll`、`vcruntime140.dll`、`vcruntime140_1.dll` | ⚠️ **实验残留**（约 11 MB），应删除 | ❌ 删除 |

来源：PyPI wheel `vapoursynth-79-cp312-abi3-win_amd64.whl`（R79），
或官方 `VapourSynth64-Portable-R79.zip` 内的 wheel。

**布局很关键**：`src-tauri/resources/python/python312._pth` 中**原本就预埋**了
`..\vapoursynth\python` 一行，因此包必须放在 `resources/vapoursynth/python/vapoursynth/`，
`import vapoursynth` 才能成功，不需要设置 `PYTHONPATH`。

License：VapourSynth 为 **LGPL-2.1**，允许随应用分发。

## 三、项目外的系统改动

| 位置 | 内容 |
| --- | --- |
| `%APPDATA%\vapoursynth\vapoursynth.toml` | 307 字节。**本任务写入**，记录 Python 运行时与 `python312.dll` 路径。卸载时需手动删除 |

写入原因：mpv 加载 `vsscript.dll` 后，VSScript 必须知道 Python 解释器在哪，
否则报 `Python executable and library path couldn't be determined`。
官方 `vapoursynth config` 命令存在 bug（把 `int` 类型的 mtime 传给只接受字符串的
`_escape_toml_string`），写入失败，因此改用其自身的
`_mangle_vsscript_key` / `_escape_toml_string` 生成内容后自行写入。

## 四、临时文件（均在 `%TEMP%`，与项目无关，可全部删除）

`src24.mp4`、`mpvtest24.mp4`、`hd24.mp4`、`hd60.mp4`、`hd60b.mp4`、`hd120.mp4`、
`hd_up.mp4`、`out_placebo.mp4`、`out60.mp4`、`out120.mp4`、`statsA.csv`、`statsB.csv`、
`ttv_vpy/`、`mpv_extract/`、`vs_portable/`、`vs_wheel/`、
`mpv-x86_64-20260903-git-69e63f425a.7z`、`vs_wheel.zip`、`vs_portable.zip`

## 五、明确未改动的部分

- 前端 `src/**` — 未动
- `src-tauri/src/main.rs` — 未动
- `src-tauri/src/models.rs` — 未动
- `src-tauri/src/provider.rs`、`storage.rs` — 未动
- `package.json`、`Cargo.toml`、`Cargo.lock`、`tauri.conf.json` — 未动
- `.gitignore`、`.gitattributes` — 未动
- `src-tauri/resources/python/**` — 未动（仅读取）
- `src-tauri/resources/shortdrama-worker/**` — 未动

## 六、提交前必须处理

### 1. mpv.exe 必须走 Git LFS

`mpv.exe` 为 114.77 MB，**超过 GitHub 单文件 100 MB 硬限制**，直接提交会被服务端拒绝
（与本项目 `ffmpeg.exe` 当年遇到的是同一个问题）。需在 `.gitattributes` 追加：

```
src-tauri/resources/mpv/mpv.exe  filter=lfs diff=lfs merge=lfs -text
```

### 2. 清理实验残留

- 删除 `resources/vapoursynth/python/vapoursynth/` 下的 python 运行时（约 11 MB）
- 视方案决定 `resources/mpv/` 下 vapoursynth DLL 副本的去留

## 七、另一条任务线的改动（**非本任务产生**）

以下文件存在改动，但**不属于**本任务。它们属于「观看历史 / 继续观看 / 窗口控制」
的 bug 修复线：

| 文件 | 改动量 | 内容 |
| --- | --- | --- |
| `src-tauri/src/models.rs` | +43 | `WatchHistoryItem` 的 `null` 宽容解析（`de_f64_lenient` 等） |
| `src-tauri/capabilities/default.json` | +5/-1 | 窗口最大化相关权限 |
| `src/stores/useCatalogStore.tsx` | +18 | `refreshContinueWatching` |
| `src/components/views/HistoryView.tsx` | +6/-1 | 时长缺失时显示"已看 X" |
| `src-tauri/resources/shortdrama-worker/worker.py` | +138 | 解析 worker |
| `src/App.tsx` | +21 | — |
| `src/components/layout/TitleBar.tsx` | +23 | — |
| `src/components/player/VideoSurface.tsx` | +27 | — |
| `src/components/views/DetailView.tsx` | +6 | — |
| `src/components/views/ExploreView.tsx` | +21 | — |
| `src/stores/useAppStore.tsx` | +53 | — |
| `src/stores/usePlaybackStore.tsx` | +244 | — |
| `src/components/views/SearchView.tsx` | 新文件 | — |
| `src/services/windowFx.ts` | 新文件 | — |

> 核对方式：本任务会话开始时 `git status` 的输出里**没有** `models.rs`、
> `capabilities/default.json`、`HistoryView.tsx`、`useCatalogStore.tsx` 四项，
> 会话中途才出现，且内容与增强播放无关。

## 八、待完成的功能实现

1. `src-tauri/src/models.rs` 新增 `EnhancementProbe`
2. `src-tauri/src/main.rs` 新增 `enhancement_probe` / `enhancement_play` / `enhancement_stop`
   三个命令（`Mutex<Option<Child>>` 管进程，启动前先清旧进程），注册到 `invoke_handler`
3. 前端播放控制栏新增「目标帧数」输入框 + 应用按钮
4. `cargo build` + 端到端验证