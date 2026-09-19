# Changelog

## 0.2.7 - 2026-09-18

### 新增
- **动漫共和国（正式源）接入**：`dmghg` 桥接（驱动厂商 `electron_bridge.dll`）作为动漫频道正式源，HLS 本地代理 + hls.js 挂载播放，分类芯片用真实分类表。DLL 不可用时自动回退暴资源兜底源。
- **搜索并入动漫共和国**：搜索页此前硬编码只搜红果，动漫视频永远搜不到。现在三源并发（红果网页搜索 + App 联想 + dmghg）合并去重，短剧在前、动漫其次、联想垫底；dmghg 失败静默不陪葬。

### 修复
- **退出播放器后偶尔"只闻其声"**：播放器宿主常驻 DOM（离开页面只是隐藏），换集链路在最后一次会话守卫之后还有长时间 await（首帧等待最长 8 秒、HLS 挂载、`play()` 本身），期间用户返回主界面、慢解析再完成的话，旧会话照常 `setSrc + play()`，隐藏的视频就在后台放完。现在 `stopPlayback()` 作废当前会话、所有起播点 stale 即暂停（`pauseIfStale`）、错误兜底链在会话作废后整条停用、隐藏播放器时全局键盘快捷键不再操控"看不见的视频"。
- **漫剧预热/播放全线失败**（"预签名跳过"+"网络失败"刷屏）：服务端已静默拒绝漫剧旧 `aid=8704`（HTTP 200 空 body，无错误码）。实测漫剧 vid 用 `aid=8662` 在 v1/v2 端点都能取到播放模型，`CONTENT_PROFILES` 与 Rust 侧同步更新。
- 换集加载中"线路失败，切换备用域名"提示文案改为"主线路波动，已自动切换备用线路"——它是自动换线进度而非错误。
- **启动不再显示控制台窗口**：`windows_subsystem = "windows"` 改为无条件生效（此前仅 release 生效，debug 双击 exe 带黑色终端）。
- **动漫部分集完全播不出（"播放源连接受阻"）**：dmghg 源的选集**格式不统一**——同一部剧里，有的集是 http m3u8，有的集是 `preview.ndcsk.com`/`ndcyx.com` 的 **200MB+ https MP4 直链**。两个叠加问题：① 这些 https MP4 直链连接不稳定（实测 Range 探测间歇性 SSL EOF）；② 本地 HLS 代理转发大文件时用 `response.bytes()` **全量读进内存**再下发，268MB 的 MP4 直接把连接拖死（WebView2 报 `ERR_CONNECTION_CLOSED`）。现在动漫所有直链**一律走本地代理**，且代理改为**分块流式转发**（边读边写，首帧立刻抵达）。实测《炼气十万年》第 1/2 集（MP4）与第 38 集（m3u8）均 1920x1080 正常起播。
- **播放窗口在后台时被 WebView 省电暂停，误报"播放源连接受阻"**：WebView2 会把后台窗口里的纯视频媒体暂停以省电（`play()` 抛 `AbortError: video-only background media was paused to save power`），源本身已就绪。现在静默重试一次，仍失败回到缓冲态等播放手势，不再误判为播放源问题。

## 0.2.8 - 2026-09-19

### 修复
- **动漫专区的"切清晰度"此前是空操作（静态可判定）**。前端把**中文档位名**当档位字面量传给后端：`AnimeVideoSurface` 调 `setQuality(option.label)`（"1080P 高清"），而 Rust 的 `parse_quality_value` 只认 `{digits}p`（`trim_end_matches(['p','P'])` 之后必须全是数字），拿到中文名一律返回 0 —— 那是"由源决定"，于是静默回落到 auto 档（`height < 2160` 的最高档）。结果是点"4K 超清"和点"1080P 高清"都回到同一路地址，用户看到的是"切了没反应"；而**显式选 4K 恰好是唯一能绕开 auto 避开 HEVC 的路径**，这条路径等于被堵死。后端 `variants_to_options` 下发的 `value` 本来就是 `2160p`/`1080p`（与短剧链路同一套字面量），前端却用了 `label`。现在档位恒以 `value` 为准（含"同档位不重复解析"的短路），与短剧 `setQuality` 的语义一致。
- **两个播放器统一到同一套外观**：动漫专区原来的控制条是自绘的紫色圆角样式，与短剧的晶体材质（`crystal.css` 的 `ttv-*` / `crystal-*`）是两套视觉语言、两处维护。现在把外观抽成**纯 props 驱动**的 `PlayerHud`，短剧链路与其共用（`PlayerControls` 退化为读 store 的适配层，行为逐条对齐无改动）。动漫因此免费获得原来没有的一整套交互：右侧小锁的**收起态**与贴边迷你进度条、进度条的**缓冲层**读数（新增 `progress` 采样）、全屏状态与原生窗口同步（`onResized`）及"已进入全屏 · 按 Esc 退出"提示、`F` / `[` / `]` 快捷键、与短剧同款的加载卡片/错误卡片（错误卡补了"复制诊断信息"，并保留动漫特有的"下一集"出口——坏档位/坏线路在这批源里是常态）。选集改为同一个晶体巨幕；起播音量也对齐 0.85。
  **刻意保留的差异**：动漫仍是独立状态机 + **按需挂载**的 `<video>`（源形态在 hls.js(MSE) 与原生 src 之间来回切，销毁重建比"复用同一元素并小心清理"少一类事故）；缓冲态只给一个小胶囊而不用全屏遮罩——动漫是在线流，中途卡顿会反复出现，每次把画面盖住是倒退。
- **动漫链路不读设置页的"自动连播"开关**：`ended` 监听器只在媒体元素挂载时绑一次，闭包里读不到最新的 `settings`，于是用户关掉开关后仍在自动跳集。改用 ref 取最新值（短剧链路一直有这道判断）。
- **退出动漫播放器会丢掉播放进度**：`close()` 先 `haltCurrent(true)`（清 `src` + `load()`）再 `persistHistory(true)`，而落盘要读 `video.currentTime` / `video.duration` —— 媒体加载算法执行后这两个读数已经归零，历史里只会留下"看到 0 秒"。改为先落盘再拆源。
- **动漫会话号与短剧撞号段**：动漫播放器用自己从 1 开始的私有计数当会话号，短剧从 100 起。`playback_open` 按 `session_id` 保留最近 8 条（`retain(|id, _| *id >= session_id - 8)`），动漫的小号段会让 `playback_command` / `playback_snapshot` 永远匹配到已废弃的旧会话，也可能与会话上限互相顶替。现在动漫统一走 `generateNextSessionId()`，本地只留一个仅用于 stale 判定的守卫计数。
- **动漫专区有了自己的播放器：修掉"有声音、无画面、黑屏"**。根因是 `hlsAttach.ts` 的 `nativeHlsSupported()` —— 它用 `video.canPlayType('application/vnd.apple.mpegurl')` 判断浏览器是否原生支持 HLS，而 **WebView2 对这个 MIME 返回 `"maybe"`**，于是判真，动漫**全部绕过 hls.js 直接 `video.src = <m3u8>`**。实测这条原生通路 15 秒后仍 `videoWidth === 0`、`totalVideoFrames === 0`（只有声音在走、`currentTime` 正常推进，截图确认整屏黑），20 秒后才可能出帧；同一集改由 hls.js 挂 MSE 后 **13 秒稳定出 326 帧**。这也是"有的能看、有的黑屏"的来源——源形态本就是 m3u8 与整段 MP4 混合，而所有地址都被本地代理改写成 `/stream?u=…`，旧代码里的 `isHlsUrl()` 因此恒为 true。
  现在动漫走一条**独立链路**（`animePlayback.ts` + `useAnimePlayerStore` + `AnimeVideoSurface`；**短剧/漫剧一行未改**）：由 Rust 在改写地址**之前**判定源形态并随 `PlaybackSession.streamKind` 下发（`hls` / `file`），m3u8 恒走 hls.js、整段文件才走原生 `<video>`，**永不再采信 `canPlayType`**。同时挂了**出帧看门狗**：起播 9 秒内没有视频帧就如实报"这集的画面解不出来（源是 HEVC）"并停止播放，而不是让用户对着黑屏把一集听完——实测 dmghg 的 1080P 档有相当比例是 HEVC（牧神记 181964、无尽神域 181652、食草老龙 181468、虎鹤妖师录 181637；4K 档恒为 HEVC）。
  验证（生产 CSP 构建、真实窗口、CDP 采集）：动漫专区 → 点卡片 → 点「立即播放」→ 8 秒时 `videoWidth=1920 / readyState=4 / totalVideoFrames=177`，元素上存在 `__ttv_anime_hls__`，截图有画面；同一流程在修复前是 `videoWidth=0 / frames=0` 的全黑界面。短剧回归：红果漫剧仍走原链路，`asset.localhost` 本地文件、`1882x1080`、无错误。
- **打包安装后动漫封面大面积空白、视频黑屏无声（开发态却一切正常）**。根因是 `tauri.conf.json` 的 CSP——**它只在生产构建里注入**：开发态窗口直接加载 Vite dev server，响应头不归 Tauri 管，所以 CSP 完全不生效。而这条 CSP 有两处白名单太窄：
  ① `img-src` 没有 `http:`，而 dmghg 返回的 `pic` 实测全是 `http://p{2,4,5}-ad.adukwai.com/udata/pkg/*.jpg`，封面被整批拦掉（实测 `naturalWidth=0`，`AnimeView` 的失败重试 `?r=1` 同样被拒），表现就是"只有少数 https 封面能显示"；
  ② 全局没有 `worker-src`，回落到 `default-src 'self'`，hls.js 的 blob 转封装 worker 被拒（`Creating a worker from 'blob:...' violates the following Content Security Policy directive: "script-src 'self' 'sha256-...'"`）。CSP 拒 worker 走的是**异步 error 事件**而不是构造异常，hls.js 的 `try/catch` 兜不住，转封装从此永不产出——播放器停在"源已就绪但拿不到数据"，就是黑屏且无声音。
  现在 `img-src` 补 `http:`/`blob:`，`media-src`/`connect-src` 补 `http:`，并显式声明 `worker-src 'self' blob:`。实测打包态（生产 CSP）：封面 315x450 正常解码、`new Worker(blob:)` 回 `worker-ok`、动漫第 1 集 hls.js 报 `MANIFEST_PARSED`+`FRAG_LOADED`、`videoWidth=1920`/`readyState=4`，CSP 违规 0 条。
- **打包安装后数据被写到 `%APPDATA%` 的上一级**。`app_storage_root()` 无条件从 exe 向上回退两级，注释假设 exe 位于 `<crate>/target/debug`，但真实布局是 `<crate>/src-tauri/target/debug`，而打包后 exe 又在安装目录——于是 SQLite、剧集缓存、WebView2 用户数据全被塞进那个位置凭空创建的 `.app-data`（实测落在 `C:\Users\<用户>\AppData\.app-data`，而非 Tauri 标准的 `%APPDATA%\com.ttv.shortdrama`）。现在只在 exe 确实位于 cargo 的 `target/{debug,release}` 时才使用项目内的 `.app-data`（开发态行为不变），其余一律返回 `None` 交给调用方回退 `app_data_dir()`。
- **退出播放器后偶尔"只闻其声"**。播放器宿主常驻 DOM（离开页面只是 `display:none` 隐藏），而换集链路在最后一次会话守卫之后还有长时间 await（首帧等待最长 8 秒、HLS 挂载、`play()` 本身）：期间用户返回主界面、慢解析再完成的话，旧会话照常 `setSrc + play()`，隐藏的视频就在后台放完（实测：换集长期卡在切线重试 → 退出 → worker 稍后成功 → 后台出声）。现在 `stopPlayback()` 作废当前会话（session 号 +1，所有在途换集续体按 stale 处理、在途 open 任务移出复用池）；所有起播点在 `play()` 前后复查会话、stale 即暂停（新增 `pauseIfStale`）；错误兜底链（备用直链 → Blob → 本地解析）在会话作废后整条不再启动；隐藏播放器时全局键盘快捷键（空格/方向键/`[]`）不再操控"看不见的视频"。
- 换集加载中"线路失败，切换备用域名"的提示文案改为"主线路波动，已自动切换备用线路"——它是 worker 的自动换线进度而非错误，旧文案让用户误以为播放出错。

### 诊断记录
- 复现验证：三个播放域名（`api5-normal-sinfonlineb/sinfonlinea/lf.fqnovel.com`）连通正常（TLS ~30ms），`search → album → stream` 全链路约 1 秒成功；`fallback_api` 取直链域名由服务端下发且每次可能不同（实测见过 `api5-normal-sinfonline.fqnovel.com` 与 `vas-lf-x.snssdk.com`）；`/video/fplay/` 直链接口只在下发的业务域上有效，内置三播放域名对其返回 404。

#### 动漫「有声音、无画面、黑屏」根因（2026-09-19，真实窗口内实测）

现象：动漫专区部分集播放时**音频正常、画面全黑，且不弹任何错误**，界面照常显示进度在走。

取证手段：给 WebView2 加 `--remote-debugging-port=9222`（`configure_webview_browser_arguments` 会保留外部传入参数，只追加 HEVC 特性位），再用 CDP 读播放器真实状态；同时把**应用当时真正在播的那条地址**（从 `video.src` 代理参数的 `u=` 解出来）交给随包 ffmpeg 探真实编码。

实测数据（牧神记 第01集，稳定复现两次，两次地址一致）：

| 项 | 值 |
| --- | --- |
| 应用内档位 | `1080P` |
| 应用内 `video.src` 解出的真实地址 | `img.nxjunyu.asia/.../dd4795f9...m3u8` |
| 该地址的真实流 | **HEVC** 1920x1080 + AAC，MPEG-TS（分片伪装成 `.png`，实体在 `p2-kling.klingai.com`） |
| `readyState` / `paused` | `4` / `false`（应用认为正在播） |
| `currentTime` | 15.05s → 28.94s（持续前进，音频可闻） |
| `videoWidth` / `videoHeight` | **0 / 0** |
| `getVideoPlaybackQuality().totalVideoFrames` | **0** |
| `video.error` | **null**（无错，所以界面上不会有错误卡片） |
| `MediaSource.isTypeSupported('video/mp4;codecs="hvc1.1.6.L120.90"')` | `true` |
| `video.canPlayType('video/mp4;codecs="hvc1..."')` | `probably` |
| 本机 `Microsoft.HEVCVideoExtension` | 已安装 2.5.33.0 |

对照实验（同一 WebView2、同一窗口）：

| 用例 | 编码 / 通路 | 结果 |
| --- | --- | --- |
| 本机生成的测试片（libx265，`-tag:v hvc1`） | HEVC，**原生 `<video src>`** | 正常：640x360、150 帧 |
| 同上（libx264） | H.264，原生 `<video src>` | 正常：640x360、150 帧 |
| 斩神之凡尘神域 第1集 | H.264，**hls.js + MSE** | 正常：1920x888、728 帧 |
| 凡人修仙传 年番 第1集 | H.264，hls.js + MSE | 正常：1920x1080、780 帧 |
| 牧神记 第1集 | **HEVC，hls.js + MSE** | **黑屏有声音：videoWidth=0、0 帧、无 error** |

结论：
1. **平台 HEVC 解码器本身没问题**——HEVC 走原生 `<video src=渐进式 MP4>` 能正常解码出 150 帧。坏的是 **HEVC 经 hls.js 转封装后走 MSE 这条通路**：`isTypeSupported` 与 `canPlayType` 都回「支持」，MSE 不报错，`play()` 也成功（音频可解），但视频轨永远产不出帧——于是应用停在「源已就绪、正在播放」，用户看到的是黑屏。
2. **档位名与编码无关**。源只给中文档位名（`4K 超清` / `1080P 高清`），`width`/`height` 字段恒为 0。抽样热门榜前 14 部的第 1 集，自动档真实编码为 H.264 8 部、**HEVC 3 部（牧神记 / 剑来 第二季 / 海贼王）**，其余 3 部是 moov 在尾部的非 faststart MP4。`dmghg_bridge.rs` 里「这批源里 4K 档是 HEVC、1080P 及以下是 H.264」的假设**已被实测推翻**：HEVC 就出现在 `1080P 高清` 档，且 mpegts 与 mp4 两种容器都有。所以「auto 避开 2160p」这条规避手段治不了根。
3. **同一集的解析结果不稳定**：同一 `(剧, 集, 档)` 不同次调用可能回不同 CDN——实测凡人修仙传 年番 第01集一次给 `sns-video-hs.xhscdn.com` 的 701MB MP4（头尾 512KB 都取不到 moov），另一次给 `img.nxjunyu.asia` 的 m3u8（应用里 1920x1080、780 帧正常播放）。所以「事前探一次」不能当作「这一集能不能播」的依据，判定只能放在播放通路上做。
4. 源还会把非剧集内容当档位返回：实测见到 `v2-ad.video.yximgs.com/bs2/adVideoLp/...`（路径字面就是广告落地页，base64 解出 `ad_alliance_ssp:MERCHANT`）与 `sns-music.xhscdn.com`。这类地址即使能解码也不是剧集内容。

附带结论：批量采样分片时不能用 ffmpeg 直接吃 HLS 地址——该源把 TS 分片伪装成 `.png`/`.pdf`/`.wav` 扩展名，ffmpeg 的 HLS 解复用器按扩展名白名单直接拒绝（`URL ... is not in allowed_segment_extensions`），会把好源误判成坏源。采样脚本改为自己按内容嗅探容器后再交给 ffmpeg（见 `docs/dmghg-reverse/sample_codecs.py`）。

## 0.2.5 - 2026-09-16

### 移除
- **补帧与 RTX VSR 画质增强链路整体移除**（Lossless.dll FFI、mpv+VapourSynth 补帧、VSR 探测/注册表开关、前端全部组件与状态、resources 引擎文件）。应用回归纯 WebView2 原生播放：`<video>` + HEVC 系统解码器。决定依据：全屏钩子方案卡死闪屏（UI 层被当视频帧做光流）；mpv 独立窗口方案可用但交互脱节；WebView2 内嵌补帧需 WebCodecs + WebGPU 重写播放内核。`UserSettings.preferred_engine`/`target_fps` 字段保留以兼容旧设置库记录，恒为 off。

### 修复
- **连播倒计时：点「立即播放」后倒计时消失几秒又出现，到点再跳一集（一次跳两集）**。根因：`adoptPreparedSource` 为保住旧帧刻意不调 `video.load()`，接管后头 2 秒媒体元素上的 `duration/currentTime` 仍是上一集残留值（还在结尾 8 秒内），这段窗口里的 `timeupdate` 会把刚被取消的倒计时重新武装。修复：武装条件加"源结算期"闸（与 `tryClaimAutoAdvance` 同一逻辑），接管期内的 timeupdate 直接作废。
- **外部播放器与后台子进程闪终端窗口**。补 `CREATE_NO_WINDOW`（`CommandExt::creation_flags`）。

### 优化
- **详情页加载失败自动重试 1 次**（600ms 间隔），网络抖动不再白屏一整页；comic 频道空壳重试从 1 次升到 2 次（400ms 间隔）。
- **reqwest 连接池保活**（空闲 600s、`tcp_nodelay`）：目录翻页与换剧复用已建立的 TLS 连接，省 1-2 RTT。
- **清晰度探测延后 3 秒**：播放成功后立即探测会与相邻集预取抢同一个 python worker（单实例互斥），两边都慢。
- **预取队列泵首拍延迟 800ms**：换集瞬间让前台解析先拿 worker，起播不等预取。
- **NSIS 安装器图标换成应用图标**（此前 `setup.exe` 本身挂的是 NSIS 默认图标）。
- **mpv.exe（120 MB）入 Git LFS**，超过 GitHub 单文件 100 MB 硬限制。
- 清理全部编译警告（删除死代码 `RtxVsrCapability`、`Database::kv_get/kv_set`）。

## 0.2.4 - 2026-09-15

### 修复
- **自动连播有时一次跳好几集**。换集时 React 状态会**先于画面**推进（新源要解析/下载几秒才接管），这段窗口里迟到的 `ended`、旧倒计时到点，都会再按"下一集"算一次，于是连跳多集。实测把 3 次 `ended` 连续派发给主播放器，修复前会从第 3 集一路跳到第 5 集。现在自动跳集只认"画面里实际装载的那一集"，并加了三重闸门：触发所属的集必须就是当前装载的集、期间不能有更新的切换在途、源装载后要过 2 秒结算期、同一次装载只允许自动跳过一集。回归验证：3 连发 `ended` 只前进一集；自然播到结尾仍恰好连播一集。
- **窗口最大化时进全屏，任务栏还在、画面没铺满**。根因在 tao 的 Windows 窗口过程：为了让"最大化时别盖住任务栏"，它会把**仍处于最大化状态**的无边框窗口客户区裁到工作区（屏幕减任务栏），而 `set_fullscreen` 只改全屏标记、从不清除最大化。现在进全屏前先解除最大化，且必须是**静默**解除——新增 Rust 命令 `window_prepare_fullscreen`，用 `SetWindowPlacement` 原地改状态；直接调 `unmaximize()` 会走系统还原动画，实测窗口高度 1019 → 920 → 1067，看起来就是"进全屏回弹一下"。同时补齐 capabilities 里缺失的 `is-maximized` / `maximize` / `unmaximize` 权限（没有它 `unmaximize` 会被 Tauri 直接拒绝）。实测：最大化 1019 → 全屏 1067（铺满整屏、标题栏隐藏）→ 退出恢复最大化 1019，进/出全屏全程单调变化、无回弹。
- **漫剧播放后历史页里根本没有这条记录**。`video.duration` 对分片 MP4 / 未知时长的源会报 `Infinity`，`Math.floor(Infinity)` 仍是 `Infinity`，而 `JSON.stringify` 把它写成 `null`，后端 `position_seconds` / `duration_seconds` 是必填 f64——一个 `null` 就让整条 `history_save` 参数反序列化失败，记录一条都写不进去（实测某漫剧的 `video.duration === Infinity`，正是这个形态）。现在：前端把非有限值压成 0、并优先用 `seekable` 末值兜底出真实时长；后端宽容解析 `null`；真正开播就落一条记录；保存失败会打日志而不是静默变成 unhandled rejection。历史页时长缺失时显示"已看 X 分钟"而不是"尚未开始播放"；时长未知的上报不再把"已看完"标记冲掉。
- 回到发现页会重新读取"继续观看"，不再停留在应用启动那一刻的进度。

### 构建提示
- 独立运行的 release 包**必须带 `custom-protocol` 特性**：`cargo build --release --features tauri/custom-protocol`（`npm run tauri build` 会自动带上）。只写 `cargo build --release` 时前端资源不会内嵌，产物启动后仍去连开发服务器 `127.0.0.1:5175`，表现为"无法访问此页面"。

## 0.2.3 - 2026-09-12

### 修复
- **修复搜索结果"显示其他几季、不完整"**：站点剧名普遍使用中文数字（如"…真BOSS第十一季"），而它的搜索接口不做数字归一——直接搜"…第11季"会被模糊匹配到"第十季"，精确的那一部反而找不到。现在搜索会自动追加一份中文数字形式的关键词，两份结果合并去重（原词结果优先）。
- 搜索结果不再叠加列表页的题材/受众筛选。站点返回的本就是按相关度排序的结果，再用当前选中的题材剪一刀，就会出现"明明搜得到却显示不全"。
- **搜索新增 App 联想来源**：网页搜索每次只返回前 10 条，且分季剧集（"…第 N 季"）在结果里跳着出现。现在与网页搜索**并发**调用 App 搜索联想接口（`/reading/bookapi/search/suggest/v1/`，需要 iid+device_id 进 query 才不会被判 PARAM_INVALID），按名称前缀把整组季补齐，结果合并去重（网页结果优先）。实测搜"聚宝仙盆"能列全第十一/十/九/七/五/四/三/二季与仙界篇、灵界篇；搜"战神"由 9 条增至 16 条，总耗时约 1.8 秒。
- 联想条目改用 `video_data` 里的真实封面与集数（外层的 `pic_url` 是所有条目共用的类型通用图，拿它当封面只会得到一排名为空框的占位图）；确实不带封面的条目回退为剧名首字占位，集数未知时显示「集数未知」而不是「0 集全」。
- **修复播放历史不刷新**：视图是常驻 DOM（切换只切 hidden），而 HistoryProvider 只在应用启动时加载一次，导致启动之后看过的任何一集都不会出现在历史页——漫剧与短剧都会中招。现在每次进入历史页都会重新拉取。

## 0.2.2 - 2026-09-12

### 修复
- **修复搜索框搜不到内容**：旧实现在"当前已加载的这一页"（24 条）里做本地过滤，而全站有 800+ 部，于是只有恰好落在第一页的关键词能命中——搜"好雨"有结果，搜"战神"返回 0 条。
- 搜索改走站点自身的 `/search/{keyword}` 路由，从 SSR 的 router data 中读取结构化结果（标题、封面、集数、题材、简介），不再依赖当前页的本地过滤。实测搜"战神"命中 9 部、耗时约 0.3 秒；结果卡片标注来源为「红果官网搜索」。

## 0.2.1 - 2026-09-12

### 修复
- 修复观看历史显示「0分0秒 / 0分0秒」：视频元数据未就绪时上报的 duration=0 会把库里正确的时长覆盖成 0。现在时长不可信时只更新元数据，播放进度三件套保留旧值；界面上也改为显示「尚未开始播放」而不是无意义的 0。
- 修复播放器顶栏集数徽章显示成「第 1 集 · 第 1 集」（后端在缺少真实分集标题时会用「第 N 集」填充，前端再拼接就重复了）。
- 设置页副标题不再写「AI 插帧引擎」，与侧栏、README 口径统一。

## 0.2.0 - 2026-09-12

### 播放速度
- 打开详情页即预取（预签名）接下来几集的播放直链与解密密钥，点集时省掉两次 App API 往返（实测固定 2.16s）。
- 整集解析改为 ffmpeg 直连 CDN：拉流 + CENC 解密 + 转存一次完成，不再先落一份临时整集再解密（省 8.8MB 写 + 8.8MB 读）；失败自动回退到本地下载模式。
- 实测（清空缓存后的对照）：未缓存首播 5464ms → 2759ms；预签名命中 879ms；已缓存约 200ms 出画。
- 预签名直链过期时自动清缓存并重跑一次，用户不必手动重试。

### 修复
- **修复 CSP 把 Tauri IPC 快通道整个拦掉的问题**：`connect-src` 缺少 `ipc: http://ipc.localhost`，导致每次后端调用都先失败一次、再回退到 postMessage 慢通道。
- 移除被 CSP 拦截的 Google Fonts 外链——界面本就用 Windows 系统字体栈，外链只带来一次失败请求与控制台报错。
- 修复公开播放页路由：`/player/{series}/{episode}` 实测恒定 404，改为 `/player/{series}`，并新增集匹配校验，避免把默认集地址当成目标集播错内容。
- 修复「分享此剧」只弹提示、从未写入剪贴板的问题。
- 修复诊断面板中的假指标：写死的 `0.00%`、恒为 0 的解码帧率与延迟、与实际渲染管线不符的「D3D11 共享纹理模式」，全部改为从 WebView 实测采样。
- 修复导出诊断日志后立即 revoke blob URL 可能导致下载未开始的问题。
- 移除硬编码的本机绝对路径。

### 变更
- 应用数据目录从共用的 `com.ttv.player` 迁移到本应用自己的 `com.ttv.shortdrama`（与 identifier 一致），首次启动自动搬迁设备凭据与剧集缓存；两个应用不再互相触碰对方的数据目录。
- 侧栏与诊断面板不再宣称「120 FPS AI 插帧」——真实补帧 SDK 尚未接入，界面只呈现原生档。
- 清理开发期残留的死代码（模拟降级、无写入方的解码帧率）。

### 遗留问题修复（0.1.1 之后）
- 修复同一部剧内换集 / 自动连播下一集时弹出「播放源连接受阻」的问题：
  - 本地已缓存的整集不再因隐藏探针预热超时被误判为损坏（改为直接喂给主播放器重试）。
  - 解析链路改用调用时捕获的会话号判活，消除旧会话打断新会话导致的 `AbortError`。
  - 对同一集的重复 `openEpisode` 做去重，避免自动连播时两条解析链互殴。
  - 整集解析瞬时失败时自动重试一次（每集仅一次）。
  - 自动播放被 WebView 拦下时如实提示「请点击播放按钮开始」，不再降级谎报源故障。
- 错误卡片显示真实失败原因，并支持一键复制诊断信息（错误码 / 原因 / 剧集 / 集数 / 位置）。
- 修复后台预取与前台换集互相破坏：解析前的缓存清理不再删除 mtime 很新的半成品
  （`.part.mp4` / `.source.tmp`），此前会把并发预取 worker 正在写的那一集删掉。
- 修复接管新源期间的 `error` 事件被 `handleError` 抢先判死：此前会弹出错误页并让
  直接播放兜底失效（画面已起播、界面却停在错误页）。
- 修复自动播放被拒的误判：视频已静音时 `NotAllowedError` 不再被当作源故障，
  避免无谓地删除缓存登记并重解析整集。
- 修复两处界面永久停在转圈：本地解析失败未收口、以及误复用上一会话的在途解析。
- 修复某一集失败后永久失去自动重试资格。
- 前台解析（换集 / 自动连播）时暂缓后台预取：此前最多 3 个 python worker + ffmpeg
  并发，会拖慢用户正在等的那一集。
- 补齐播放器宿主缺失时的收口，杜绝界面永久停在「正在准备播放源」。

## 0.1.1 - 2026-09-11

- 修复 Windows 生产包启动时额外显示终端窗口的问题。
- 禁用 WebView 默认右键菜单，保持桌面播放器交互一致。
- 统一前端、Tauri 和 Rust 包版本为 `0.1.1`。
- 修正 GitHub Actions 的 Git LFS 检出与随包资源校验。
- 更新资源分发、构建和发布说明。
