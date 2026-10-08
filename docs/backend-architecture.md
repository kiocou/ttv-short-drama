# 短剧播放器后端与架构设计

> ⚠️ **状态：目标架构设计稿（不是现状说明）。**
> 本文描述的是目标形态：模块化目录（`domain/` `application/` `infrastructure/` `adapters/`）、libmpv actor +
> `mpv_render_context`/D3D11 合成、小黄鸭/RIFE 补帧、`commands/mod.rs` 拆分迁移。
> **现状**：单层 `src-tauri/src/*.rs`（13 个模块，见 `AGENTS.md` §4）、播放内核是 WebView2 `<video>`、
> 补帧引擎 0.2.5 整体移除、mpv 与外部播放器兜底 0.2.15 删除。本文与下面「现状对照」冲突时以现状为准。

## 0. 现状对照（2026-10 校核）

| 本文的说法 | 现状 |
| --- | --- |
| `src-tauri/src/{domain,application,infrastructure,adapters}/` | **不存在**。就是 `src-tauri/src/` 下一层的 13 个 `.rs` |
| `short_drama.rs`、`playback/`、`commands/mod.rs` | 都不存在（残留描述）。真实入口是 `main.rs` 的 `generate_handler!` 命令注册表 |
| libmpv actor / `mpv_render_context` + D3D11 compositor | 不存在。播放内核是 WebView2 `<video>`；HLS 走本地 `hls_proxy`（127.0.0.1 + 访问令牌） |
| `PlaybackPlan { primary, fallbacks, expires_at }` | 没有这个结构。会话是 `PlaybackSession`（`models.rs`），存在 `AppState.sessions: Mutex<HashMap<u64, PlaybackSession>>` |
| EnhancementManager / `FrameGenerationProvider` | 不存在。唯一增强是 `media_enhance.rs`（H.264 本地分片 HLS → 驱动侧 RTX VSR），开关 `vsr_enabled` |
| SQLite 七张表（series / episodes / catalog_snapshots / playback_manifests / provider_health / kv_settings） | 实际只有三张：`watch_history`、`favorites`、`settings`（KV），开 WAL；目录与详情缓存都在内存里（`storage.rs`） |
| 命令 `playback_set_quality` / `enhancement_capabilities` / `enhancement_set_preference` / `diagnostics_snapshot` | 都不存在。真实命令面见 `docs/backend-integration.md` 与 `main.rs` 的 `generate_handler!` |
| 事件通道（`playback.state` / `stats` / `source-changed` …，有界队列） | 不存在。前端直接订阅 `<video>` 的 DOM 事件，会话判定靠自增 `sessionId`（不变量 2） |
| 「视频媒体不由应用完整缓存」 | 已变更：红果短剧/漫剧是**整集下载解密后本地播放**，并带 7 天 / 1GB 的 LRU 预算（`short_drama_app.rs`） |
| 「缓存目录必须用 `com.ttv.shortdrama`」 | 成立（`app_storage_root()`，见 `AGENTS.md` 不变量 7） |
| 「禁止把用户输入直接当命令行参数传给 ffmpeg / mpv / 外部增强进程」 | 成立且范围已收窄：mpv 与外部播放器路径已于 0.2.15 删除 |

## 1. 目标与约束

本文定义 TTV Short Drama 独立桌面程序的后端模块、播放稳定性策略、缓存策略和补帧集成方案。

目标是：

- 让网络解析、播放器、历史和增强彼此隔离，单点失败可降级。
- 让换集、换源、换清晰度和断点续播拥有明确的会话边界。
- 在不预下载整集的前提下，降低首帧等待和下一集切换延迟。
- 为真实的小黄鸭实现保留稳定的适配器边界；在拿到授权的 DLL、可执行文件、SDK 或 IPC 协议前，不把现有 LSFG 仿真实现宣称为小黄鸭。

## 2. 推荐总体架构

首选“模块化桌面单体”，不拆微服务。桌面程序的网络、数据库、libmpv 和 GPU 资源都在本机，微服务会增加部署和故障面，不能直接改善播放稳定性。

```text
React + TypeScript
        |
Typed Tauri commands/events
        |
PlaybackSessionCoordinator
   |          |             |
Catalog      SourceResolver  PlayerCore(libmpv)
Database                         |
                         EnhancementManager
                       /          |          \
              Xiaohuangya       RIFE       Fallback
```

建议 Rust 目录：

```text
src-tauri/src/
  domain/
    catalog.rs
    series.rs
    playback.rs
    enhancement.rs
  application/
    playback_session.rs
    source_resolver.rs
    enhancement_manager.rs
  infrastructure/
    sqlite.rs
    cache.rs
    http_client.rs
    diagnostics.rs
  adapters/
    mpv/
    xiaohuangya/
    rife/
    display_resample/
```

现有 `short_drama.rs`、`short_drama_app.rs`、`playback/` 和 `commands/mod.rs` 可作为迁移来源，但不应继续让 `commands/mod.rs` 同时承担领域模型、流程编排和进程管理。

## 3. 核心模块职责

### 3.1 CatalogRepository

负责目录分页、分类、搜索、去重和 TTL 缓存。使用一个可复用的 HTTP 客户端，设置连接超时、读取超时、最大响应体和重试退避。目录数据写入 SQLite，内存缓存只做热点加速。

### 3.2 SourceResolver

负责把 `seriesId + episodeId + quality` 转成 `PlaybackPlan`：

```rust
struct PlaybackPlan {
    session_id: u64,
    primary: ResolvedSource,
    fallbacks: Vec<ResolvedSource>,
    qualities: Vec<VideoQuality>,
    expires_at: Option<DateTime<Utc>>,
}
```

解析顺序由提供商优先级决定，例如 App 直链、云端兼容解析、官网直链。解析器不得把签名 URL 持久化到日志；过期后重新解析。每个来源维护独立的错误计数和熔断窗口，避免坏来源拖慢所有剧集。

### 3.3 PlaybackSessionCoordinator

它是唯一的播放会话所有者。每次选择剧集、换源或换清晰度都生成单调递增的 `sessionId`。任何异步解析、播放器或增强事件都必须携带该 ID，过期事件直接丢弃。

基础播放状态机：

```text
Idle -> Opening -> Buffering -> Playing -> Recovering -> Ended
                         \-> Error
```

恢复策略：

1. 首次打开失败：在同一 `sessionId` 内尝试备用源。
2. 播放中网络中断：保留音量、位置和用户设置，短暂进入 `Recovering`。
3. 恢复超过预算：切换备用源并从最近安全位置继续。
4. 所有源失败：结束基础会话并返回可重试错误。

播放器只能有一个 libmpv actor。HTML5 `<video>` 不得与 libmpv 同时拥有同一播放会话。

### 3.4 PlayerCore

兼容阶段继续使用 libmpv actor，集中处理打开媒体、暂停、seek、音量、全屏、清晰度和统计信息。默认 seek 使用关键帧模式，精确 seek 作为显式慢路径。

目标架构迁移到 `mpv_render_context`：由应用拥有 D3D11 设备、交换链和合成路径。这样才能把解码帧以 GPU 纹理方式交给外部补帧后端，并避免 Windows `wid` 子窗口模型带来的跨进程纹理边界。

迁移期间保留两条渲染路径：

- Compatibility：`wid` + 现有 VapourSynth/RIFE/显示重采样路径。
- Target：`mpv_render_context` + D3D11 compositor + 独立补帧 worker。

两条路径必须由能力探测选择，不能在同一会话混用。

### 3.5 EnhancementManager

增强状态与播放状态分离：

```text
Off -> Probing -> Warming -> Running -> Degraded -> Faulted
```

增强失败只影响画面增强，不得销毁或阻塞基础音视频。管理器负责能力探测、预热、挂载、遥测、熔断和卸载。

建议接口：

```rust
trait FrameGenerationProvider: Send {
    fn probe(&self, gpu: &GpuInfo) -> Capability;
    fn warm(&mut self, config: FrameGenConfig) -> Result<(), FrameGenError>;
    fn attach(&mut self, session: RenderSession) -> Result<(), FrameGenError>;
    fn telemetry(&self) -> FrameGenTelemetry;
    fn detach(&mut self);
}
```

## 4. 小黄鸭补帧集成边界

当前资源中的 `MEMC_LSFG31.vpy` 是清洁室的 LSFG 思路实现，使用 VapourSynth/MVTools 光流；`MEMC_RIFE_DML.vpy` 是 ONNX Runtime DirectML 的 RIFE 路径。这些可以作为兼容或后备引擎，但不能当作真实小黄鸭 SDK。

接入真实小黄鸭前必须确认以下材料：

| 项目 | 必须明确的内容 |
| --- | --- |
| 交付形态 | DLL、静态库、可执行文件、shader、SDK 或本地 IPC |
| 输入 | D3D11 texture、共享句柄、CPU frame，或 NV12/P010/RGBA 格式 |
| 输出 | 输出纹理/帧队列、目标帧率、时间戳和同步方式 |
| 图形 API | D3D11、D3D12、CUDA、Vulkan 或其他 |
| GPU 要求 | 厂商、显存、驱动版本和多 GPU 行为 |
| 生命周期 | 初始化、预热、挂载、flush、停止、设备丢失恢复 |
| 许可边界 | 可再分发范围、调用限制和用户授权要求 |

如果小黄鸭只能接收桌面窗口或独立进程画面，则只能作为兼容捕获路径，延迟和稳定性都会低于共享 GPU 纹理路径。目标方案是：libmpv render API 输出纹理 -> 小黄鸭 provider 生成中间帧 -> D3D11 compositor 按时间戳呈现。

## 5. 稳定播放设计

### 5.1 网络与解析

- 全局复用 HTTP client，限制连接池和并发解析数。
- 目录、详情、manifest、签名 URL 使用不同 TTL。
- 解析请求支持取消，换集后立即取消旧会话的未完成解析。
- 对网络错误采用有限次数的指数退避；对 401/403、格式错误和明确的源失效直接切换来源。
- 预解析下一集 manifest，不预下载整集视频。

### 5.2 缓冲与换源

- 首帧前优先保证音视频基础链路，不在播放线程同步加载 ONNX 或大型滤镜图。
- 以缓冲时长、最近下载速度和丢帧变化决定是否恢复或降级增强。
- 换源时保存 position、audio track、subtitle 和用户设置。
- 新源首帧确认后再释放旧源，避免黑屏窗口；无法并行时至少保留上一帧作为 UI 占位。

### 5.3 增强熔断

增强连续供帧不足、设备丢失、处理延迟超预算或丢帧超过阈值时进入 `Degraded`，自动回退到原始渲染或 display-resample。熔断窗口内不反复重载模型；用户可在设置中手动重试。

## 6. 数据与缓存

SQLite 开启 WAL。核心表：

| 表 | 作用 |
| --- | --- |
| `watch_history` | 每部剧一行（`series_id` 主键）：当前集、位置、时长、进度、完成标记、channel |
| `favorites` | 收藏（`series_id` 主键）+ 分组标记、更新时间 |
| `settings` | KV 表，整份 `UserSettings` 按 key 存 |

本文原来列的 `series` / `episodes` / `catalog_snapshots` / `playback_manifests` / `provider_health` / `kv_settings`
**都不存在**（`src-tauri/src/storage.rs`）。剧集详情与目录分页缓存放在内存（`provider.rs` 的抓取缓存 +
`main.rs` 的 `SearchCache`）；guo 目录缓存由 guo-core 自己维护在 `<app_dir>/guo-core`，**TTV 侧不存第二份**。

缓存分层（现状）：内存 LRU 用于当前会话与目录/详情热点；磁盘用于**红果整集解密后的本地 mp4**（7 天 / 1GB 全局预算，LRU，见 `short_drama_app.rs`）与 guo-core 的封面缓存。缓存目录用独立的 `com.ttv.shortdrama` 应用数据路径（开发态落在 `src-tauri/.app-data/`），不与任何其它应用共用（不变量 7）。

## 7. IPC 与事件契约

命令按领域划分：

```text
catalog_list / catalog_fast_search / catalog_suggest / catalog_categories
series_detail / anime_qualities / guo_cover
playback_open / playback_command
short_drama_app_resolve / short_drama_app_resolve_prefix / short_drama_app_stream / short_drama_app_prefetch_stream
history_list / history_save / history_remove / history_clear
favorites_list / favorites_save / favorites_remove
settings_get / settings_save / cache_clear / short_drama_app_cache_usage
window_prepare_fullscreen / window_finish_fullscreen
pip_open / pip_handoff / pip_report / pip_close / pip_dismiss / pip_is_open
update_check / update_download / update_reveal / update_install / app_version
trace_ui_log / trace_tail / trace_clear
guo_source_status / guo_source_check / guo_proxy_get / guo_proxy_set
```

事件至少包括：

```json
{
  "type": "playback.state",
  "sessionId": 42,
  "at": 1710000000000,
  "payload": { "state": "playing", "position": 12.4 }
}
```

**现状没有事件通道**：这套 `playback.*` 事件从未实现；`playback_snapshot` 命令也只剩一个恒返回占位值的壳（前端零调用方）。真实播放状态全部由前端 `<video>` 的 DOM 事件驱动，异步续体靠自增 `sessionId` 判 stale（不变量 2）。

## 8. 可观测性与安全

记录结构化诊断事件：会话 ID、来源名称、阶段、耗时、错误类别、缓冲时长、解码帧率、输出帧率、丢帧数和增强状态。默认不记录完整播放 URL、Cookie、令牌或用户目录路径。

Tauri CSP、资源 scope 和外部请求白名单按最小权限配置。解析器只接受 `https`、受信任的 `http`（若业务确需）和本地播放器协议；禁止把任意用户输入直接作为命令行参数传给 ffmpeg、mpv 或外部增强进程。

## 9. 分阶段实施路线

### 阶段 A：兼容期

- 保留现有 libmpv actor 和短剧解析能力。
- 把播放会话、源解析和增强状态从全局脚本中抽出明确接口。
- 修正独立项目数据目录、请求超时、取消和 sessionId 竞态。
- 使用现有 RIFE/LSFG 仿真路径作为可选增强，并保证失败自动回退。

### 阶段 B：模块化重构

- 建立 domain/application/infrastructure/adapters 目录。
- 把 SQLite、HTTP client、provider health 和 manifest cache 收敛到基础设施层。
- 前端切换到按页面和领域拆分的 TypeScript 模块。
- 增加端到端播放测试、网络故障测试、换集竞态测试和增强熔断测试。

### 阶段 C：目标渲染路径

- 迁移到 `mpv_render_context` 和 D3D11 compositor。
- 引入真实小黄鸭适配器和独立 worker，完成共享纹理、时间戳和设备丢失恢复。
- 以能力探测选择小黄鸭、RIFE 或兼容渲染，不改变前端播放控制契约。

## 10. 验收指标

- 在正常网络下，首帧耗时、换集首帧耗时和恢复成功率可测量。
- 任意单个解析源失败不影响其他来源和下一次播放。
- 播放中增强进程退出时，基础视频在预算时间内恢复且不崩溃。
- 换集/换清晰度后位置误差在产品定义阈值内，且不出现重复播放器实例。
- 进程重启后历史、设置和目录缓存可恢复。
- 目标渲染路径能够报告实际输出帧率、处理延迟、丢帧和设备状态；不能用“已开启”静态文案替代运行时事实。

## 11. 当前实现对照

现状（2026-10）：短剧/漫剧（红果官网 + App API + 19 个 guo 外部站源）、动漫专区（dmghg 正式源 + 暴风兜底）、
画中画小窗、本地 HLS 代理与更新链路都已可用，前端构建与桌面打包在 CI 通过。

原文说「现有增强代码支持 `rife`、`lsfg` 和显示重采样」——**已不成立**：补帧代码 0.2.5 整体删除，
现在只有 `media_enhance.rs` 的 H.264 本地 HLS 转码（目的是让驱动侧 RTX VSR 生效，不变量 25）。

后续演进**不要**照本文的目录结构做重构（那是一次从未发生的迁移）；要改就按 `AGENTS.md` §7 的外科手术式改法，
别顺手重构仓库里的大文件。
