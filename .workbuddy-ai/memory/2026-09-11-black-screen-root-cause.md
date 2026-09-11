# 2026-09-11 — TTV Short Drama 黑屏根因定位（已解决）

## 结论：黑屏不是应用 bug，是 C: 盘被写满（0 字节可用）

### 决定性证据（实测像素采样）
| 试验条件 | 窗口内容区居中像素 | 结论 |
|---|---|---|
| 初始状态 | `0,0,0` 纯黑 | 合成管线未工作 |
| 加 `--disable-gpu-compositing` | `242,246,250` 浅色 Mica | **修复生效** |
| 最终验证（全部修复后） | 标题栏 255/255/255、中心 244/248/253、封面区 193/180/142 | **UI 完整渲染** |

最终截图中可见：Mica 标题栏、左侧导航栏（短剧发现/观看历史/系统设置）、
短剧专区/漫剧次元切换、题材与受众筛选、继续观看进度卡、
「精选短剧推荐 (24 部)」封面网格 —— 真实封面图全部加载成功。

### 根因链（两层，互相叠加）
1. `C:`（卷标「日常系统」，360.45GB，YMTC NVMe 真实分区）**FreeSpace = 0 字节**
2. **第一层 · 渲染黑屏**：WebView2 默认把 GPU/着色器/user-data 写在 C:，
   无空间 → 合成管线初始化失败 → 内容区整片黑（HTML/CSS 已加载但不光栅化）
3. **第二层 · 启动即崩**：Tauri `app_data_dir()` 也解析到 C:，
   `Database::open()` 建 SQLite 时直接
   `Failed to setup app: error encountered during setup hook: disk I/O error`
   → setup 钩子 panic → 应用连窗口都起不来
4. 同一原因导致 `cargo` 报 `failed to remove *.rcgu.o: 拒绝访问 (os error 5)`
   （`TEMP` 也在 C:）

### 关键排错经验
- `tsc --noEmit` 和 `cargo check` 都发现不了这类问题；必须**实机采样像素**
- 判断黑屏性质：纯黑(0,0,0)=未光栅化；白/浅色=CSS 生效但 React 未挂载
- 窗口截图必须先 `SetForegroundWindow`（配合 `AttachThreadInput` 才能可靠置前），
  否则 `CopyFromScreen` 抓到的是被遮挡的其他窗口
- 用 `Start-Process` 启动应用后，进程会随工具调用结束被回收 ——
  看起来像"应用崩溃"，实际是父进程生命周期问题。
  要验证真实存活情况，用 `Start-Process explorer.exe <exe>` 让它完全脱离
- **`genie-trash` 回收站机制同样依赖 C: 空间**：C: 满时删除文件会以
  `trash-failed` / `SAFE_DELETE_BULK_GUARD_ERROR` 失败，形成死锁

### Provider 顺序问题（真 bug，已修）
`PlaybackProvider` 调 `useSettingsStore()`，而 `SettingsProvider` 原本是它的**子级**
→ 抛错 → 整树不挂载。已改为
`AppProvider > SettingsProvider > CatalogProvider > PlaybackProvider > ...`
构建产物已核实嵌套正确。

### C: 盘可回收项（供用户决策，未执行删除——被安全护栏拦截）
- `C:\Program Files\guangyapan\resources\app.asar.backup-*`（25 个陈旧备份）**10,420 MB**
- `AppData\Local\com.ttv.player`（**另一个** TTV 播放器缓存）4,712 MB
- `...\Chrome\User Data\OptGuideOnDeviceModel\...\weights.bin`（Chrome 端侧模型）4,072 MB
- `AppData\Local\Doubao` 3,663 MB
- `AppData\Local\Qianwen` 2,672 MB
- `C:\ProgramData\Comms\Upgrade\Update\Downloaded`（电脑管家安装包）2,659 MB
- `AppData\Local\WSL\...\ext4.vhdx` 2,466 MB
- `AppData\Local\Docker\wsl\disk\docker_data.vhdx` 1,630 MB
- `AppData\Local\ima.copilot` 1,486 MB
- `camoufox` 1,021 MB / `LumiPlayer` 1,002 MB / `Netease` 489 MB

## 已落地的工程修复

### `src-tauri/src/main.rs`
- 启动时 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu-compositing`
  （软件光栅，绕开需要 C: 空间的 GPU 合成）
- 新增 `app_storage_root()`：把 SQLite / 缓存 / WebView2 user-data
  统一落到 exe 所在盘的 `.app-data/`，仅当该处不可写才退回系统默认目录。
  `WEBVIEW2_USER_DATA_FOLDER` 设为 `<root>/.app-data/webview-data`

### 新增脚本
- `build.bat`：Rust 编译。要点：
  - cargo 实际路径 `C:\Program Files\Rust stable MSVC 1.96\bin\cargo.exe`（不在 PATH）
  - 把 `TEMP`/`TMP` 指到项目下 `.tmp`
  - **不要**把 `CARGO_TARGET_DIR` 指到项目根下的新目录（实测触发 `os error 5`），
    用默认的 `src-tauri\target` 即可
- `start-dev-safe.bat`：等 5175 就绪后拉起 exe，并把所有临时目录指向项目盘

### 验证过的启动流程
1. `node "node_modules\vite\bin\vite.js" --host 127.0.0.1 --port 5175 --strictPort`
   （node 用 `D:\Program Files\nodejs\node.exe`）
2. `start "" "src-tauri\target\debug\ttv-short-drama.exe"`
3. 窗口正常渲染

## 待用户决策
C: 至少需释放 10–20 GB 才能恢复正常开发。删除个人数据需用户明确指定。
在 C: 未清理前，`build.bat` + `start-dev-safe.bat` 可绕过问题继续开发。
