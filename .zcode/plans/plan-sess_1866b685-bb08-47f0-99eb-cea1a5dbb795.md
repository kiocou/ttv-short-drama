# 动漫专区实施方案

## 总体思路
在现有 TTV Short Drama（Tauri + React + Rust）中新增"动漫专区"导航入口，接入动漫共和国（dmghg）数据源。**核心风险是 pc/ 接口的加密认证头（Authentication，base64 密文）尚未逆出**——方案分两阶段：先搭全链路 UI + 播放管线（用可直连的公开兜底源保证"免登录、能播放"），同时做 dmghg 认证头动态抓包逆向，逆出后一行配置切换到 dmghg 正式源。

## 阶段 1：动漫专区 UI + 播放链路（保证全链路流畅）

### 1.1 前端入口与视图
- `src/types/catalog.ts` L1：`ChannelType` 加 `'anime'`
- `src/stores/useAppStore.tsx` L3：`AppView` 加 `'anime'`（独立专区视图，不动短剧 explore）
- `src/components/layout/NavigationRail.tsx` L22：navItems 加 `{ id: 'anime', label: '动漫专区', icon: Clapperboard }`（lucide-react）
- 新建 `src/components/views/AnimeView.tsx`：照抄 ExploreView 结构——顶部 Banner + 分类筛选（全部/热血/恋爱/搞笑/科幻 等）+ MicaCard 网格 + IntersectionObserver 无限滚动（rootMargin 1200px，同 ExploreView L60-75）

### 1.2 数据层
- 新建 `src-tauri/src/anime_provider.rs`：照抄 provider.rs 的 `DramaProvider` 模式
  - `pub struct AnimeProvider { client: reqwest::Client }`
  - `catalog(filter) -> CatalogPage`：调 dmghg 源（阶段 1 先接可直连源，见 1.3）
  - `detail(series_id)`：详情 + 选集列表（parts）
  - `open_episode(...)`：解析直链返回 `PlaybackSession`
- `src-tauri/src/main.rs`：AppState 加 `anime_provider: AnimeProvider`；`catalog_list` / `series_detail` / `playback_open` 按 `channel == "anime"` 分发到 anime_provider（其余逻辑不动）
- 历史记录/收藏：watch_history / favorites 表已有 `channel` 字段，直接写 `'anime'`，前端 HistoryView/FavoritesView 加动漫分组——零表结构改动

### 1.3 播放链路（免登录 + 流畅）
- **mp4 直链**：直接喂现有 `<video>`（VideoSurface.tsx L373），走现有 openEpisode 无缝换集链路（PreparedSource 预载），零改动
- **m3u8**：现有 WebView2 原生不支持 → 新增 `src-tauri/src/hls_proxy.rs`：本地 Range 代理（照抄 dmghg media-proxy 思路：起 `127.0.0.1:{port}`，把 m3u8/ts 请求转发到 CDN 并重写分片 URL 指向本地代理），`open_episode` 返回本地代理 URL；另在 VideoSurface 加 hls.js 兜底（`canPlayType('application/vnd.apple.mpegurl')` 不支持时启用）
- **画质选择**：直链多档时（如 4K 超清）返回 `quality` 列表，播放页加切换

### 1.4 数据源策略（双源兜底）
- 源 A（dmghg 正式）：`http://bkbfdm.hzhcbkj.cn/pc/*`（需要加密头，阶段 2 逆出后启用）
- 源 B（阶段 1 兜底）：直连可播放的公开动漫源 + dandanplay 弹幕协议，保证"免登录播放"立即可用
- 配置开关在 `settings` 表（settings_get/settings_save 已有），`anime_source: 'dmghg' | 'fallback'` 一键切换

## 阶段 2：dmghg 认证头逆向（切换到正式源）

1. 启动 dmghg.exe，用 frida/代理 hook 抓真实请求的 `Authentication / X-Token / ts / X-VERSION` 头值
2. 多时间点采样，比对密文差异，还原算法（预期是 AES-128-CBC(ts+盐) → base64，密钥在 electron_bridge.dll 的 auth.rs 内）
3. 在 anime_provider.rs 重实现头构造（Rust 侧 md5/aes128cbc/base64 工具已有参考实现）
4. 黑盒迭代：服务端响应分级清晰（30000 authentication empty → illegal base64 → 服务端故障 → 成功），可观测
5. 逆出后接通全部 pc/ 接口：列表/搜索/详情/播放（免登录部分）/弹幕/频道/Banner

## 交付验证
- `npm run tauri dev` 编译通过，动漫专区入口可见
- 点开任一动漫片 → 选集 → 播放（mp4 直链或 hls 代理），进度条/全屏/换集正常
- 观看历史、追剧收藏中动漫片正确分组显示
- dmghg 源接通后：搜索/列表/详情全部来自 dmghg 真实数据

## 涉及文件
新增：`src/components/views/AnimeView.tsx`、`src-tauri/src/anime_provider.rs`、`src-tauri/src/hls_proxy.rs`
修改：`src/types/catalog.ts`、`src/stores/useAppStore.tsx`、`src/components/layout/NavigationRail.tsx`、`src/App.tsx`、`src/services/ipc.ts`（anime 分支）、`src-tauri/src/main.rs`、`src-tauri/src/lib.rs`（mod 声明）、`src/components/player/VideoSurface.tsx`（hls.js 兜底）