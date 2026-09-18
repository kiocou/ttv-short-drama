# 给同时在这个仓库工作的其他会话 —— 交接说明

**时间：** 2026-09-18 12:35（00:05 版：只做逆向；后经用户同意已接入代码）
**来自：** PI-Desktop 会话 `8667e9ac`（动漫源逆向 + 接入）

## 我做了什么

### 第一步（已完成）：只读逆向

新增 `docs/dmghg-reverse/` —— 逆向笔记 + 可运行参考实现。
目标程序**零改动**（只读分析）。

### 第二步（已完成，经用户同意）：接入正式源

改动的文件（如果你也在改这几个，注意合并）：

| 文件 | 改动 |
|---|---|
| `src-tauri/src/dmghg_bridge.rs` | **新增**（约 820 行）。DLL 加载 + JSON RPC + 目录/详情/播放解析 + 7 个单测（其中 1 个 `#[ignore]` 真机冒烟） |
| `src-tauri/src/anime_provider.rs` | 文件头注释重写；`catalog` / `detail` / `open_episode` 各加一个正式源分支；`new()` 加数据源日志；文件尾加 `use_dmghg()` |
| `src-tauri/src/main.rs` | **只加了 1 行**：`mod dmghg_bridge;` |
| `src/components/views/AnimeView.tsx` | 分类芯片从硬编码改为用后端返回的真实分类 |

未动：`hls_proxy.rs`、`hlsAttach.ts`、`models.rs`、`storage.rs`、`provider.rs`、
`short_drama_app.rs`、`ipc.ts`、各 store。

验证状态：`cargo test` 35 passed / 0 failed（4 ignored）；`tsc --noEmit` 干净；
`npm run build` 通过；真机 `npm run tauri dev` 启动日志确认走的是正式源。

## 背景：动漫共和国的源现在已经完全打通

之前 `.zcode/plans/` 里那份方案把 dmghg 正式源标成「阶段 2：认证头逆向，未完成」。
现在这件事有结论了，而且结论和原方案不同：

1. **`Authentication` 头离线造不出来**（密钥是运行时从 `/app/config/host` 协商下来的，
   不在客户端二进制里，且服务端有防重放）。原方案「逆出算法后在 Rust 里重实现头构造」
   这条路是死的。
2. **正确做法：直接驱动厂商的 `electron_bridge.dll`**。它导出 7 个 C ABI 函数，
   用一个 JSON 信封就能调用，返回的已经是解密后的 JSON。列表/搜索/详情/选集/播放地址全通。

细节、实测数据、可运行代码见 `docs/dmghg-reverse/`。

## 两个务必知道的坑

- **`DMGHG_LEGACY_DIRECT_HOST` 必须设成 `http://bkbfdm.hzhcbkj.cn`**。
  不设的话 legacy 家族会走网关发现池 `175.178.11.16:7862`，对 `pc/*` 一律返回 418。
  （另三台主机 `bkbf.锦源木业.com` / `bljhm.锦源木业.com` / `tx.锦源木业.com` 已全部 502 死透。）
- **集数是"集名字符串"、线路是"线路代码"**：
  `part="第01集"`（不是 `"1"`），`play="cn"`（不是 `"1"`）。传数字一律 `400404 查询无果`。

## 如果要我接着接入 TTV

说一声即可。推荐落点：新增 `src-tauri/src/dmghg_bridge.rs`，在 `anime_provider.rs`
里按原计划留的 `dmghg_auth` 分支换成走它。
