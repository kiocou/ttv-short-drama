# 本项目后端接入

`TTV Short Drama` 拥有自己的 Tauri/Rust 后端，代码在 `src-tauri/`，**不调用也不依赖**其它项目的 Rust 命令、数据库或应用目录。

> 状态：✅ **现状文档**（2026-10 校核）。命令的权威清单是 `src-tauri/src/main.rs` 的 `generate_handler!`，
> 与本文不一致时以代码为准。

## 当前实现

| 领域 | 命令 | 实现 |
| --- | --- | --- |
| 目录 | `catalog_list`、`catalog_fast_search`、`catalog_suggest`、`catalog_categories` | 红果官网抓取 + 红果 App 榜单；`source` 指向 guo 站源时走 `duanju_core.dll` FFI（id 为 `guo:<source>:<id>`）。**红果被显式排除在 guo 链路之外** |
| 详情 | `series_detail` | 红果官网详情页；`guo:` 前缀走 guo 站源，`dmghg:` / `bfzy:` 前缀走动漫源（判定一律看前缀，不变量 9） |
| 封面 | `guo_cover`、`short_drama_app_cover_proxy` | guo 封面走 `asset:` 协议（本地缓存）；红果的 HEIC 封面由 Rust 代理转码 |
| 播放 | `playback_open`、`playback_command` | 红果走 App API + worker 解密整集下载；guo 走 FFI 取流；动漫走 dmghg 桥 / 暴风 m3u8。会话是单调递增的 `sessionId`，短期 URL **不写入 SQLite** |
| 清晰度 | `short_drama_app_qualities`、`anime_qualities` | 档位来自源流实测，**不伪造档位**（不变量 8） |
| 播放增强 | `media_enhance`（由 `settings.vsr_enabled` 驱动） | 把源流转成 **H.264** 本地分片 HLS，触发驱动侧 RTX VSR。补帧（RIFE / 小黄鸭）已于 0.2.5 整体移除，方案文档见 [`docs/design-proposals/magpie-video-enhancement-integration.md`](./design-proposals/magpie-video-enhancement-integration.md)（**未采纳**） |
| 画中画 | `pip_open` / `pip_handoff` / `pip_report` / `pip_close` / `pip_dismiss` / `pip_is_open` | 独立置顶窗口（label `mini`）；播放权同一时刻只属于一个窗口（不变量 13） |
| 历史 | `history_list` / `history_save` / `history_remove` / `history_clear` | 本应用数据目录里的 SQLite（WAL） |
| 收藏 | `favorites_list` / `favorites_save` / `favorites_remove` | 同上 |
| 设置 | `settings_get` / `settings_save` | 同上。注意 `settings_save` 会把 `default_quality` 强制为 `auto`、`preferred_engine` 强制为 `off`（不变量 8） |
| 缓存 | `cache_clear`、`short_drama_app_cache_usage` | 只清本应用自己的缓存目录；红果整集缓存带 7 天 / 1GB 的 LRU 预算 |
| 窗口 | `window_prepare_fullscreen` / `window_finish_fullscreen` | 全屏前静默解除最大化、退出时写回暂存矩形；**必须成对调用**（不变量 5） |
| 更新 | `update_check` / `update_download` / `update_reveal` / `update_install` / `app_version` | 走 Rust 而不是页面 `fetch`（CSP 只在生产构建注入）；下载完成后自动静默安装，安装包要过四道校验（不变量 13 的补充五） |
| 诊断 | `trace_ui_log` / `trace_tail` / `trace_clear` | 内存环形缓冲 + 落盘 `ttv-playback.log` + 接管原生 stderr |
| 站源体检 | `guo_source_status` / `guo_source_check` / `guo_proxy_get` / `guo_proxy_set` | 逐源五步链路体检；没体检过显示「未检测」，**不显示成可用**（不变量 8） |

历史遗留、前端已零调用但仍在注册表里的命令：`short_drama_app_status`、`short_drama_app_set_device`、`short_drama_app_album`、`short_drama_app_cache_clear`、`playback_snapshot`（恒返回占位值）。

## 运行方式

```bash
npm ci
npm run tauri dev       # 桌面窗口（Windows 专属）
```

浏览器模式继续使用 Mock 数据（`src/services/mockData.ts`）以便前端独立开发；只有本项目自己的 Tauri 窗口会调用真实目录、详情、播放与 SQLite 后端。

## 已知边界

- 公开网页是否提供播放 URL 取决于该集的官方开放范围；未提供时后端返回明确错误，**不会伪造可播放地址**。
- 清晰度档位来自源流实测：红果取 App API 的 `vwidth/vheight`（档位名不可信，见《画质档位分辨率实测验证.md》），动漫取桥接返回的档位，guo 取站源的真实档位。
- 外部站源的可用性由站方决定，**死源无法在代码里修活**：失败进 10 分钟冷却 + SWR 旧数据先返回（不变量 17）。
- 真实小黄鸭 / RIFE 等补帧 SDK 不会重新接入；当前唯一的增强是 `media_enhance` 的 H.264 路径。
