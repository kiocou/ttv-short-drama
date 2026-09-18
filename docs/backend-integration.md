# 本项目后端接入

`TTV Short Drama` 现在拥有自己的 Tauri/Rust 后端，代码位于 `src-tauri/`，不调用也不依赖其他项目的 Rust 命令、数据库或应用目录。

## 当前实现

| 领域 | 本项目命令 | 实现 |
| --- | --- | --- |
| 目录 | `catalog_list` | 请求红果公开短剧目录/漫剧榜单，解析实时卡片与分页。 |
| 详情 | `series_detail` | 请求公开详情页，读取标题、封面、标签、简介和 `vid_list`。 |
| 播放 | `playback_open` | 仅在用户打开某一集时请求公开播放页；短期 URL 不写入 SQLite。 |
| 会话 | `playback_command`、`playback_snapshot` | 维护当前项目内的单调会话 ID，拒绝过期会话。 |
| 历史 | `history_*` | 使用本应用数据目录中的 SQLite/WAL。 |
| 设置 | `settings_get`、`settings_save` | 使用本应用 SQLite，不与任何其他应用共享。 |
| 缓存 | `cache_clear` | 仅清理 `com.ttv.shortdrama` 自己的缓存目录。 |
| 增强 | `enhancement_*` | 已于 v0.2.5 整体移除（见 `CHANGELOG.md` 0.2.5 条目）。重新接入方案见 [`docs/design-proposals/magpie-video-enhancement-integration.md`](./design-proposals/magpie-video-enhancement-integration.md) |

## 运行方式

```bash
npm install
npm run tauri dev
```

浏览器模式继续使用 Mock 数据以便前端独立开发。只有本项目自身的 Tauri 窗口会调用真实目录、详情、播放与 SQLite 后端。

## 已知边界

- 公开网页是否提供播放 URL 取决于该集的官方开放范围。未提供时后端返回明确错误，不会伪造可播放地址。
- 公开网页目前不提供可信的多清晰度列表，因此界面只展示“自动”。
- 真实小黄鸭、RIFE 或其他补帧 SDK 需要单独获得可再分发的 SDK/IPC 契约后才会加入后端；现阶段不会以模拟状态对外宣称已启用。
