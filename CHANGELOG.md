## Unreleased

### 整理（面向公开仓库）

- **把维护者本地材料移出公开仓库（`git rm --cached` + `.gitignore`，文件仍留在本机）。** 收口三类：**智能体提示词**（`AGENTS.md`、`.zcodeignore`）、**设计与调研稿**（`docs/`、`design-proposals/`、根目录两份实测/设计记录）、**品牌素材库**（`VidCom图标库/`；App 图标另有 `public/app-icon.png` 与 `src-tauri/icons/`，不受影响）。移出后公开仓库只剩源码 + `README` / `CHANGELOG` / `LICENSE` 三份 Markdown。
  - **为什么是「移出」而不是删除**：它们对本机维护仍有用（`AGENTS.md` 是改代码前的必读清单），删掉等于丢东西。要恢复任意一项：`git add -f <路径>`。
  - **顺带脱敏**：`build.bat` / `start-dev-safe.bat` / `release.ps1` 里写死的本机 Rust、Node 安装路径，改为**环境变量（`TTV_CARGO` / `TTV_NODE` / `TTV_CARGO_BIN`）→ PATH** 的顺序查找；`guo-core/diag/probe_sources.py` 的 DLL 路径改为 `TTV_GUO_CORE_DLL` → 仓库相对位置；`CHANGELOG` / `media_enhance.rs` / `worker.py` 里指向本机工作区（`.workbuddy/*`）的实验记录引用改为中性描述。
  - **本机要沿用原来的绝对路径，请先设上述环境变量**——否则这几个脚本会直接报「找不到 cargo / node」。
  - **`.gitignore` 同步重写**：本地材料与各类 AI 工具工作区（含会话记录、真实源地址、样本与截图）统一登记，并补 `.cline-home/`，避免以后误提交。
  - ⚠️ **只改工作分支**：`main` 与 git 历史里这些文件仍在；历史清理需要重写 + 强推，**未执行**。

### 文档

- **全仓库文档与代码对齐（纯文档改动，不改任何行为）。** 起因是一次逐文件核对，发现三处「文档说的和代码做的不是一回事」：README 里「检查更新**不会自动安装**」早在 0.2.15 就被推翻（`update_install` + `app.exit(0)`），却一直留在用户可见的位置；`AGENTS.md` §4 的模块表漏了 `media_enhance.rs` 与 `trace.rs`、且 11 个模块的行数全部过期；`docs/backend-integration.md` 的命令面还停在 `enhancement_*` 时代。
  - **做法**：给每份非权威文档加**状态标签**（✅ 现状 / ⚠️ 目标架构 / ⚠️ 阶段性存档 / ❌ 未采纳），并在 `README.md` 与 `AGENTS.md` §6 建了一份「文档地图」，一次说清「哪些能照抄、哪些只能当证据」。权威顺序统一为 **代码 > `CHANGELOG.md` > `AGENTS.md` > 其它文档**。
  - **同步的硬事实**：Rust 模块表（13 个模块 + 现行行数）、worker 子命令白名单（`resolve / resolve-prefix / stream / album / search / counts / feed`）、真实 Tauri 命令面与三条零调用的历史命令、SQLite 实际只有三张表（`watch_history` / `favorites` / `settings`，WAL）、随包资源清单（`duanju_core.dll` 缺了应用起不来，但 CI 未校验它）、`npm run verify:boost` 不在 CI 里、启动动画实现总长 2150ms（设计稿标称 2300ms）。
  - **明确写进文档的「不要照做」**：那两份目标架构稿里的 libmpv + 补帧 + `domain/application/infrastructure/adapters` 目录结构从未落地；Magpie 增强方案未采纳；调研记录里的 `rank` / `latest`、`short_drama_app_preload`、`preloadNative`、`variant_cache`、`bitrateKbps`、`TTV_SD_SOURCE_TMP` 等标识符在代码里零命中。
  - 本次**只动 Markdown**（`git diff --stat` 全是 `.md`）：既没有改代码，也没有改 CI。CI 的两个缺口（不跑 Go、资源校验漏 `duanju_core.dll`）只做了记录，修不修由后续单独决定。

### 移除

- **仓库内不再保留「私有渠道」调研记录，相关表述统一为「私有渠道」。** 删除 `docs/` 下的私有渠道调研记录（8 个文件：调研笔记、参考实现、从第三方响应转储的脚本原件与样本数据）与三份红果侧调研报告（客户端分析、两批样本分析）；`README.md`、`AGENTS.md`、本文件、代码注释、`.gitignore` 与**打包进包的 worker**（`resources/shortdrama-worker/worker.py`、`liushen/device_register.py`）里的相关措辞一并改为「私有渠道」。
  - **为什么删**：这些材料不是项目内容——其中一份是从第三方响应里转储的脚本原件，其余是笔记与样本数据，留着没有维护价值，却让公开仓库替它们承担授权风险。该保留的**接口结论**都在代码注释与 `docs/backend-integration.md` 里，没有丢。
  - **代码只动了注释与一条用户可见文案**（`worker.py` 的设备身份报错措辞），无行为变更；`npx tsc --noEmit` 与 Python 语法校验通过。
  - **两份仍有价值的实测/设计记录当时保留在仓库**（档位矩阵与未实施设计稿），随后随下面的「仓库整理」一并移出公开仓库。`LICENSE` 的授权范围**没有放宽**：三条说明仍然是「不在 MIT 范围内、权利属各自权利人、再分发前先移除」。
  - ⚠️ **本次只删在工作分支上**：`main`、修包/分支与 git 历史（含已 clone 的副本与 fork）里依然能找到这些文件。要彻底清除需重写历史 + 强推，**尚未执行**。

## 0.2.20 - 2026-10-08

### 修复

- **动漫专区切换类目不再卡顿：目录加了内存缓存 + 后台刷新（SWR）。**
  - **根因**：切类目走的是 `dmghg_bridge::catalog_async` → `catalog.get_video_list` 的同步 FFI，而这条链路**完全没有缓存** —— 同一个类目来回切两次，第二次照样重新跨进程取一遍。用户报告的「日漫、国漫切换不能秒加载，会卡顿一下才刷新出来」就是这段等待。
  - **修法**：给动漫目录加 `类目|分类|受众|排序|关键词|页` 六维键的内存缓存，TTL 15 分钟，与 guo 19 源那套「缓存优先 + SWR」一致：TTL 内直接回内存；过期后**仍然立即回旧值**、后台再刷新（前台永远不为刷新等待，刷新失败也只记一行日志）。
  - **实机验证**（`cargo test -- --ignored --nocapture dmghg_catalog_cache`，本机真实客户端）：冷查 **666ms** → 热查 **36us**，快约 1.8 万倍；同时断言换类目**不命中**上一个类目的缓存（漏掉筛选维度就会串味，那是比慢更糟的错）。
  - 设置页「一键清空缓存」会一并丢弃这层缓存：用户点它的意图是「让程序重新取一遍数据」，留着会让他在 TTL 内看不到任何变化。

- **首页「继续观看」提前预签名，缩短点进去的首开等待。**
  - **实测依据**（真实 CDN 逐段计时）：前缀通道的总耗时里，**两次 App API 往返固定 2485ms**，下载 2MB 2301ms，解密 + 重编码 983ms，NVENC 可用性探针 333ms。API 往返是最大的一块，且它与带宽无关、纯粹是等待。
  - **为什么首页这张卡值得专门处理**：详情页那条路径有详情接口的往返给预签名打掩护（用户在看简介），而首页「继续观看」卡是**从打开应用就一直在屏幕上的**，预热窗口有几分钟，比详情页更充分。用户上一轮实测日志里就出现过 `复用预签名=false` 的首开样本，那正是这条路径。
  - 只发 `prefetchStream`（两次 API 往返、不下载媒体、几 KB），不会与首页目录请求抢带宽；同一集只预热一次（`continueWatching` 会随进度频繁变化，不设闸门会反复重发）；动漫与 guo 源按频道与 id 前缀挡掉——它们不走这条链路。

### 说明

- 前缀产物的大小**由源片码率决定，不是固定的 2MB**：默认下载 2MB 源流，解密后重编码成 H.264 会膨胀（实测 2MB → 9.6MB / 12.7MB，覆盖开头 13–26 秒）。`TTV_SD_PREFIX_BYTES` 调的是**源侧**字节数，不是产物大小。
## 0.2.19 - 2026-10-07

### 修复 / 调整

- **长按加速改为固定的 2 倍速，不再跟随控制栏所选档位。**
  - **为什么改**：0.2.18 把它做成了「所选档位 × 3、上限 4x」，实际用起来是错的——用户在 0.5x 档只是想慢看，长按却把他送到 1.5x；在 2x 档长按只多出一倍。同一个手势在不同档位下效果差好几倍，完全不可预期。固定值才是「临时快进一下」该有的手感。
  - **边界处理**：控制栏里有 3x 档，而长按只到 2x —— 不加保护的话，3x 用户长按会「加速」到 2x，也就是**减速**，画面还会弹一个「2x 加速播放」的提示。现在基准速率已达到或超过 2x 时长按不做任何事、不弹提示，倍速菜单里的说明行也相应用「当前档位已不低于 2x，长按不加速」代替。这条边界是写完用例后跑出来的（`基准 3x：长按不降速` 一开始是红的），不是事后想到的。
- **速率与阈值的常量收敛到 `src/services/boostController.ts` 一处。** 上一版在 `VideoSurface`（执行加速）与 `PlayerHud`（菜单提示）各写了一份「倍数 3 / 上限 4」，改动时很容易只改一处，症状是「菜单说 3x、实际加速到 4x」这种没人会去核对的不一致。现在两边都从 `BOOST_RATE` / `BOOST_HOLD_MS` 取值。
- **验证用例扩到 36 项**（`npm run verify:boost`）：新增「逐个档位确认长按都固定到 2x」「基准 3x 时不降速、不弹提示」，并修正了一条与新语义自相矛盾的旧断言。
## 0.2.18 - 2026-10-07

### 改进

- **长按临时加速的触发方式从「按住画面」改成「按住 ← / →」，并且加速速率跟随控制栏里选的倍速。**
  - **为什么换触发方式**：旧实现把长按挂在 `<video>` 的 `pointerdown` 上，与单击（播放/暂停）、双击（全屏）共用同一个元素——鼠标用户稍微按久一点（>350ms）就会意外进入 3 倍速，触屏用户想「按住画面看细节」时同样会误触。方向键没有这层歧义：键盘按住的语义本身就是「持续」，长按期间画面也不会产生任何点击手势。
  - **加速速率 = 所选档位 × 3，上限 4x**。旧实现是写死的 3x，用户在控制栏把倍速调到 1.5x 之后长按仍然只有 3x，观感是「长按把我设的倍速重置了」。现在 0.5x 档长按得到 1.5x、1.5x 档得到 4x（1.5×3=4.5 被上限截断）、2x 档得到 4x。
  - **倍速菜单同时扩充档位与说明**：档位从 `0.75 / 1 / 1.25 / 1.5 / 2` 扩到 `0.5 / 0.75 / 1 / 1.25 / 1.5 / 2 / 3`（慢速档正是为了让「加速」有意义——0.5x 长按 → 1.5x 正好当快速过一遍用）；菜单底部新增随档位变化的说明行「长按 ← / → 加速到 Nx」，这是唯一能把「加速倍率相对所选档位」讲清楚的地方。
  - **长按时显示加速提示、松开即隐藏**：画面顶部中央出现「Nx 加速播放 / 松开恢复」，同时控制栏的倍速按键高亮为「Nx 加速」。提示里的 N 是**真实生效的速率**（已按上限截断），不是倍数本身——不这样写，2x 档用户看到「3x」会与观感对不上。
  - **一次按下只做一件事**：按住不足 350ms 松手 = 一次普通快退/快进 5 秒（语义与改造前完全一致）；加速已经起效则松手**只恢复原速、不跳转**（否则用户会先看到画面加速播一段、松手瞬间又被弹到 ±5 秒处）。窗口失焦（keyup 收不到）与 Esc 都会收掉加速，避免倍速被永久留在高位。
  - **这套状态机被单独抽成 `src/services/boostController.ts` 并配了 26 条确定性用例**（`npm run verify:boost`，假时钟 + 假 video，不依赖真实定时器）。抽出来的直接理由是：这三件事（阈值、松手的归属、恢复目标）全都与时间相关，靠肉眼和浏览器里跑毫秒级断言既慢又不稳——headless 下媒体元素还会因自动播放策略停在 `paused`，使「只在播放中加速」这条前提永远不成立。组件只负责把按键事件接上去，所以**被验证的就是线上跑的那份代码**，而不是另写一个仿制品。

### 修复

- **播放页底部的贴边进度条「有时候会不见」。**
  - **根因是对比度，不是元素消失**：那条 3.5px 的底轨用的是 `rgba(255,255,255,0.22)` 纯白。它在黑画面下刚好够用，但这条 CDN 的短剧大量是白墙 / 白西装 / 雪景这类高亮近景——纯白叠纯白，**实测合成后与背景的亮度差为 0**，整条线等于完全不存在。换一集暗场景又正常，所以现象是「有时候」。用户随截图报告的正是白西装场景。
  - **改用中性灰**：`rgba(128,128,128,0.55)` 叠白 → 约 185（差 70）、叠黑 → 约 70（差 70），是唯一能同时与**两种极端背景**拉开对比的选择（纯黑衬底在白底上差 107，但在纯黑画面上同样归零）。缓冲段与「时长未知」的占位填充同族处理。
  - **时长未就绪时不再画成空轨**：`duration <= 0` 时旧实现把已播段也算成 0（还可能在除零后得到 `NaN`，`scaleX(NaN)` 会让整条彻底消失），于是源刚起播那几秒进度条是空的。现在这种情况改画一段固定宽度的低饱和填充，明确表示「在加载」。
  - 顺带删掉三条永远不会触发的 `:hover { height: 6px }` 规则——本元素设了 `pointer-events: none`（纯显示件、不接手势），不产生指针事件的元素也就没有 hover 状态，留着只会误导后来人。
  - 占位填充刻意**不做**无限循环动画：任何持续动画都会被提升为常驻合成层，而这条播放器的合成约束极其昂贵（历史上正是合成层问题让 NVIDIA VSR 失效过一次，见 AGENTS.md 不变量 26），多一点「在动」的暗示不值这个风险。

- **`trace` 模块的测试自身存在并行竞态（不是产品缺陷，但会让门禁随机变红）。** 三个用例都操作同一个全局环形缓冲，而 `cargo test` 默认多线程并行——`dropped_flag_reports_gaps` 灌进去的 110 行会打断 `tail_returns_only_newer_lines` 的「同一个 cursor 不该再取到行」断言。本次版本号变更后新增的两个用例改变了线程调度，104 passed 直接变成 105 passed / 1 failed。修法是给这两个读写全局缓冲的用例加一把静态互斥锁（纯函数的 `redact_strips_query_and_userinfo` 不加），连跑 5 次确认稳定在 106 passed。
## 0.2.17 - 2026-10-07

### 修复

- **「开关 VSR 都没用」的真正根因找到了：设置从来就没存进库。** 这是 0.2.16 里那条 `-tls_verify` 顺序问题之外的**第二条独立根因**，由发布前审查（Rust + 前端两路并行只读审查）发现。
  - **证据**：`src-tauri/src/models.rs` 的 `UserSettings.hardware_acceleration` 既没有 `#[serde(default)]`，前端 `src/types/settings.ts` 的 `UserSettings` 也一直漏了这个字段。
  - **机制**：`settings_save(settings: UserSettings)` 的入参是 **serde 反序列化出来的**——缺一个无默认值的字段就在反序列化阶段整体失败，命令体一行都不执行。于是：① 设置页的任何改动都「看起来生效了」（前端内存里确实变了），但从不落库、重启回到默认；② 命令体里的 `set_vsr_enabled(settings.vsr_enabled)` 也一并没跑，运行期开关自然不生效；③ 唯一的反馈是 `useSettingsStore` 里被吞成 `console.warn` 的一行。用户报告的「开关 VSR 都没用」正是 ② 的直接现象。
  - **修法（两侧同时补）**：前端 `types/settings.ts` 补上 `hardwareAcceleration: boolean` 字段（写了长篇注释说明为什么前端不提供界面开关也必须保持字段同形），`ipc.ts` 的 `DEFAULT_SETTINGS` 补 `true`；Rust 侧给该字段加 `#[serde(default = "default_true")]`，让将来任何漏字段的调用方最多只丢掉这一个开关，而不是整条保存链路。
  - **回归用例**：`models.rs` 新增 `legacy_record_without_hardware_acceleration_still_parses`（缺字段必须能反序列化且默认为真）。
- **VSR 关闭时写下的「假 H.264 标记」会让增强永久失效。** `ensure_h264_cache` 在 VSR 关闭分支里写的标记内容与「转码成功」**一字不差**（都是 `h264\n`），而命中判定只看文件是否存在。
  - **后果**：用户关掉 VSR 看一集 HEVC 旧缓存 → 那集被打上假标记；之后**重新打开 VSR**，该集被直接短路放行，HEVC 文件照原样播出去，视觉增强静默失效（不变量 25：VSR 的硬条件是 H.264）。现象是「有些集有 VSR、有些集没有」，极难排查。
  - **修法**：新增 `marker_content_is_h264()`，只认内容为 `h264` 的标记；关闭分支改写成 `skip`。配套回归用例 `h264_marker_content_decides_migration_state`（覆盖 `h264` / `skip` / 空 / 不存在四种）。
- **从短剧播放器直接进动漫时，短剧链路从不停止（不变量 1 的实质缺口）。** 详情页 / 发现页 / 历史页三条动漫入口都在 `currentView` 仍为 `'player'` 的情况下打开动漫播放器，而 `App.tsx` 的停播守卫是 `if (!isPlayer) stopPlayback()` —— `isPlayer` 自始至终为 true，**一次都不触发**。
  - **后果**：短剧那块 `<video>` 只是被 `display:none` 藏起来，卡死看门狗、连播倒计时、预解池、在途 `resolveNative` 全部存活；倒计时到点会把一部用户根本看不见的短剧强行开播并出声。动漫侧的 `haltCurrent` 停的是它自己那块 video。
  - **修法**：守卫改为 `if (!isPlayer || isAnimePlayerOpen) stopPlayback()`，并把 `isAnimePlayerOpen` 列进依赖数组。
- **退出全屏的「进全屏前是否最大化」存在模块级变量里，异常路径不复位。** `enterFullscreen` 在 `setFullscreen(true)` 抛错或状态轮询超时时直接返回、不清状态，残留的 `true` 会被**下一次** `leaveFullscreen` 消费，走去调 `window_finish_fullscreen`——按仓库自己的注释，后果是把「还原矩形」永久钉死在整屏、标题栏「向下还原」失效。快速连按 F 时两次 enter 还会互相覆盖同一个变量。
  - **修法**：引入自增令牌 `fullscreenToken` 做所有权判定——`enterFullscreen` 开头领取令牌、之后每步写状态前复核是否仍持有；`leaveFullscreen` 开头 `revokeFullscreenOwnership()` 作废在途 enter。失败/超时路径显式复位为 `false`。
- **并发 `media_enhance::start` 会泄漏 ffmpeg 长进程与整个会话目录。** 同号清理（`stop(session_id)`）与「任务上限 8」淘汰都排在 `ensure_server().await` **之前**，而 Job 要等全部准备做完才入表。同一个 `session_id` 并发 start（预取与前台换集几乎同时发生）时：A 过了清理、在 await 上让出；B 也过清理（表里还没有 A）、也过了 await，随后 B 的 `insert` **覆盖** A 的 Job —— A 的 `JoinHandle` 被直接丢弃，既不会 abort 也不会被淘汰，那条 ffmpeg 进程与它整个会话目录双双泄漏（连续点选可堆到十几路）。
  - **修法**：清理与淘汰整体后移到 `ensure_server().await` 之后；`insert` 的返回值（被替换掉的旧 Job）就地 `task.abort()` + 删除旧目录。
- **从播放器进动漫 / 退出动漫可能留下不可见的出声源与「先跳一下」的观感。** 两处小修：① 动漫 `onError` DOM 回调漏了会话复查（本文件其它每个异步续体都有），换集时迟到的旧源错误会把新一集刷成错误页；② `AnimeVideoSurface.exitToDetail` 是 `void leaveFullscreen()` 后立刻 `close()` + 跳转，窗口还在往普通尺寸收、界面已经切页，改为串行 await。
- **三处「无主定时器 / 无守卫轮询」补齐清理。** ① `VideoSurface` 单击判定的 220ms 定时器只在「第二次点击」那条同步路径清理，离开播放器后仍会调 `togglePlay()`，让常驻 video 在发现页重新出声；② `MiniPlayer` 的 3 秒连播预取 `setTimeout` 无 handle 无清理，小窗销毁后仍发出 `prefetch_native`（触发一次约 7.4 秒的红果整集解析）；③ `PlaybackLogPanel` 的 1.5 秒轮询没有在途守卫，IPC 慢于间隔时两次 pull 会带同一游标并发、互相覆盖，表现为日志行凭空消失或重复。
- **动漫链路日志走 `println!` 是黑洞。** `dmghg_bridge::log_line` 与 `anime_provider` 的三行数据源探测都用 `println!`，而本进程是 `#![windows_subsystem = "windows"]`——没有控制台，输出直接丢弃。用户问「动漫区怎么老是暴风源」时日志里一行证据都没有。全部改走 `crate::trace::log`。
- **动漫播放器音量初值与「进入视图时刷新」的守卫。** ① `useAnimePlayerStore` 的 `volumeRef` 初值是 1 而 UI state 是 0.85，首次进动漫与画中画交接会真的用 100% 音量；② 动漫起播是裸 `await video.play()`、没有有界保底，违反不变量 21（短剧侧走 `playBounded`），表现为「点进去一直转圈、进度条不走」。`playBounded` 已导出复用。
- **收藏页 / 设置页的「进入时刷新」实际只跑了一次。** 两者都常驻 DOM、一生只挂载一次，依赖数组里没有 `currentView`，于是「进入收藏页重新拉取」「进入设置页刷新缓存占用」都只在启动那一刻执行过。补 `currentView` 守卫。
- **搜索结果页的关键词依赖让 40 张 memo 卡整体失效。** `handleCardClick` 的依赖数组含 `searchKeyword`，与它自己上方「依赖数组因此保持不变」的注释正好相反；关键词改走 ref。
- **「更新」文案与实现不符。** 设置页原文写「只会打开文件夹定位到安装包，不会自动安装」，而实现是下载完调 `installUpdate` 并让后端 `app.exit(0)`。按不变量 8（诚实报告边界）改为如实描述。

### 改进

- **发布前完成两路并行只读代码审查**（Rust 后端 + 前端），各产出一份带行号、触发条件、后果与最小修法的报告（本机工作区，未入库）。两份报告的一致结论：**架构纪律执行得干净**——常驻 DOM 无多余 key、三块 video 作用域、hls.js 生命周期、全屏唯一入口、类型安全零 `any`/`@ts-ignore`、全仓 138 处锁无跨 `await` 持锁、无 IPC 可达 panic、增强服务令牌 + 白名单三重收口且路径不可穿越、`kill_on_drop` 覆盖全部子进程。上面这批修复全部来自这两份报告。
- `short_drama_app` 的封面代理与 `hls_proxy` 的主机白名单标准此前不一致（前者校验初始 URL、后者只看 scheme），记入待办。
## 0.2.16 - 2026-10-07

### 修复

- **退出全屏不再「先缩小再放大」：把最大化从「向系统请求」改成「手动落位」。** 用户原话：
  「我点击退出全屏以后，它会先缩小，然后再放大，再回到原先的位置。」
  - **日志把动作拆成了三跳**（`ttv-playback.log`，同一次操作）：`2560x1537 → 2160x1380 → 2560x1528`。
    第一跳是 tao 撤掉全屏后的普通铺满态（与全屏几乎同尺寸，肉眼看不见）；第二跳 `2160x1380` 就是
    **系统最大化动画的中间帧**（那一下「缩小」）；第三跳是最大化后的客户区（「再放大」）。
  - **决定性证据**：同一次日志里 `[窗口] finish 收尾 前=2582x1550@(-11,-11) 后=2582x1550@(-11,-11)` ——
    **收尾前后矩形完全相同**，说明窗口不是被我们挪走的，是 `SetWindowPlacement(showCmd = SW_MAXIMIZE)`
    这一步让 Windows 自己播了一段「从当前尺寸撑到最大」的过渡动画：请求的目标状态与当前「普通窗口」状态不一致。
  - **修法**：`window_finish_fullscreen` 改为不向系统请求、直接手动落位 —— 先补上 `WS_MAXIMIZE` 样式 →
    `SetWindowPos` 落到目标矩形 → 写回暂存的原矩形 → 再幂等钉一次位置 → `IsZoomed(hwnd)` 校验。
    目标矩形取**当前窗口矩形**（本机实测 `2582x1550@(-11,-11)`，无边框窗口四边带阴影扩展，比 `rcMonitor` 准）。
    **`SetWindowPos` 不走 `WM_SYSCOMMAND`，因此不受系统「窗口最大化/最小化时动画」设置影响，没有中间帧**；
    写回还原矩形被挪到最后，此刻请求状态与当前一致，是幂等调用，也不会再播动画。
  - **为什么进全屏仍要先「原地解除最大化」**（0.2.15 已有的行为，本次未动）：不解除，tao 会把仍处于最大化
    状态的无边框窗口客户区裁到工作区之上。代价是窗口「常规位置」被临时覆盖成整屏矩形 —— 所以退出侧必须把
    暂存的原矩形写回，否则标题栏「向下还原」永远还原回整屏、放大缩小一个样。两端成对，见 AGENTS.md 不变量 5。
  - **配套打点**：`[ui] 全屏 进入开始 / 退出开始 / 退出完成 耗时=…ms`、`[窗口] prepare 前 / prepare 后`、
    `[窗口] finish 收尾 前=… 后=… 还原矩形=…`、`[窗口] finish 状态校验 showCmd=… 已最大化=…`，
    以及 `trace::log_window_size()` 的**尺寸变化节流打点**（与上一条完全相同则丢弃、同一 500ms 窗口内最多 12 条）
    —— 正是这条时间线把这个 bug 从「感觉有回弹」变成了三跳矩形。

### 改进

- **红果短剧首开不再干等整集：前缀先行开播，整集在后台补齐后无缝换源。** 上一轮的日志已经证明「首开很长时间」100% 发生在那一个 `resolve` await 里（实测 6.1–11.2 秒下整集），resolve 返回到首帧只有毫秒级。所以优化方向不是调参数，而是**别等整集**。
  - **两条链路并发**：前端在 `playNativeResolvedFile` 里先同步发出整集请求（`fullPromise`，不 await），再发前缀请求；Rust 侧两条命令的在途去重键不同（整集 `ns:quality:vid`，前缀 `ns:quality:vid:prefix`），因此互不阻塞、可同时跑两个 worker。谁先落盘谁先被用上，**绝不叠加延迟**。
  - **前缀为什么能直接播**：这条 CDN 是 faststart 布局，moov 在文件头部（实测 offset 28、约 250KB），所以 `Range: bytes=0-(N-1)` 截下来的前 2MB 解密后是一个**自洽可播的小片段**，不是残片。worker 侧新增 `download_prefix()` 与 `resolve-prefix` 子命令，产物 `{vid}.prefix.mp4`（指定档位是 `{vid}-{quality}.prefix.mp4`，`with_extension` 天然分开）。
  - **本机实测**（本机探针脚本，真实 CDN，vid=7691682207982685208）：签名 405ms → 播放模型 1127ms → 直链 1711ms → 前缀落盘 **4254ms**，TOTAL **4307ms** / 12,085,061 字节 / **13.67 秒**可播（h264 High 1920×1080 6939 kb/s + aac 128k）。对照同环境整集 6–11 秒，且整集此刻还在后台继续下。
  - **前缀规模刻意留在默认 2MB**（`TTV_SD_PREFIX_BYTES`，:1186）。同一集用 4MB 复测：落盘 5401ms、产物 30.13 秒 —— 多等 1.1 秒只换来 16 秒额外覆盖，而整集通常 6–11 秒就会把前缀替换掉，那 16 秒用不上。13.67 秒覆盖足够撑到换源完成。
  - **换源不黑屏、不弹错**：前缀切到整集走 `adoptPreparedSource`（不调 `load()`，旧帧一直保留到新源 `loadeddata`），切完按 `currentTime` 对齐续播。四条退让全部静默：前缀没来 / 前缀播不起来 / 切源失败 / 集已在盘上（后端直接回整集并置 `cached: true`，此时**不走前缀**）——一律回退到改造前的整集链路，用户看不到任何错误页。
  - **不破坏既有语义**：全程同一 `sessionId`、同一 `episodeId`，`markSourceCommitted` / `pauseIfStale` 原样复用，连播四重闸门不受影响；前缀路径**永不写进** `resolvedFileByVidRef`（否则下次换集会命中一个只剩开头十几秒的短命文件）；从 `startPosition > PREFIX_COVERAGE_SECONDS` 续播时主动跳过前缀（前缀几乎立刻播到头，反而会先触发一次 `ended`）。
  - **门禁**：`npx tsc --noEmit` = 0；`npm run build` = 0；`cargo fmt --check` = 0；`cargo clippy --all-targets -- -D warnings` = 0；`cargo test --bins` = **104 passed / 0 failed / 8 ignored**。

- **修「关掉 VSR 后进度条变成 `00:00 / 00:00` 且拖不动」——和 VSR 本身无关，是播放器宿主被连带重挂。** 这个 bug 一直在，只是路径不对没撞上。
  - **数据流**：进度条唯一数据源是 store 的 `position` / `duration`，两者只由 `handleTimeUpdate` 更新，而它绑在一段**依赖为空数组、只执行一次**的 effect 里（`usePlaybackStore.tsx`，注释明写「监听器只绑定一次」）。`ProgressBar` 侧则是 `duration <= 0` 时直接 `return`（拖拽入口）——所以 `duration` 一旦不再被写入，读数恒 `00:00`、拖拽恒无效，而画面照常播（播放走 `videoRef.current`，永远是当前元素）。
  - **根因**：`App.tsx` 的 `workspaceKey` 旧写法是 `currentView === 'detail' ? (selectedSeriesId ?? '') : ''`，而它挂在**最外层主工作区**上 —— 那一层内部就住着播放器宿主 `<VideoSurface/>`。于是「详情页（key=剧 id）→ 播放器（key=''）」这次跳转必然换 key，React 卸载重建整个工作区，产生一块**全新的 `<video>`**，而 store 里那份只绑一次的监听器仍挂在被丢弃的旧元素上。同一原因还会**静默带走**连播（`ended` 收不到）与「下载中」遮罩的收尾（`playing` 收不到）。
  - **修法**：key 只跟**剧**走，不跟视图走 —— `const workspaceKey = selectedSeriesId ?? ''`，并且把它从最外层主工作区**收进详情页那一层**（保留旧实现里唯一有价值的能力：换剧时详情页重挂拿干净状态）。导航栏所在的那层也不给 key。
  - **为什么用户是「关掉 VSR」之后才遇到**：这是**每次**从详情页点集数进播放器都会发生的路径问题；此前他多半从首页/历史直接进播放器（不经过 detail），key 一直是 `''`，不触发。关掉开关只是让他换了条进入路线。
  - **顺带补的两条打点**（否则下次同类问题又要靠猜）：`usePlaybackStore` 的监听器绑定处记「首帧-宿主 监听器已绑定 video」与「首帧-宿主 首次 timeupdate 距装载=…ms 时长=…s」（脱钩时第一行有、第二行永远不出现）；`useSettingsStore` 在 VSR 开关**值真正变化**那一刻记一行「VSR 开关切换为：开/关」——此前只有启动时那一行，用户中途拨开关在日志里完全看不见，无法区分「开关没生效」还是「生效了但链路不对」。
- **「开关 VSR 都没用」的真正根因：`-tls_verify 0` 写在 `-i` 之后，从来没生效过。** 这条与「首开很慢」是同一个根因的两副面孔 ——
  它的一个直接后果就是每次起播都先白等一轮必然失败的拉流。
  - **机制**：ffmpeg 的输入选项必须排在 `-i` **之前**，写在后面会被解析成**输出**侧的选项；而输出是 HLS 分片 / 本地文件，根本没有网络输出流，于是该选项被静默忽略，输入仍走默认证书校验。随包 ffmpeg 没有 CA 证书链，所以「打开输入」这一步必然失败。
  - **实测对照**（本机探针脚本，同一条真实 CDN 地址）：`-i <url> -tls_verify 0 …` → **RC=-5 / 115ms 失败**，stderr `[tls @ …] error:0A000086:lib(20)::reason(134)` + `Error opening input: I/O error`；改成 `-tls_verify 0 … -i <url>` → **RC=0 / 704ms / 产出 5,915,296 字节**。
  - **两处一起中招**：① 红果 worker 的 `_ffmpeg_direct_decrypt` 快速路径（ffmpeg 直连拉流 + 解密 + 转存一步到位）**从未真正生效**，每一集都退化成「python 完整下载整集写盘 → ffmpeg 读盘解密」的慢路径；② `media_enhance` 的增强转码从来没成功打开过源 —— 这才是「开关 VSR 都没用」在 guo / 公开直链场景下的真身。
  - **修法**：两处都把 `-tls_verify 0 -rw_timeout 60000000` 移到 `-i` 之前，注释里记下 115ms / 704ms 的对照。
  - **实测**（3 集 × VSR 开/关共 6 次，全部成功、不再出现「改用本地下载模式」）：4982ms / 35.9MB、4785ms / 38.6MB、6952ms / 64.6MB（对照修之前同样的一集要 7.5–8.5 秒，且日志里每次都先闪两次失败文案）。

- **VSR 开关贯通到红果 worker —— 这是「开关 VSR 都没用」在红果短剧下的完整解释。** 红果链路走 `short_drama_app_resolve` → worker 整集转存本地 mp4 → `asset://` 播放，**完全不经过 `media_enhance`**；而开关此前只作用于 `media_enhance`（guo / 公开直链），所以用户点红果短剧时怎么拨都没用。
  - `run_resolve_worker` 新增 `.env("TTV_SD_VSR", …)`；worker 侧新增 `vsr_enabled()`（缺省按开，与 Rust 侧 `AtomicBool` 初值一致）与 `should_copy_video(codec)`。
  - **两档语义**（回应用户要求的「开=保留 VSR、关=回到没有 RTX VSR 之前的播放链路」）：**关** = 回到引入 VSR 之前的链路，红果整集走 `-c copy` 重封装（历史实测 0.87s / 10.8MB；本机 WebView2 已开 `PlatformHEVCDecoderSupport`，H.265 源也照播），不再为一样用不上的 VSR 把整集重编成十几倍大的文件；**开** = 这条链路必须产出 H.264（不变量 25），源本来就是 H.264 就 copy，源不是 H.264 才重编码。两档共用同一条判定「输出必须是 H.264，且能 copy 就 copy」，区别只在源不是 H.264 时。`bytevc2` 永远重编码。
  - **配套**：`is_h264_codec` 改宽容判定。真实 codec 值并不干净 —— `variant_codec` 在 `video_meta.codec_type` 缺失时会把整串 `gear_des_key` 交上来（实测 `0:mp4|1:encrypt|2:h265_hvc1|4:1080p|…`），全等匹配一律判 False，会让源本来就是 H.264 的集白花一次整集重编码。现在先排除 `h265/hvc1/hevc/h266/bytevc2` 标记，再看是否含 `h264`/`avc`。
  - **NVENC 自适应**：新增 `video_encoder_args(ffmpeg)`，可用 `TTV_SD_ENCODER=nvenc|x264` 强制，否则真跑一次探测（`-f lavfi -i color=black:s=640x360 -frames:v 2 -an … -f null -`，timeout 25s），失败则记一行日志回落 CPU。**探测尺寸必须 640x360** —— 用 64x64 时 nvenc/amf/qsv 全部报错（`Frame Dimension less than the minimum supported value`），是纯粹的假阴性。
  - **实测**：NVENC 在整集路径上**没有净收益**（7132ms vs libx264 6302ms），但产物更小（35.9MB vs 91.4MB）。保留自适应是为源非 H.264 时的重编段。

- **播放链路前端插桩落地**（诊断日志此前只有后端在写，前端一次都没调用过）：
  - 新增 `src/services/playbackTrace.ts`：`tracePlayback()` 是零依赖、fire-and-forget 的打点（`hlsAttach.ts` 刻意不依赖 ipc 层，不能为了打点把 ipc 的依赖图拖进去）；`redactUrl()` 在**前端**做脱敏 —— 红果分集直链的 query 是预签名凭据，日志会被用户导出发出来，不能把可用凭证抄进去；`urlShape()` 是「这一集走哪条路」的唯一判据（本地文件 / VSR转码HLS / HLS / 网络直链）。
  - 打点位置：`hlsAttach.attachSource`（形态 + 脱敏地址 + 耗时）、hls.js 的 `ERROR`（带 `type`/`details`/`fatal`，用于区分「清单还没落地时的分片 404」与真正的解码失败）、`resolveNative`（这唯一出口覆盖了播放器 / 画中画 / 预取三条调用点，耗时 + 字节 + 是否缓存命中）、`VideoSurface` 的 `loadstart`/`loadeddata`/`canplay`/`playing`/`waiting`/`stalled`。
  - **开发环境实测日志**（`ttv-playback.log`，本轮第一次看到完整链路）：`[ui] resolve 请求开始 vid=… 档位=auto` → `[红果] worker 阶段 … stage=download … 编码=0:mp4|1:encrypt|2:h265_hvc1|…，整集重编码为 H.264（VSR 需要）` → `[红果] resolve 完成 耗时=7156ms 字节=26453365` → `[ui] resolve 返回 耗时=7165ms 字节=25.2MB 缓存=false` → `[ui] 媒体 loadstart 开始加载` → `[ui] 媒体 loadeddata 首帧就绪 readyState=4` → `[ui] 媒体 canplay` → `[ui] 媒体 playing`。
  - **顺带证实两点**：① 红果整集确实每次都走「整集重编码为 H.264（VSR 需要）」，源是 HEVC；② `resolve` 返回后到首帧就绪只用了**毫秒级**（本地文件），也就是说红果的「首开很长时间」**全部**发生在 `resolve` 那一个 await 里 —— 6.1–11.2 秒。优化目标因此非常明确。
- **新增播放链路诊断日志（用户可见）**：用户反馈「开关 VSR 都没用」「视频首次加载都很长时间」，但双击启动时（`#![windows_subsystem = "windows"]`）Rust 侧 18 处 `eprintln!` 与 ffmpeg 的输出全是黑洞，只能靠猜。新增 `src-tauri/src/trace.rs`：
  - **进程内环形缓冲 + 落盘双写**：`MAX_LINES = 2000` 的 `VecDeque`（供设置页面板增量读取，游标按单调递增的 `SEQ` 过滤，`clear` 后不重置，否则前端持有的游标会永远大于最大值而收不到新行）＋ `<data>/ttv-playback.log` 每行 flush（便于强杀后仍能拿到最后几行）。行格式 `[+   1.234s #12]`，时间是相对进程启动的偏移。
  - **stderr 捕获**：`CreatePipe`（1MB 缓冲，防 ffmpeg 写端堵塞）＋ `SetStdHandle(STD_ERROR_HANDLE, …)`，起线程逐行收进同一条时间线（`[stderr]` 前缀）。必须在 ffmpeg/worker 被拉起**之前**调用。
  - **URL 脱敏**：`redact_url()` 只保留 `scheme://host[:port]/path`，砍掉 query（源流地址的 query 是预签名凭据，整条进日志等于把凭据抄进磁盘与设置页）。
  - **启动横幅**记录版本、可执行文件路径与 **mtime**（直接回答"用户跑的是哪一版"，这次正是靠它确认用户启动的是 10/5 的安装版）、VSR 开关当前值、缓存目录、WebView2 启动参数。
  - 三个 Tauri 命令 `trace_ui_log` / `trace_tail` / `trace_clear`；设置页「客户端信息与诊断」卡片（与已有的导出按钮同一处）下新增可折叠的播放器诊断日志面板：1500ms 游标增量轮询、DOM 最多保留 800 行、`[vsr]`/`[ui]`/失败行分色、手动上滚即暂停自动滚底、复制全部 / 导出 txt / 清空。折叠状态下不产生任何 IPC 流量。
  - 插桩点覆盖全链路：`media_enhance`（start / 就绪判定 / 令牌无效 / 下发清单 / 分片未就绪 / 转码进程退出）、`main.rs` 的 VSR 开关分支、红果 `resolve` 与 `run_resolve_worker`（启动 / 阶段变化 / stderr 首行 / 超时 / 失败 / 完成，含耗时与字节数）。
  - **踩过的坑**：`cargo test` 会真的跑通 logger，把 2000 行「填充 N」写进用户真实目录下的 `ttv-playback.log`，把排障现场冲掉 —— 已用 `if cfg!(test) { return None; }` 拦住。

- **修掉「首次打开视频一直加载等待」的真实根因：fMP4 的 `init.mp4` 从来没有落在会话目录里。** 这条不是参数调优问题，是产物压根不在该在的地方：
  - **机制**：ffmpeg 写 fMP4 的 init 段用的是**相对文件名**，而 `-hls_segment_filename` 我们传的是**绝对路径**。于是只有分片落对了地方，`init.mp4` 悄悄掉进**父进程的当前工作目录**（会直接掉在工程根目录/桌面）。四组对照实测：不传 init 名 + cwd=工程根 → 会话目录内无 init；传相对名 `init.mp4` + cwd=根 → 会话目录内**仍然没有**；**cwd=会话目录 → 会话目录内有 init.mp4 ✅**；传绝对路径 → ffmpeg 直接失败 `Failed to open segment '<abs>/init.mp4'`。
  - **两处后果正好对应用户的两条反馈**：① `ready()` 要求 `index.m3u8` 与 `init.mp4` 同时存在 → **恒为 false** → `start()` 每次都会死等满 `READY_WAIT` 才把地址交出去，这正是"首次打开一直在加载"里后端按住的那一段；② 就算把地址交出去，播放列表里 `#EXT-X-MAP:URI="init.mp4"` 的请求必然 404（本地服务去会话目录找它），hls.js 只能反复重试首片，用户看到的就是"一直转圈"。
  - **修法**：`Command::current_dir(&directory)`，即「相对文件名 + cwd 钉在会话目录」——四组实验里唯一稳的组合。注释里写明了为什么不能传绝对路径，以及为什么不再需要 `-hls_fmp4_init_filename`。
  - **顺带**：转码进程退出时的 stderr 原来只 `eprintln!`（双击启动时是黑洞），改走日志通道并带上会话号、退出状态与前 300 字符。

- **RTX VSR 增强链路「首次打开要等很久」：把串行的等待改成并行，并让提示跟着画面走**。用户反馈「初次打开视频时都会加载很长时间，一直在加载等待」。拆开看是三件独立的事：
  - **① 转码进程先空等下载 5MB 才肯出第一帧。** media_enhance::start() 拉起 ffmpeg 时用的是默认输入探测参数（probesize=5,000,000 / analyzeduration=5,000,000），它会尽量读满 5MB / 5 秒的源数据才判定「这是什么流、第一帧从哪开始」。对网络输入这就是纯白等。**修法**：显式传 -probesize 1000000 -analyzeduration 2000000（必须是 -i **之前**的输入选项）。本链路处理的只是「一条 H.264/HEVC 视频 + 一条 AAC 音频」这类最普通的 mp4/HLS，1MB / 2 秒足够；探测不足时 ffmpeg 只会退化成边播边补，不会失败。
  - **② 后端死等首段与前端重试是两段串行等待，用户按两者之和买单。** 原来 start() 要按住最多 **4 秒**等 index.m3u8 + init.mp4 双落地才返回地址。但前端 hlsAttach.ts 早就补了 manifestLoadingMaxRetry: 4 / levelLoadingMaxRetry: 4 / fragLoadingMaxRetry: 8 / fragLoadingRetryDelay: 500 —— 这套重试本来就是为边转边播准备的。**修法**：新增常量 READY_WAIT = Duration::from_millis(1500)，把等待上限压到 1.5 秒（覆盖本地片实测 0.55s、真实源常见的 2–4s 首段就绪里的大部分）。没等到也照旧交地址，剩下的交给播放器自己重试，总耗时从「后端 + 前端」变成两者的较大值。
  - **③ 画面都开始播了，进度提示还挂在屏幕上等一个后台任务。** 解析进度来自 worker 的 shortdrama://app-resolve 事件，而 worker 是在**下载整集**的过程中上报的。现在链路是「worker 一边下载、播放器一边播」（增强转码流尤其如此：第一段分片落地就能出画，此后 worker 还在为后续分片继续拉源），于是那条「云端解析中」会一直挂到整集下完 —— 用户看到的正是「视频都开始播了，还在转圈等我」，而它等的其实是一件**已经不影响当前播放**的后台任务。**修法**：在 usePlaybackStore.tsx 的 video 监听里加一条 playing 处理 clearResolveOverlay，用 currentTime > 0 判定（不能只看 playing：缓冲挖坑后恢复播放也会触发，那时提示还有意义），首帧真出来才收掉提示。
- **设置页新增「RTX VSR 视频增强」开关（播放体验）**。默认**开**（与现状一致，老用户行为不变）。两档语义完全对称：
  - **开** = 保留引入 media_enhance 之后的增强链路：guo 与公开 http(s) 直链先转成本地 H.264 HLS 再播（本机 WebView2 上 VSR 只认 H.264，见不变量 25），红果缓存迁移同理。
  - **关** = 完全回到**未引入 RTX VSR 之前**的旧播放链路：原始源 URL 直接播，不启动任何转码进程，也不再把旧缓存整集重编成 H.264。判定位置（Rust src-tauri/src/main.rs）：enhance_short_drama_session() 里 `if !vsr_enabled() { return session; }` 必须排在 media_enhance::needs_enhancement() **之前** —— 后者只按 URL 形态决定「能不能转」，与用户开不开增强无关。
  - **开关落在配置里而不是内存里**：models.rs 的 UserSettings.vsr_enabled（#[serde(default = "default_true")]，旧记录缺失时补 true）；settings_save 写库的同时调 set_vsr_enabled()，因此**改完立刻生效、无需重启**；setup 按落库值初始化。运行期用进程级 `AtomicBool`（OnceLock）而不是 AppState 字段：enhance_short_drama_session 是自由函数，改成收 &AppState 会把状态锁拖进起播热路径；AtomicBool 单字读、无锁、不跨 await。
  - **顺带修掉一处「关掉开关也没用」的漏网**：旧缓存的 H.264 迁移（ensure_h264_cache）原本无条件跑，而它是在**起播路径上同步执行的整集重编码**（1920×1080 实测几秒到十几秒）。关掉开关后这笔成本换不到任何东西（产物就是 HEVC，VSR 也认不了），现在直接写标记跳过，产物保持 HEVC 直连播放。
  - **门禁**：cargo fmt --check = 0；cargo clippy --all-targets -- -D warnings = 0；cargo test --bins = 101 passed / 0 failed / 8 ignored（含 models::vsr_settings_tests 三例：旧记录补 true、显式关掉后必须真关、默认 true）。真机 VSR 触发**未实测**（需要真实 HDR/CDN 源 + NVIDIA 驱动侧日志）。
  - **门禁**：npx tsc --noEmit = 0；npm run build = 0（5.19s）；cargo fmt --check = 0；cargo clippy --all-targets -- -D warnings = 0；cargo test --bins = **101 passed / 0 failed / 8 ignored**。转码侧的①②两项**尚未真机实测**（需要真实 CDN 源），数值取自本机历史实测与 ffmpeg 参数语义。

- **切页面与进出播放器不再卡顿：三条实测根因一起修掉**。用户反馈「切换页面、进入退出播放器容易卡顿」。逐个量下来不是同一件事，而是三条叠在一起：
  - **① context 按引用广播，播放进度每秒把整棵树刷 4 遍。** `PlaybackContext` 的 value 是内联对象，而 store 里的 `position` 每次 `timeupdate` 都变（约 4 次/秒）、`buffered` 每次 `progress` 都变。只要组件订阅了整表，它的重渲染频率就等于播放进度更新频率 —— 而 `AppContent` 是**所有视图的父节点**、`ExploreView` 下面有上百张 `SeriesCard`，连历史、详情、选集抽屉都跟着刷。**修法**：新增一条低频动作专线 `PlaybackActionsContext`（`usePlaybackActions()`），只装换剧/换集/开关抽屉/音量档位这类**用户操作**才会变的东西；`usePlaybackStore()` 保留给真正需要实时读数的播放器自身（`VideoSurface` / `PlayerControls`）。方法一律经 `actionsRef` 转发到最新实现，所以既不用把每次渲染新建的函数列进依赖，也没有过期闭包。顺带把 `playbackValue` 从「假装有 memo」改成普通对象 —— 它里面 12 个动作函数本来每次渲染都是新引用，列依赖等于没 memo，写清楚比留下误导好。`usePlaybackSelector` 保留，但注释里写明它**只省解构、不省重渲染**（`useContext` 照样订阅整表）。
  - **② 每切一次页面，整棵视图树被销毁重建一次。** `App.tsx` 里 8 个视图层写的是 `key={currentView === 'x' ? 'view-x' : undefined}`：只有当前激活的那层拿到字符串 key，其余都是 `undefined`。切页时新旧两层的 key **同时**变化（字符串 ↔ undefined），React 的判定是「key 变了就重挂」——于是卡片列表、封面用的 `IntersectionObserver`、分页游标全部重来，主线程被占满。这与「视图常驻 DOM」的初衷正好相反。**修法**：视图层不再挂 key；重挂只保留唯一真正需要的那一处 —— **换剧**（`workspaceKey = currentView === 'detail' ? selectedSeriesId : ''`，挂在工作区容器上），也就是旧 `view-detail-${selectedSeriesId}` 里唯一有价值的部分。「更多」页原本也靠 currentView 强制重挂，同样去掉（它自己已有 `shelfView` 复位逻辑；`channel === 'adult'` 那层的 `CatalogProvider key` 是有意保留的）。
  - **③ 页面入场动画把恒等值永久钉在 8 个常驻层上。** `animate-fluent-page-in` 的关键帧含 `opacity: 0→1` 且带 `forwards` —— 跑完后 `opacity: 1` 会永久留在那 8 个视图层的内联样式里，等于常驻合成层（本项目已因同类残留让 NVIDIA VSR 失效过一次，见不变量 26）。更糟的是隐藏层：元素在 `display: none` 的祖先里创建时 Chromium 会把动画卡在 0% 帧，而 0% 的 `opacity: 0` 会被当真。**修法**：`fluentPageIn` 只保留 `translateY(8px) → 0`，与 `fluent-card-in` 当年得出的结论（入场动画不碰 opacity）对齐，观感几乎不变。
  - **实测/门禁**：`npx tsc --noEmit` = 0；`npm run build` = 0（13.85s，`dist/assets/index-*.js` 500.39 kB / gzip 146.73 kB）；`cargo fmt --check` = 0；`cargo clippy --all-targets -- -D warnings` = 0；`cargo test --bins` = **101 passed / 0 failed / 8 ignored**。

- **首页的「正在热播 / 新剧」改用各自「更多」页同一份数据源**（红果榜单 / 最新上架），不再从发现页目录里切一段。原来货架是 `items[0..6]` / `items[6..12]`，而「更多」页走的是红果 App 接口 —— 点进去看到的是**完全另一批剧**，两处对不上。
  - **共享一份取数**：新增 `src/stores/useShelfFeed.ts`，把游标翻页与**首页首屏缓存**（TTL 3 分钟）收口在这里。首页货架与「更多」页读同一个 hook：货架拉到的第一页就是「更多」页的首屏，所以**从货架点进「更多」是秒开的**（不会再等一次 Python 冷启动），「更多」页还能接着那页的游标继续翻。
  - **新增 `HomeShelfSection`**：货架位自己的取数 + 渲染。调用方必须传 `key={`${kind}-${channel}`}` —— `useShelfFeed` 的状态只在挂载时初始化，换频道不重挂会有一帧显示上一频道的内容。
  - **`HomeShelf` 新增 `loading`**：数据没到就先画 6 张骨架卡把高度占住，否则货架会"先消失再出现"，整页跟着跳一下。`onUnavailable` 同时改成可选 —— 货架卡来自 App 接口、不在发现页目录里，`hiddenSeriesIds` 那套除名机制管不到它们。
  - **18+（神秘小窝）保持原样**：红果 App 接口没有 18+ 口径（那是本机侧"只启用成人源"的聚合概念），该频道继续用本机启用源聚合出来的目录切片。`ExploreView` 因此分成两条分支，`shelfFeedSupports(channel)` 是唯一判据。
  - **顺带修掉一个"吞剧"的老逻辑**：发现页的「发现更多」网格原来会**让出前 12 条**（`catalogStart = 12`），只因为那 12 条"已经出现在货架上"。货架换成独立数据源后两者再无关系，继续让位等于凭白吞掉 12 部剧 —— 现在目录网格从第 1 条开始。
  - **代价（已知）**：进发现页会多发两个分区请求，`worker.py` 每次冷启动约 1.8s，两个并发跑、期间货架显示骨架；3 分钟 TTL 内不会重复。

- **「更多」页接上真正的分区数据源**：走红果 App-API 的**榜单**与**最新上架**，而不是上一版那套「本机启用源聚合 + sort」（后端基本不实现 sort，两页会拿到同一份列表）。接口与参数完全照**私有渠道**调研结论。
  - **官方本来就是两条接口**：热播 = 榜单 `GET /reading/bookapi/bookmall/cell/change/v`（`sub_selected_items=comic_series_hot_play`，游标 `session_uuid + next_offset`）；新剧 = 上架 `POST /reading/distribution/category/landpage/v`（`select_items.sort=["online_time"]`，游标 `offset += 本页条数`）。**短剧没有 cell 榜**，所以短剧的"热播"用上架接口的 `sort=hot_score` 近似 —— 这与官方自己一致。
  - **worker 新增 `feed` 子命令**（`worker.py`）：`feed <json>`，`mode=rank|list` 两种模式，输出沿用既有的逐行 JSON 协议。两条接口的分页模型不同，统一收敛成**不透明游标** `{"o":<offset>,"s":"<session_uuid>"}` 交给调用方原样回传。脏数据（HTML 标签、`今日上新`/`x万热度`/`N集`/季数这些噪声副标题）在 worker 侧清掉，Rust 只做字段搬运。
  - **worker 不需要"免签"分支**：官方客户端对这两条接口默认不发签名（注释称实测红果不校验 X-Argus），TTV 仍走既有的六代签名 —— 签名是更严的一侧，不会因此被拒，也就不必再分一条代码路径。
  - **Rust 新增 `short_drama_app_shelf_feed(kind, channel, cursor)`**，并在 `short_drama_app.rs` 里落了一张「分区 × 频道 → 接口参数」表（`shelf_feed_spec`）。评分源给的是字符串（`"9.4"`），解析不了就当"源没给"，**绝不填 0**（不变量 8）。
  - **前端**：新增 `ipcService.shelf.feed()`（游标式，`cursor` 原样回传）；「更多」页改成自持状态 + 游标翻页 + 按 id 去重（游标翻页可能回吐重复条目，一页全是重复即视为到底）。
  - **神秘小窝是唯一例外**：红果 App 的榜单/上架**没有 18+ 口径**，拿它填神秘小窝等于把普通短剧塞进 18+ 专区，直接违反门闩不变量。该频道继续走本机启用源的多源聚合，页面版式与另一条完全一致，只有取数链路不同。
  - **实测（直接跑 worker，2026-10-07）**：用**自造的、格式正确的设备身份**（19 位 deviceId/installId + uuid cdid + 16 位 openudid，不含任何账号凭据）打真接口，四条路径全部通：漫剧热播榜 10 条/页、短剧热播 18 条/页、短剧最新上架 18 条/页、漫剧最新上架 18 条/页，都拿到真实条目（id/标题/封面/集数/评分/题材）。**游标翻页也对**：榜单第二页 10 条与第一页零重叠，`session_uuid` 原样贯穿、`next_offset` 10 → 20。这同时坐实了**私有渠道**调研里那条关键结论 —— **列表类接口确实不校验账号**（官方注释称的"免签"），游客态就能拿到数据。
  - **顺带修掉一个吞错误的真 bug**：Tauri 的 `invoke` 被后端 `Err(String)` 拒绝时抛的是**原字符串**、不是 `Error`，所以 `(err as Error).message` 恒为 `undefined` —— 后端拼出来的错误详情会被静默换成一句通用兜底。新增 `errorText()`（`services/ipc.ts`）统一收口，并换掉 `ShelfMoreView` 与 `useCatalogStore` 里的两处旧写法。这个 bug 正是「更多」页明明报错却只显示"列表加载失败"、看不到真原因的原因。
  - **注意**：Rust 侧新增了 Tauri 命令，**必须重启 `npm run tauri dev`**（前端 HMR 不会带来新命令，旧进程里 `invoke` 只会得到 command not found）。

- **首页两颗货架的「刷新」换成「更多」，卡片上的 1/2/3 序号一并移除**，新增一个独立的「更多」页。
  - **移除**：`HomeShelf` 的刷新按钮（`onRefresh` / `refreshing` 两个 prop 与 `RefreshCw`）、`ExploreView` 里整套 `refreshingShelf` / `refreshTokenRef` / 失败 toast、`SeriesCard` 的 `rank` prop 与其金/银/铜三档配色。**序号被移除的连带后果**：上一轮做的"手动强制刷新"（`refreshCatalog(kw, { force: true })` → `catalog_list` 的 `force` → `guo_provider::catalog_refresh` 穿透 15min 缓存）**不再有调用方**，guo 源目录从此只能等 TTL 自然过期。force 链路本身保留在 store / IPC / Rust 三层，随时可以挂到别处。
  - **新增「更多」页**（`src/components/views/ShelfMoreView.tsx`）：版式与「我的追剧 / 观看历史」完全同构 —— 同一个页面壳（`p-8 / max-w-5xl / mx-auto / gap-6`）、同一个页头（图标 + 标题 + 副标题 + 底边框）、同一套 `MicaCard` 行卡（64×88 封面 + 标题 + 题材/来源 + 集数/评分 + 右侧动作）。带无限流、骨架屏、空态与失败重试。
  - **跳转**：`useAppStore` 新增 `AppView = 'shelf'`、`ShelfViewState { kind, channel }` 与 `openShelf(kind, channel)`；`App.tsx` 按既有约定挂一个常驻 DOM 视图。频道必须在点击那一刻由发现页交出 —— 「更多」页内部挂的是**另一份** `CatalogProvider`，读不到发现页的频道状态。
  - **数据源**：`CatalogProvider` 新增可选 `initialChannel` / `initialSort`，「更多」页用一份**独立实例**把排序钉死（正在热播→`heat`，新剧→`latest`），两边的分页 / 缓存 / 预取 / 题材词表互不干扰，也不会串改发现页的排序。**注意**：后端目前基本不实现 `sort`（见**私有渠道**调研结论），所以两页今天拿到的很可能是同一份列表；真正的分区数据源要接红果 App 的榜单 / 最新上架接口。
  - **顺手修掉两个 Tailwind 死类**（都是"写了但从来没被生成过"）：
    - `h-22`（「我的追剧」「观看历史」的封面缩略图）不在 spacing 刻度里，父级高度塌成 auto，而占位层是 `absolute inset-0` —— 封面加载失败时整块缩略图会消失。改用 `h-[88px]`（3:4 = 64×88）。
    - `group-hover:scale-108` 不在 scale 刻度里（0/50/75/90/95/100/105/110/125/150），**封面悬停其实一直不放大**。改用任意值 `group-hover:scale-[1.08]`。这条影响全部 `SeriesCard`（目录 / 动漫 / 搜索 / 货架）。
  - 两个类名的存在性都拿 dev server 的编译产物核对过（`/src/index.css`），不是靠读代码推断。

- **新增启动进入动画「轨道汇聚」**：六张迷你海报绕品牌图标公转 1.1 圈（角速度按 `1-(1-u)^1.75` 由快到慢，公转期间每张卡各自"呼吸"与轻微摇头），随后按 58ms 错峰依次被吸进中心，品牌承接撞击并做**衰减余振**，再淡出让位给主界面。总长 2300ms，点任意处（或 Esc / 空格 / 回车）可跳过。设计稿与另外 9 套备选方案属于维护者本地材料，动效落在 `src/components/layout/LaunchAnimation.tsx` + `src/styles/launch.css`。
  - **为什么动画写在 JS 里而不是 CSS**：椭圆轨道要 72 段采样（关键帧之间是直线插值，"弦"相对椭圆内凹——采样太疏时卡片会肉眼可见地切进导轨线里；半径上还叠了一层"呼吸"，一圈两个周期，采样疏了会被采成折线），六张卡各 70 多帧、每帧带 transform / opacity / filter / z-index 四个属性，写成 CSS keyframes 是几百条规则，改一个参数要动四处。
  - **⚠️ 同一个元素只允许有一条 `animate()`，多个阶段必须合并成一条关键帧轨。** 这条是实测踩出来的：最初把"公转"和"螺旋吸入"写成两条动画，结果**公转完全没在跑**——后创建的那条带 `fill: 'both'`，它在自己的**延迟期间**就会应用 0% 帧，把公转段整个盖住，六张卡从第一帧就钉死在轨道终点、只有透明度在变。肉眼看上去"绕了一圈"其实一张没动。合并后错峰不能再靠 `delay`（那会把公转相位一起推后、60° 间隔就散了），改成把错峰做进 **offset 空间**：每张卡总时长不同、但同一起跑，于是公转同时收工、再各自等自己的窗口起飞。
  - **景深是三层一起做的**：只做 `scale`（0.66→1.09）的话卡片永远从品牌"上面"压过去，前后关系是假的；连同 `blur`（0→1.05px）与 `z-index`（后 1 / 品牌 2 / 前 3）一起做，翻面点选在 `y = 0`——那正好是卡片离品牌最远（x = ±300）的瞬间，所以这次离散跳变看不出来。
  - **品牌的"回弹"必须是挤压拉伸 + 过冲 + 衰减余振，不是"均匀放大"。** 先前的 `scale(1)→scale(1.114)→scale(.972)→scale(1)` 只产生"变大"，没有任何受力感。现在是 X 与 Y **反向**的一条弹簧轨（体积守恒的错觉）：主撞 `1.135×.895`，之后按 0.082 / 0.054 / 0.038 / 0.019 衰减 4 次，同时 ±2° 旋转摆动。实测 1181ms `1.040×0.973` → 1286ms `1.124×0.903` → 1339ms `0.943×1.059` → 1660ms 精确回到 `1.000×1.000`，与设计关键帧逐点吻合。
  - 配套：公转期间导轨自己脉动两次、收束前先向外"蓄力"一下再猛收；三圈冲击波分别打在第一次 / 第三次 / 末次撞击上（只打末次的话前五次撞击全是"哑"的）；光晕改成脉冲式涨落而不是"慢慢变亮"。
  - **时间线拆成两段，中间那一段是"等首页"**：`buildPhaseA`（公转 / 汇聚 / 弹簧，1700ms）跑完时所有东西都静止在"品牌 + 光晕"上，正好是一个可以挂起等待的姿态；`buildPhaseB`（让位给主界面，600ms）单独建、单独起。首页目录本来就在 `CatalogProvider` 挂载那一刻开始拉、和甲段同时起跑，但真实网络下不保证 1700ms 内回来 —— 所以甲段跑完时看 `isLoading`：就绪就立刻揭幕，没就绪就挂起（光晕开始呼吸、提示换成「正在准备首页内容…」，**必须有东西在动，否则挂起和卡死长得一模一样**），最多再等 1500ms。**超时也照常揭幕**：骨架屏是诚实的，卡在启动画面上不是。实测：内容就绪时 +1957ms 动画层还未撤、主内容区已有 `img=9` / 350 字（用户看到的是已填好的首页）；目录永不返回时 +1956ms 进入挂起、+4066ms 兜底揭幕，无残留循环动画。就绪信号用 ref 承接、**不进 effect 依赖**，否则整条时间线会重启。
  - **启动音效与入场底噪，零音频文件**：全部在 `src/services/launchAudio.ts` 里用 Web Audio 现场合成 —— 六张卡的弹入是极轻的"哒"（音高随机微偏 ±5%，避免六下听成机器），汇聚段是一条 560ms 的带通噪声吸气 + 一条 110→220Hz 的爬升正弦，**六次撞击走 A 小调五声音阶上行**（A3 C4 D4 E4 G4 A4，带八度泛音，前两下和最后一下叠一层低频"落地感"），末次落在 A4 并叠成 A4/C5/E5 的挂留和弦，揭幕时补一声收束"咻"；底下铺一条 A3/C4/E4/F#4 的轻微失谐 pad（起音 600ms 缓坡、声音同调所以不打架）。**cue 的时刻表和动画共用同一组常量**，改动画必须两边一起改。离屏量化验证：整体峰值 0.207（未削顶）、六次撞击 RMS 逐次上行 0.034→0.073（明确盖过 0.018 的底噪）、3.2 秒后完全静音。
  - **自动播放策略**：Chromium 在无手势时会把 `AudioContext` 置为 `suspended`，桌面端靠 `tauri.conf.json` 的 `additionalBrowserArgs` 里加 `--autoplay-policy=no-user-gesture-required` 放行（⚠️ 该字段会覆盖 wry 的默认参数，所以默认那串 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection` 已原样带上）。万一仍被拦（如开发期浏览器）**静默降级成无声**——丢启动音是小事，让启动动画报错或卡住是大事。设置项 `launchSound` 走 `UserSettings`（Rust 侧 `#[serde(default = "default_true")]`），设置页"播放体验"里可关；它异步读回来，所以前端按 `!== false` 判定并在落地为关时立刻掐掉（有意的约 100ms 窗口）。收尾 `dispose()` 释放 `AudioContext`，否则 Windows"音量合成器"里会挂常驻条目。
  - **一律 `element.animate` + `fill: 'both'` + 跑完 `cancel()`，不用 `fill: 'forwards'`**：forwards 会把 `transform: matrix(1,0,0,1,0,0)` / `filter: brightness(1)` 这类恒等值永久钉在 `TitleBar` / `NavigationRail` / `<main>` 上，等于常驻合成层（本项目已因同类问题让 NVIDIA VSR 失效过一次）。实测收尾后三个壳层元素 `getAnimations() = 0`、内联 transform/opacity 均无残留。
  - **壳层动画的目标只有 `data-launch-part="titlebar" | "rail" | "content"` 三个**，它们都不是 `<video>` 的祖先；再往外一层就已经是播放器宿主 div 的祖先了。
  - **跳过路径的收尾定时器与时间线定时器必须分开存**（`exitTimerRef` / `timelineTimersRef`）。踩过一次：共用一个数组时 React StrictMode 的「effect → cleanup → effect」会把跳过时刚挂上的收尾闹钟一起清掉，表现是"点了跳过、面板已透明，但它还挂在那儿挡点击"；`skip()` 另需先打 `skippedRef` 标记，效果再跑一次时直接收工（首帧就点击跳过的场景）。收尾用 `animation.finished` + 定时器双保险，因为后台标签页里 rAF 会停。
  - **三处底衬是同一条渐变**（`.ttv-launch` / `html,body` / `.mica-backdrop`），分别负责动画期间、React 挂载前的那几百毫秒、撤层之后；`html,body` 原来是平色 `#f3f5f8`，冷启动会先给一块平色再跳到渐变，现在统一。窗口缩放：`--launch-k` 在 1080×720 / 1440×920 / 1920×1080 下分别为 0.850 / 1.070 / 1.180，卡片最远卡心距窗口中心 231 / 291 / 321px，均在窗口内。`prefers-reduced-motion: reduce` 时整个动画层不出现。
- **首页按主流桌面播放器重排为内容货架**：首屏依次呈现「正在热播 / 新剧 / 猜你喜欢 / 发现更多」，两个内容货架各自带刷新按钮并防止重复点击；目录数据不足时仍展示已加载的小货架，底部无限流、逐源分页与预取机制保持不变。
- **“随机看”改为与普通货架同构的紧凑推荐行**：第一版的大面积详情面板在真实目录下会把页面割成两截，且候选不足时还留下半排缩略图；现在只保留随机切换、封面、标题、简介、热度、评分、真实集数与“立即观看”，不再引入额外卡片容器。
- **题材栏不再把全部分类铺满页面**：短剧/漫剧与动漫专区默认各展示 8 个不换行分类，其余进入「更多」展开；窄窗口改为横向滚动，切频道/题材/排序后自动回到页首，避免新结果出现但筛选栏还停在旧滚动位置。
- **切换专区与筛选时给出明确加载反馈**：目录请求期间显示顶部细进度条并轻微压暗旧结果、禁止点进已经不属于当前筛选的卡片；内存缓存命中时仍立即显示旧内容，再由后台请求一次性替换，兼顾“不闪白”和“不误以为点击无效”。
- **卡片悬停/聚焦时预取详情**：`ipcService.series.getDetail` 增加在途去重与会话内缓存，点击卡片优先命中已缓存详情；只预取详情，不预取视频媒体，封面懒加载与 `SeriesCard` 的稳定回调保持不变。
- **剧集缓存改为用户上限自动清理**：默认仍为全局 1GB，但设置页新增 512MB / 1GB / 2GB / 4GB 上限；旧设置里的 `playbackCacheMb=0` 是 0.2.x 的“不做字节统计”哨兵，迁移时解释成 1GB 而不是永久清空。Rust 侧用运行期 Atomic 预算立即生效，仍保留 7 天过期、LRU、正在写入半成品与当前集豁免。
- **首页两颗货架刷新按钮的转圈改为只跟着被点的那一颗**（用户报告：“点击刷新按钮后另一个刷新的跟着转了”）。两栏（正在热播 / 新剧）的数据本来就是**同一份首页目录的前后两段切片**，刷新动作只有一次 `refreshCatalog('')`——一次刷新两栏都会换掉；但把 `isLoading` 直接当两栏的转圈开关时，“点的是这一颗”这件事在界面上就丢了。现在 `refreshingShelf` 只描述反馈来自哪一栏（不代表数据范围），转圈由这次刷新自己的 Promise 结束来收，带 token 防串台——连着点两栏时，先回来的那次请求不会把后一次刚点亮的转圈抹掉。
  - 实测（Chromium + mock 目录，10ms 采样按钮的 `title` / `svg.animate-spin` / `disabled`）：点击瞬间 `正在刷新|spin=true|disabled=true`，128ms（mock 请求耗时）后自行恢复 `刷新正在热播|spin=false|disabled=false`。两栏同时出现的画面在 mock 数据下渲染不出来（新剧栏要求可见条目 ≥10），这部分由代码结构保证：两栏分别读 `refreshingShelf === 'hot'` / `'new'`，不再引用共享的 `isLoading`。


- **首页「正在热播 / 新剧」的卡片重做为榜单样式**（用户反馈："排名没有榜单感 / 封面角标互相挤 / 和目录卡没区别，缺精选感"）。三条都只作用在**货架卡**上，目录网格、搜索页、动漫专区三处的卡片形态与位置完全不变。
  - **榜单序号分档**：原来是一个 28×28 的黑色方块，第 1 名和第 6 名长得一模一样——榜单没有层级就等于没做榜单。现在前三名金 / 银 / 铜（`amber-100→300` / `slate-50→300` / `orange-100→300`），第四名起回到中性半透明黑；色相刻意压淡，免得在这套白色玻璃为主的界面里发廉价。序号本身收紧成 24px 的小 pill，不再跟题材 chip 抢宽度。
  - **左上角标重排成一行**：原实现把题材 chip 单独压到 `top-10`，而目录卡的 chip 在 `top-2`——同一屏里两种高度，怎么摆都像没对齐。现在 `[序号][题材]` 共用 `inset-x-2 top-2` 的一行 flex，题材加上 `max-w` + `truncate`，窄卡上不再与右上角的评分 / 追剧竖列压边。
  - **精选辨识度**：货架卡顶部压一条 3px 色条，颜色与栏目标题左侧那道色条同源（正在热播=玫红，新剧=蓝）。这是"这是编辑精选"和下面完整目录之间唯一需要的一笔——不新增任何文案，也不动卡片尺寸。
  - **顺手修掉一个必然踩到的排布 bug**：货架固定装 6 条（`slice(0, 6)`），而原来的 `lg:grid-cols-5` 在 1024–1280 窗口下会把 6 条排成 5 + 1，第二行孤零零挂一张卡。列数改为只用 2 / 3 / 4 / 6，刻意跳过 5，6 列刚好一行装完。

### 性能

- **打开「神秘小窝」要等一两分钟才出内容**（用户报告："打开神秘小窝的栏目加载非常久"）。用 DLL 台架逐源实测（2026-10-06，直连）：6 个 18+ 源里 3 个已死——野果 25.0s、帝果 16.2s（dial 直接连不上）、黄果 AI 60.0s（6 个镜像逐个跑满超时），存活的黄豆 0.47s / 剧果 1.08s / 黄果视频 0.98s。两个因素把这 ~104s 全压在用户的打开动作上：
  - **guo-core 的目录缓存 TTL 只有 15 分钟**（`nativeCatalogTTL`），过期即视为不可用 → 每次打开都对全部 6 个源走 `force` 全量网络；失败不写缓存，10 分钟冷却一过期又要再陪死源跑满一遍。
  - **Rust 侧 guo bridge 是一把全局锁**：6 个并发目录请求在锁里串行排队，总耗时 = 各源耗时之和；期间其它 tab 的封面、详情、画质探测、播放 resolve 全被一起冻住。
  - **修法一（SWR）**：`guo_provider.catalog` 改为三级——缓存新鲜（guo-core 自己的 `fresh`）直接返回；过期但 `items` 非空 → **0ms 返回旧数据**，同时后台 `spawn_blocking` 起一次 `force` 刷新为下次预热（同一"源|分类"在途去重，冷却中的死源连后台刷新都不起）；完全没缓存才在前台走网络（首次访问该源的代价，躲不掉）。打开神秘小窝从 ~104s 变为 ~0ms（6 个源全部有历史缓存：31/40/120/72/96/40 条），死源的内容不再整块消失——原来冷却期它们以失败计、卡片整列蒸发。缓存过期不置 `degraded`：该字段在搜索链路语义是"来源真的挂了"，"TTL 自然过期"不等于源死了；旧内容可见、点进详情该报错就报错，是当下最诚实的表达。
  - **修法二（锁分片）**：`GuoBridge` 的调用锁按站源分片（`catalog`/`cached`/`categories`/`sourceJob` 取顶层 `source`，`detail`/`resolve`/`cover` 取 `drama.source`，兜底从 `drama.id` 剥前缀；initialize/resourceSettings/release/cancelRead 等全局语义 action 落全局片）。分片对 guo-core 安全：c-shared 每次调用本来就跑在独立 goroutine，共享状态全在 `engine.mu`/每源锁下，上游 LAN 模式的 HTTPS 服务也是多 goroutine 并发进同一批 handler。现在的效果：黄果 AI 在自己的片里等 60s 超时，不再拖住任何别的源——后台刷新、封面下载、其它 tab 的操作互不相干。锁内不跨 await 的老规矩不变（外层表锁只护 HashMap 几微秒）。
  - **配套（阻塞池）**：`catalog_list` / `catalog_fast_search` / `catalog_categories` / `guo_cover` / `series_detail` / `anime_qualities` 的 guo 分支全部挪进 `tauri::async_runtime::spawn_blocking`——这些是可能跑满 60s 内部超时的阻塞 FFI，裸调在 async 命令里会占死 tokio worker（封面一页几十张，worker 全被占住时连不相干的 IPC 都排队）。`GuoProvider` 因此 Arc 化（`catalog` 以 `self: Arc<Self>` 为 receiver，把 Arc 递进 SWR 后台任务）。

### 清理

- **整套卡片展开转场是死代码**：`CardExpansionOverlay.tsx`（107 行）实现了「点击剧集卡片 → 卡片铺满展开成详情页 Hero」的转场动画，但它**从未被任何视图挂载**——全仓检索只有它自己的定义处提到 `CardExpansionOverlay`。它配套的三个 store 字段（`cardTransition` / `triggerCardTransition` / `clearCardTransition`）与 `CardTransitionData` 类型也因此悬空：`ExploreView` 从 `useAppStore` 解构了 `triggerCardTransition` 却一次都没调用，`cardTransition` 永远是 `null`，`isNavCollapsed` 只剩侧边栏自己在用。整条链路连同文件一并删除（共 -140 行）。删除前已逐符号全仓检索（含 CSS 与测试目录）确认无引用。

- **`formatTime` 写了两份且格式已经分叉**：`MiniPlayer.tsx`（画中画小窗）产出 `5:03`，`ProgressBar.tsx`（主进度条）产出 `05:03`——同一应用的两个播放面时间码宽度不一致。现在由 `ProgressBar` 导出一份，两个播放面共用。小窗时间码会从 `5:03` 变为 `05:03`（与主进度条一致，这是有意统一）。

- **`Cargo.toml` 顶部注释指向两个不存在的文件**：注释说 `Win32_System_Registry` 的用途「详见 rtx_vsr.rs」、`Win32_System_LibraryLoader` 的用途「详见 lossless_scaling.rs 的 engine()」，但这两个文件在 0.2.5 移除补帧/VSR 时就一并删掉了，照着注释找必然扑空。三个 windows-sys feature 本身都还在用（`main.rs` 的 `window_prepare_fullscreen` 与 `apply_windows_gpu_preference`、`guo_provider.rs` 的 `LoadLibraryA` 加载 `duanju_core.dll`），故只改注释指向，依赖不动。

### 修复

- **「更多」页的视频海报全部出不来**（用户报告："视频海报出不来，然后加载的速度慢"）。根因不在渲染，在**图片格式**：红果图片服务给的是 **HEIC**（实测响应头 `content-type: image/heic`、文件头 `ftypheic`），而 **WebView2 / Chromium 解不了 HEIC** —— 把地址直接交给 `<img>`，浏览器只会解码失败留一块空白。官方 PC 客户端做的是同一件事，它的 `/img?url=` 注释写着"红果封面常返回 HEIC，浏览器不支持时转成 JPEG"，只是它用 Pillow。
  - **修法**：新增后端命令 `short_drama_app_cover_proxy(url)` —— 下载封面 → 用**随包的 ffmpeg** 转 JPEG（实测单张 **0.39s**，它的 `mov` 解复用器直接吃 HEIF 容器，不需要任何新依赖）→ 落盘缓存到 `<数据目录>/hongguo-covers-v1/` → 以 `data:` URL 回前端。只代理字节系图片域名（`*.fqnovelpic.com` / `*.byteimg.com` / `*.snssdk.com`）；放开成任意 URL 会让它变成一个人人可用的代理（SSRF）。
  - **为什么返回 `data:` URL 而不是本地文件路径**：`asset:` 协议的作用域在开发态（数据目录是项目内 `.app-data`）与打包后（`app_data_dir()`）并不一致，写文件要么动 scope、要么挑一个两边都在的目录；直接回 JPEG 更干净，而 CSP 的 `img-src` 本来就有 `data:`。`CoverImage` 的 `resolveSrc` 因此扩成**两种返回值都接受**：本地路径（guo 封面，仍走 `convertFileSrc`）与可直接使用的地址（`data:` / `blob:` / `http(s):`，直接当 `src` 用）。
  - **只接进「更多」页是不够的**：代理第一版只铺到了「更多」页的行卡（`ShelfRow`），而首页那两栏走的是 `SeriesCard` —— 同一批剧在「更多」页有图、在首页仍是空白。现在把三条通道收口成一个 `coverResolver(seriesId, cover)`（`services/ipc.ts`）：`guo:` 前缀走 guo-core 取本地缓存文件，`.heic` 后缀走后端转码，其余直连。`SeriesCard` 与 `ShelfRow` 都用它，口径不会再分叉。
  - **新增一条联网冒烟测试**（`#[ignore]`，`cargo test --bins -- --ignored cover_proxy --nocapture`）：真去拉一张红果封面，走完"下载 → 识别 HEIC → ffmpeg 转码 → data URL"，并断言解出来的字节以 JPEG 的 `FF D8 FF` 开头。存在的理由很实际 —— `cover_to_data_url` 里任何一步坏掉（域名白名单、HEIC 识别、ffmpeg 参数、base64），前端都只表现为"海报又变成空白占位"，看不出原因；这条测试把失败点直接打出来。实测通过：data URL 51,931 字符、转码后 JPEG 38,930 字节、耗时约 1s。
  - **顺带解释了"慢"**：海报解码失败会触发 `CoverImage` 的 3 次重试（每次重新下载 18KB 的 HEIC）加上挂起兜底计时，一屏 8 张 eager 封面就是 20 多次无用请求，和列表请求抢带宽。格式修好后这部分开销直接消失。
  - **仍然存在的下限**：`worker.py` 一页端到端实测 **1.75–2.2s**（大头是每次都要冷启动一个 Python 进程 + 六代签名），首屏 10–18 条 + 自动补一页 ≈ 4s。要更快只能加"空闲预取下一页"（发现页已有这套机制），本轮没做。

- **首页「正在热播 / 新剧」的刷新按钮是个假动作**（用户报告："刷新按钮存在错误"）。两颗按钮点下去只有图标在转，内容一动不动。根因不在前端反馈层，而在数据链路的**缓存穿透**：19 个 guo 站源的目录走「缓存优先 + SWR」（TTL 15min 内直接回盘上缓存，过期则立即回旧值、后台再刷新），而刷新按钮发的是普通 `catalog_list`，于是拿回来的分页与屏幕上已有的完全一致；红果与动漫两条链路本来就每次走网络，所以只在 guo 源上表现为"点了没反应"。`guo_provider::catalog_refresh`（`force: true` 无视磁盘缓存）其实早就写好了，但一直没有暴露到命令层——代码注释里也写着 `main.rs 未单独暴露`。
  - **打通 force 链路**：`catalog_list` 新增 `force: Option<bool>`，guo 分支里 `force` 走 `catalog_refresh`、否则仍走缓存优先的 `catalog`；前端 `ipcService.catalog.list(filter, force)` → store 的 `refreshCatalog(kw, { force })` → `ExploreView.refreshHomeShelves` 恒传 `{ force: true }`。红果/动漫不做分支（本来就每次走网络）。
  - **force 请求不共用 in-flight 槽**：`requestCatalog` 给 force 请求另起 `${key}|force`——原来同键复用是「同一页只发一次」的幂等保障，若不隔离，一次刷新会被同键的普通请求（或反过来的预取）复用而重新落回缓存。漫剧空壳重试的 `dropPage1Inflight` 同步改成连 force 变体一起清。
  - **失败不再静默**：目录在源侧排序不变时「刷新成功」与「刷新失败」在界面上长得一模一样。`loadData` 现在返回本轮是否成功（全部源均无响应为失败），刷新失败时给一条 warning toast，用户才能区分"刷了但没变化"和"根本没刷上"。转圈仍只跟着被点的那一栏（沿用 `refreshingShelf`）。
  - 顺手删掉 `ExploreView` 里一段死代码：一个 `deps: []` 的 effect 声称"响应全局搜索关键词"，实际只在挂载时跑一次就早退，永远不会再次触发。

- **最后一集播完会重新播放最后一集**：部分 WebView2 版本会对同一末集重复派发一次 `ended`，第二次事件绕过现有自动跳集闩锁后又走收尾/重载路径。新增 `finishedAllEpisodeRef` 对末集结局做幂等处理，用户重新开播、拖进度或切换集时再显式复位，不破坏原有四重连播闸门。
- **连续点击最大化/还原会互相踩状态**：`toggleMaximize()` 是异步落到窗口线程的，两次点击会排队但第二次仍读旧状态。标题栏窗口操作改为单飞，完成后按真实窗口状态刷新图标；真实 Tauri 窗口实测 1443×923 ↔ 1707×1019 切换正常，播放器原生全屏 1707×1067 进出也无尺寸回弹。

- **漫剧/短剧没有 RTX VSR，动漫有**：用户截图证明上一轮只调用/只看 Chromium trace 不够，必须以 NVIDIA 驱动标识验收。真实 1920×1080 漫剧片段在同一 WebView2/同一窗口中对照：HEVC 文件直连、HEVC 本地 HLS + MSE 都没有 VSR；只把同一画面转成 H.264 后，直连连续 5 秒 151 次、H.264 MSE 连续 5 秒 150 次 `ToggleNvidiaVpSuperResolution(on=true)`，并进入 `VideoProcessorBlt`（2560×1440 合成目标）。之前 1280×720 合成片得出的“HEVC 也能触发”是测试夹具误报，不能代表真实源。
  - **修复**：红果 worker 下载解密后直接以 `libx264 ultrafast/crf20/zerolatency` 产 H.264 MP4；旧缓存首次命中时做一次 H.264 迁移并用 sidecar 标记防重复转码。guo/公开 http(s) 直链走新 `media_enhance`：本地 127.0.0.1 服务 + ffmpeg 2 秒 fMP4 HLS，首段落地即播，播放列表会把 init/分片补回会话令牌；转码失败保留原始 `backupUrl`，换集/退出/清缓存会终止任务并清理临时目录。短剧宿主仍保留去模糊/无 `forwards` 动画修正，但真正的硬条件是 H.264。
  - **验收**：真实片段 hls.js 在 WebView2 读到 1920×1080 后，CDP `Tracing` 连续 5 秒记录 150 次 VSR on；`video` 直连与 MSE 两条 H.264 路径均通过。UI 不显示虚假的“VSR 已开启”档位，仍以 NVIDIA App/驱动角标为最终验收。

- **标题栏"向下还原"失效：放大缩小一个样，原始窗口尺寸找不回来**（用户报告："放大缩小都一样大，没有确定缩小的范围"）。复现路径：窗口最大化 → 播放器里进一次全屏 → 退出 → 点右上角还原按钮——窗口从整屏"还原"回整屏，之后这颗按钮永远在两个同样大的状态之间打转，只有拖边或重启才能找回原始尺寸。
  - **根因**：进全屏前 `window_prepare_fullscreen` 必须"原地解除最大化"（不解除，tao 会把无边框窗口的客户区裁到任务栏之上；直接 `unmaximize()` 又带回弹动画），做法是把窗口的"常规位置"（Windows 的还原目标矩形）覆盖成最大化时的**整屏矩形**。这一覆盖从未被还原——退出全屏时前端只是 `win.maximize()`，Windows 把当时的常规位置（整屏矩形）当作还原目标记下来，于是"向下还原"恒等于"再放大一次"。
  - **修法（暂存/写回两端成对）**：prepare 覆盖前把真实还原矩形暂存到 Rust 侧（`PRE_FULLSCREEN_NORMAL_RECT`）；新增 `window_finish_fullscreen` 在退出全屏时写回暂存值并**一次调用直接以最大化状态显示**（`SetWindowPlacement` 带 `SW_MAXIMIZE`，没有"先缩回原尺寸再撑开"的中间帧）。前端 `leaveFullscreen` 改调该命令，命令不可用或无暂存（进全屏前本就没最大化、或走了 unmaximize 回退——那条路不覆盖还原矩形）时退回普通 `maximize()`。进全屏前没最大化的路径不受影响（prepare 早退、无暂存）。

- **全部剧集播完后停在黑屏，不会回到详情页**：连播链路的最后一集 `ended` 后，`playNextEpisode` 按"没有下一集"直接返回，什么都不发生——常驻 `<video>` 没有"剧集播完"的呈现，画面从此停在已 ended 的黑屏上，用户只能自己手点返回。短剧（`usePlaybackStore`）与动漫（`useAnimePlayerStore`）两条链路同病。
  - **判定放 store、导航归组件**：`handleEnded` 在既有闸门（`autoNext` 开启、`tryClaimAutoAdvance` 闩锁、迟到旧源事件过滤）全部通过后，若 ended 的就是最后一集，置位新信号 `finishedAll`（短路剧链路）而非照旧调用 `playNextEpisodeRef`。不能让组件自己看 `uiState === 'ended'` 判断——交接期旧源的 ended 也会把 uiState 置成 ended，组件层分不清；闸门只有 store 拿得到。`VideoSurface` 读到信号后**留 2 秒**（让最后一集的收尾和提示被看到，而不是播完瞬间把画面抽走）再 `navigateTo('detail', seriesId)`；动漫侧同待遇，走与手动返回相同的 `close() + navigateTo('detail')`，以会话号判过期。全屏不需要处理——App 在离开播放视图时会自动退全屏（既有 effect）。
  - **任何用户接管都撤销返回安排**：`finishedAll` 在重新开播（`handlePlaying`）、手动拖进度（`seek`）、发起换集（`openEpisode`）、离开播放器（`stopPlayback`）四处复位；定时器触发前还会复查 `video.ended`，拖回去重看的人不会被突然拉走。设置里关掉"自动连播"的行为不变——那是用户自己选的"播完停下"。

- **点了小锁之后其他操作照样生效**：锁定（收起控制器）只隐藏了 HUD，交互层到处漏风——单击/双击画面仍会暂停/全屏、长按仍有 3 倍速、空格/方向键/F/`[`/`]` 快捷键照常工作、收起态迷你进度条还能拖动跳转；短剧侧"Esc 退全屏"与"Esc 解锁"两个监听还会同时触发。锁的语义应当是**除解锁外一切输入失效**（与手机播放器的锁定一致），否则它防不了任何误触。
  - **逐入口封堵，两个播放器同一语义**：画面单击/双击（`handleVideoSurfaceClick` / `handleSurfaceClick`）、长按临时倍速（`handleSurfacePointerDown`）在锁定态直接返回；全局快捷键监听开头按 `isLocked` 早退（动漫侧原来只在 Escape 分支特判，现统一拦在入口，Esc 全权交给 HUD 的解锁监听）。迷你进度条改为**纯显示件**（原"支持收起态拖动找位置"是刻意做的特性，与锁定语义冲突，按本次规范收回），CSS 同步去掉 `cursor: pointer` 与拖拽用的 `touch-action`。
  - **解锁出口保持三条**：点小锁、按 Esc、键盘焦点在小锁上回车/空格——锁死后永远出得来。
  - 动漫播放器的 Esc 已有 `isLocked` 特判（锁住时不退全屏、不离开播放器），本次把短剧侧对齐到同一行为：锁住时 Esc 只解锁。

- **从小窗回到播放器后，主窗口压在别的软件最底下**：小窗是常驻置顶窗口，它的典型用法正是「小窗挂在那儿、人切到别的软件干活」。此时主窗口既不激活也不置顶，只在 z 序底部排着；而用户点小窗上的「回到播放器」时，`pip_close` 只做了「回报进度 + 销毁小窗」两件事，从没把主窗口带回前台——于是片子确实接着在主窗口里放起来了，界面却压在那个软件底下，得回任务栏里翻。若期间主窗口被最小化（同样常见），单独 `set_focus` 也只能激活一个最小化窗口，画面照样出不来。
  - **修法**：`pip_close` 在 `mode == "return"` 时、销毁小窗之前，把主窗口 `show() + unminimize() + set_focus()` 提回前台（`pip.rs` 的 `raise_main_window`）。时机刻意选在**小窗还活着、本进程仍持有前台权**的这一刻——用户刚点了小窗里的按钮，最后一个输入事件属于本进程，Windows 对 `SetForegroundWindow` 的前台限制能够满足；拖到小窗 `Destroyed` 之后再设就晚了，那时前台权可能已让给别的窗口，设置会被拒绝、只剩任务栏闪一下。
  - **只改「回到播放器」这一条出口**：点小窗上的叉（`close`）与系统路径关闭小窗都不抢焦点——那两种情况下用户可能正在别的窗口里忙，抢焦点反而是打扰。回流后的起播链路（`PipReturnBridge` 重新 `openEpisode`）本身没有改动。

- **标题栏关闭键的悬停底色从来不是红的**（用户报告：“右上角的那个关闭按钮的底色是灰色的，不是红色的”）。三颗窗口按钮共用 `WIN_BUTTON_BASE`（内含 `hover:bg-slate-500/10`），关闭键在其后追加 `hover:bg-red-500` 想盖成 Win11 惯例的红色——两边都是普通类，谁也不带 `!important`。
  - **根因（实测，不是推断）**：同一个元素上并存两个 `hover:bg-*` 时，生效的是 **Tailwind 的输出顺序**，与 className 里的书写顺序无关（两者特异性相同，都是 0-2-0）。编译 tailwindcss 3.4.17 的产物：`.hover\:bg-red-500:hover` 在产物第 2460 行，`.hover\:bg-slate-500\/10:hover` 在 2497 行——默认调色板把 slate/gray/zinc 一族排在 red 一族之后，红色恒被灰色盖死；`active` 态（`bg-red-600` vs `bg-slate-500/20`）同病。
  - **修法**：把中性底色与危险底色拆成两个互不重叠的成品类（`WIN_BUTTON_NEUTRAL` / `WIN_BUTTON_CLOSE`），`WIN_BUTTON_BASE` 只留尺寸、字形与焦点环，每个按钮只声明一组 `hover:bg-*`，不再依赖产物顺序。
  - **Chromium 实测（DPR 2，悬停后取按钮左上角像素）**：修复前 `rgb(237,239,242)`（slate-500/10 叠在白色标题栏上），修复后 `rgb(239,68,68)` = `red-500`。


## 0.2.15 - 2026-10-04

### 新增

- **启动时主动发现新版本，由用户选择要不要更新**：新增全局组件 `UpdatePrompt`（挂在 `App.tsx`，任意页面都能收到）。启动后自动查一次 GitHub Releases，有新版本则弹窗展示版本号、体积与 release notes，由用户点「立即更新」或「稍后」。三条克制，避免它变成骚扰：① **检查失败一律静默**（启动路径上的网络错误不该变成一个红框，设置页里手动检查才会报错）；② **6 小时内只自动检查一次**，且用户对某个版本点过「稍后」后不再问同一个版本——GitHub 未认证配额只有 60 次/小时；③ 下载与安装全程有进度条与失败退路，不是黑盒。注意区分：本项目只做「自动**检查** + 用户**选择**」，不做不打招呼就替换应用的后台静默更新。

### 修复

- **连播倒计时不准：读秒到一半就被腰斩**（实测：54321 读到 3 就跳下一集）：倒计时与视频 `ended` 是**两个各自独立的跳集触发器**，抢同一把 `tryClaimAutoAdvance` 锁。而 `ended` 在视频真正播完那一刻**必然先到**——它抢先 claim 成功、立刻跳集，正在跑的读秒直接消失。
  - **为什么两者会交叉**：读秒时长由武装时刻的 `dur - cur` 估算，而 `dur` 对分片 MP4 与本地解析产物是偏大的估计值。于是算出的读秒比**真实剩余时间**长；两者一交叉，`ended` 先到，跳集就比用户看到的读秒早了。代码里原先那句「读秒时长与剩余时间取小者」只能防住「读秒超过视频」，防不住「视频提前结束」。
  - **修法：让倒计时独占这次切换**。`handleEnded` 遇到「这一集正在走倒计时」直接返回——倒计时本来就是预告这次切换的 UI，由它把切换发出去才不会中途变卦；`ended` 退化为**没有倒计时时的兜底**（末集、短片、结算期未武装等）。为此在 `handlerCtxRef` 里补上 `countdownEpisodeId`：只判断 `countdownActive` 不够，必须确认倒计时就是为**这一集**启动的，否则用户手动切集后的残留状态会挡住 `ended`。
  - **附带修掉读秒漂移**：原先是 `sec -= 1` 逐次递减，而 `setInterval` 不保证每 1000ms 准点回调——主线程一忙（解码、`backdrop-filter` 重绘）回调就排队、到点后**连续补发**，那几次补发会把读秒连砍几秒，肉眼可见地跳着走。改成每次拿 `Date.now()` 与绝对截止时间相减，主线程卡多久都不累积误差。
  - **实测复验**（2026-10-04，dev 版 + 用户实机操作）：把进度条拖到离结尾约 10 秒放手，倒计时**完整读满 5 → 4 → 3 → 2 → 1** 才切下一集，不再中途被截断。另确认动漫链路不受影响、也无倒计时——`useAnimePlayerStore` 里是「播完直接进下一集」，本就没有倒计时 UI，不存在同一处竞态。

### 改进

- **更新改为「下载完自动安装」，用户零操作**（改动既有不变量，原文是「下载完成只定位文件、不得自动安装」）：新增后端命令 `update_install` —— 启动安装器（NSIS 静默开关 `/S`）并 `app.exit(0)` 让出文件句柄；前端 `SettingsView` 的按钮从「下载安装包」改为「下载并安装」，下载进度条之后接一段安装态提示。
  - **静默运行从网上下载的 exe 确实不是好习惯，所以把风险收紧到四条必须同时满足**（`update.rs` 的 `update_install`，缺一条就拒绝执行并报错）：① 路径 `canonicalize` 后仍落在下载目录内（与 `update_reveal` 同一道校验——入参来自前端，不加限制等于给了页面一个「运行下载目录里任意 exe」的能力）；② 扩展名必须是 `.exe`；③ 文件头必须是 `MZ`；④ 体积 ≥ 1 MB（挡下载中断留下的半截文件）。原有的资产域名白名单与文件名净化继续生效。
  - **失败不得静默**：安装启动失败时前端回落到「打开安装包所在文件夹」并如实说明原因，而不是重试一次大概率同样失败的下载，更不能吞掉。
  - **安装阶段用脉冲条而不是百分比**：那时已经没有百分比了，拿下载进度假装还在下载是撒谎。

- **安装包全中文**：MSI/WiX 侧 `language: ["zh-CN"]`，产物名由 `_x64_en-US.msi` 变为 `_x64_zh-CN.msi`（文件名里的语言标记就是默认语言，此前没声明语言、Tauri 按 en-US 产出）。
「不读那个键」，而不是「把它写对」。**实测复验**（2026-10-04，用户双击安装包逐页确认）：欢迎页、按钮与「已安装旧版本」页均为简体中文，且全程**不出现语言选择页**。验证是在注册表脏值 `Installer Language = 1033`（英文）仍然存在的情况下做的，因此对已装过英文版的老用户同样成立。

### 移除

- **随包 mpv（114.8 MB）及其零调用方的外部播放兜底，安装包体积砍掉一半**：mpv 只被一个地方用到 —— `external_player_open`（把播放链接甩给外部播放器）。而这个命令**前端一次都没调用过**：`openExternal` 在 `ipc.ts` 有定义，但全项目零调用点，代码里也已写明为什么不走这条路（`usePlaybackStore.tsx`：「走到这里说明 CDN 直链与 Blob 代理都被挡了……在播放页内完成，不弹外部播放器」）。也就是说早期「WebView 播不了就交给 mpv」的设计早已被「本地解析」取代，mpv 一直白背在包里。
  - **ffmpeg 必须留下，而它就住在 `resources/mpv/` 目录下** —— 这是本次删除最大的坑：目录名有误导性，但 `worker_paths()` 取的正是 `mpv/ffmpeg.exe`，删掉整个目录等于删掉解密管线，红果短剧一集都播不了。ffmpeg 是 CENC 解密的唯一实现，不可替代（主路径 `_ffmpeg_direct_decrypt` 把拉流+解密+转存一步做完，实测 1.2s；`resolve_prefix` 取前 2MB 约 300ms 出画）。因此保留目录、只删 mpv 二进制，并保留 `.gitattributes` 里 ffmpeg 的 LFS 条目。
  - 一并删除：`mpv.exe` / `mpv.com`（LFS，零调用方）、`external_player_open` 命令与其 handler 注册、`openExternal` 前端方法、随之失去用途的 `std::process::Command` 与 `CommandExt` import（留着会被 clippy `-D warnings` 判为未使用）、`TTV_BOX_MPV` 调试覆盖项。目录只装 ffmpeg 但名字仍叫 `mpv/` —— 改名要同时动 `worker_paths()`、CI 校验清单与打包清单，可读性收益远小于风险，本次刻意不动。
  - 实测（mpv 删除 + 简体中文语言包后重新构建）：NSIS **81.3 MB → 48.4 MB（−40%）**；MSI **112.1 MB → 67.5 MB（−40%）**，首次降到 GitHub 单文件 100 MB 上限以内、从此两种格式都能分发。

## 0.2.14 - 2026-10-04

### 修复

- **解析时闪出黑色控制台窗口**：随包的 `ffmpeg.exe` 是 console 子系统程序，由 Python worker 拉起。Rust 启 worker 时已经给了 `CREATE_NO_WINDOW`（所以 worker 自身没控制台），但该标志**不传递给子进程**，父进程无控制台时 Windows 会给 ffmpeg 新分配一个 —— 表现是用户在前台界面播放红果剧集时偶发闪出一个黑窗。三处 ffmpeg 调用（直连拉流解密、`resolve-prefix` 前缀解密、下载后转存）统一经 `_no_window()` 传 `CREATE_NO_WINDOW`；该标志作用在 `CreateProcess` 上，比 `STARTF_USESHOWWINDOW + SW_HIDE` 可靠（后者偶尔仍会闪）。mpv（外部播放）与 worker 进程的标志此前已存在，本次一并复核确认。
- **全局重渲染风暴：卡片与搜索的响应速度修复**（实测驱动：`position` 是 React state，`timeupdate` 每秒约 4 次写入 → `PlaybackProvider` 每秒重渲染 4 次 → `ExploreView` 跟着重渲染 → 整页卡片重画；搜索框每敲一个字同样触发一遍）：
  - **根因一：所有 store 的 context value 都是每次渲染新建的对象字面量**。于是任何一次 `setState`——切视图、弹个 toast、播放进度跳动、搜索框敲字——都会广播给**所有**消费者。而 App.tsx 把七个视图全部常驻 DOM（隐藏 ≠ 卸载），所以一次无关的状态变化会连带重渲染隐藏视图里的上百张卡片。`useAppStore` / `useFavoritesStore` / `useHistoryStore` / `useSettingsStore` / `useCatalogStore` 全部改为 `useMemo` 的 value。
  - **根因二：action 每次渲染都换身份**。`navigateTo` / `goBack` / `rememberSearch` / `showToast` 等都被视图里内联的 `onClick` 依赖，它们一变，下游所有 `useMemo` / `React.memo` 全部失效。改为 `useCallback` + ref 读最新 state（依赖 state 的函数不该把 state 放进依赖）。
  - **根因三：收藏状态订阅粒度是整张表**。`markBySeriesId` 每次渲染 `new Map(...)`，而每张卡片都订阅它——改任意一部剧的收藏就重渲染全部卡片。新增 `useFavoriteMark(seriesId)`（`useSyncExternalStore` + 逐 id 监听表），收藏变化只重渲染那一张卡；通知放在 effect 里而非 `useMemo` 里，避免渲染期间调用 listener 触发 React 警告。`markBySeriesId` 本身也补上 `useMemo`。
  - **根因四：`SeriesCard` 不是 `memo`，且宿主传的是内联箭头函数**。现在它是 `React.memo`，`onClick` / `onUnavailable` 签名改为收 `seriesId`——卡片自己知道自己的 id，宿主只需传**一个** `useCallback` 给全部卡片，而不是每张卡新建一个闭包。三个宿主视图（发现 / 动漫 / 搜索）同步改。
  - **封面：上百个 IntersectionObserver 合并成一个**。每张封面各建一个 IO 实例，一页 30 张、无限流后上百张，而它们要的判定完全一样。改为模块级共享单例 + `WeakMap` 回调表，惰性创建、命中即自注销。
  - **`convertFileSrc` 的动态 import 提升为模块级 Promise 缓存**：原先每张 guo 卡都调一次（几十次 Promise 调度），现在全应用只解析一次，失败不缓存。
  - **guo 封面 IPC 加会话内缓存 + 在途去重**（容量封顶 400）：同一张卡同时挂在多个常驻视图上时会重复请求；后端已落盘缓存，前端缓存的是稳定本地路径，不会拿到失效地址。失败结果（`null`）同样记录——那个源确实没封面，重试只是白打 IPC。
  - **移除 `MicaCard` 的 `will-change-transform`**：它为每个元素强制分配合成层，而卡片是首屏 24 张、上百张的高频元素。与该文件已有的 backdrop-filter 实测（79 个模糊元素 → 滚动 p95 164.8ms）同源，合成层数量本身就是代价。
  - **搜索：联想与快路并行**。原先联想挂在 `searchFast` 的 `.then` 里，总耗时 = 0.3-0.6s + 0.6-1.9s（联想要冷启动 Python）；而联想是纯补充、从头到尾不阻塞首屏。改为并行后总耗时是两者的最大值。
- **首页无限流改成真正的预取式，滚动不再等网络**：旧实现是"滚到底 → 发请求 → 等回来 → 插入"，整段请求延迟就摆在滚动路径上，所以体感是"不能一直下滑，卡一下才出下一页"——`rootMargin` 从 640px 一路加到 1200px 也只是把停顿往前挪，没有取消它。现在把**发请求**与**提交到界面**拆开：
  - **单页预取槽位（`pendingFetchRef`）**：一页只发一次，发完连同算好的页码与 Promise 一起搁在槽位里；用户滚到底时通常它已在途甚至已完成，提交变成同步动作。页码推进**刻意放在提交期而不是发起期**——这样"同一页被发起两次"（预取撞上提交、失败后重试）算出的页码完全相同，`requestCatalog` 的 inflight 去重直接复用同一个 Promise，天然幂等且不跳页。
  - **预取不碰任何界面状态**：失败静默释放槽位，下一次滚动退化成同步加载即可，不该弹错误。登记 `seenIds` 也是提交期的职责，否则预取来的卡片会在真正提交时被自己的去重表过滤掉。
  - **两条触发线**：store 里一条 `requestIdleCallback` 空闲预取（每页落地后排下一页，不和点击/切题材抢帧，文档隐藏时不预取），页面里一条"距底部 800px 就预取、400px 才提交"的双 IntersectionObserver。两条靠槽位幂等，不会重复打站源。
  - **认领标记（`claimed`）**：`isLoadingMore` 是 state，React 重渲染前可能有第二个 `loadMore` 挤进来；此时页码尚未推进，它算出的会是同一页 —— 不挡住的话会留下一条已过期的记录，下一次提交因 id 去重拿到 0 条新卡片，从而**误判到底、无限流中途消失**。同理 `beginFetch` 返回 null 有"到底"与"正被认领"两种含义，只有槽位为空才能宣告到底。
  - **提交后几何自检**：IntersectionObserver 只在"穿过阈值"时回调，而追加的内容可能不足以把哨兵推出 rootMargin（典型是本轮只多出两三条、其余源已到底），此时既没有新交叉事件、`loadMore` 也不会自己再来 —— 表现为"滚到底停住，往上推一下才有反应"。追加后按实际位置再兜一次。
  - **observer 不再拿 `isLoading` / `isLoadingMore` 当守卫**：它们进依赖会让 observer 随每次提交重建，而哨兵若仍在窗口内会立刻再触发一次，等于把提交时机交给重建节奏。单飞由 store 的 `isLoadingMore` 负责。
- **首页无限滚动永久卡在「正在加载更多内容…」**：翻页请求（`loadMore`）的收尾与失败处理有三处缺陷叠加，任一条都会让底部转圈停不下来。
  - **根因一：`isLoadingMore` 复位带 requestId 判定**。翻页途中发生任何会重跑首屏的动作（切题材/排序/频道、设置页改启用源、顶部搜索回车），`requestIdRef` 就会前进；那一轮翻页随即被作废，它的 `finally` 因为判定不相等而**不复位 `isLoadingMore`**。这一标志一旦停在 `true`，`loadMore` 首行的 `if (isLoadingMore) return` 与 `ExploreView` 那句 `|| isLoadingMore` 会同时短路——滚动监听器还在，但永远不会有人再调它。表现就是底部永远挂着"正在加载更多内容…"，往上滚也不再加载。`loadMore` 本来就有 `isLoadingMore` 单飞，不存在两个在途请求互相踩，因此改成**无条件复位**（不带 requestId），并在 `loadData` 开头也显式清一次，覆盖"作废的那一轮永远等不到自己收尾"的情况。
  - **根因二：全源到底时被当成加载失败**。所有源的页码都记作 0 之后 `pending` 为空，`requestAllSources` 里 `failures.length === sources.length` 在 `0 === 0` 时成立，于是抛出"目录数据加载失败（0 个源均无响应）"——一次正常的到底被抛进 `catch`。现在 `pending` 为空直接 `setHasMore(false)` 返回。
  - **根因三：失败后自动重试风暴**。`isLoadingMore` 复位会重建 IntersectionObserver，而哨兵仍在视口内，于是立刻再次触发 `loadMore`；后端还在失败时这就变成一秒几次的请求风暴。翻页连续失败两次后置 `hasMore=false` 熔断，把重试交回用户——底部此时显示"加载更多失败，点此重试"而不是谎称"已加载全部公开内容"（该文案只在真到底时出现）。翻页成功一次即清零计数。

## 0.2.13 - 2026-09-30

### 新增

- **无缝连播补上最后一环：首帧预解池（从「文件就绪」到「首帧就绪」）**：预取链条的终点一直是 `resolvedFileByVidRef` 里存一个 **URL 字符串**，而首帧就绪（`preloadSource` → `canplay`）是在**用户切集那一刻**才做的。于是连播的时间轴是：`ended` → 快路径命中（URL 已在盘）→ `preloadSource`（实测 150~400ms）→ `adoptPreparedSource` 等 `loadeddata`（100~200ms）。解析那 7.4 秒早就被预取吃掉了，**剩下的缝就是这 200~600ms**——画面停在旧帧（不是黑屏），声音已断，用户感知是"顿一下"。现在预取解析成功后顺手再预解一次，探针 element 存进容量 3 的 LRU 池，切集时直接接管，**整段 `preloadSource` 被跳过**。
  - **安全性**：`preloadSource` 本来就造一个不挂进文档流的隐藏 video（避免 Layout/绘制开销），所以池里的探针**不产生额外合成层**；数量封顶 3，离 `MicaCard` 注释里记的"79 个 backdrop-filter 元素 → p95 帧耗时 164.8ms"差两个数量级。淘汰与换剧/退出时一律走 `disposePrepared`（`pause + removeAttribute('src') + load()`）——只删 Map 不释放，解码器会一直挂在脱离文档流的 video 上。
  - **命中条件收紧到 `startPosition === 0`**：池里的探针是按"从头播"预解的，带历史进度重入时 `currentTime` 对不上，硬用会跳帧，那种情况老老实实走 `preloadSource` 重新定位。连播与新集前进都是 `startPosition=0`，正好覆盖主场景。
  - **适用边界**：只覆盖**本地整集文件 / 直链**（`playLocalFile` 链路，即红果 drama/comic）。guo 走 `playDirect`（那条链路有 `backupUrl` 防盗链兜底，不宜动）；dmghg / 暴风是 m3u8，预解会把 MSE 实例建起来、主播放器接管时反而要重建，继续靠 `prefetchStream`。命中/未命中计数打进 console，便于确认预留窗口够不够长。
- **接入 guoapp 外部短剧站源**：引入 guoapp Go 原生核心及其已验证站源解析能力，TTV Rust 侧通过 `duanju_core.dll` FFI 统一承接目录、搜索、详情、分集、真实清晰度和取流。外部剧集 ID 统一使用 `guo:<source>:<id>`，与红果、动漫 ID 隔离。前端发现页注册 18 个 guoapp 站源并标注 `available` / `partial` / `blocked`，单档源不显示假的画质切换。
- **保留红果现有 worker 链路**：红果短剧/漫剧继续走 TTV 原有签名、整集解析和 CENC 解密链路；外部 HLS/文件流由 `playback_open` 返回显式 `streamKind`，前端据此选择 hls.js 或 `<video src>`。
- **guo 源封面接入 guo-core 缓存链路**：各 guo 站源的封面不能直接喂 `<img>`——黄果视频有 Cloudflare 防护（裸请求实测 403，带 Referer 也拦）、部分源封面是加过密的（guo-core 里有 AES-CBC/XOR 两套解密）。现在新增 `guo_cover` 命令：guo-core 带源侧 Referer 下载、解密、魔数校验后落本地缓存（`<app_dir>/guo-core/covers-v1`），前端 `convertFileSrc` 经 asset 协议呈现（scope 在 setup 里显式放行——dev 态缓存目录在项目内，不在默认的 `$APPLOCALDATA` 里）。实测黄果视频（403 源）/黄果 AI/野果/芽果四源封面全部下载成功；应用里切源后实测生成 20 张缓存，全部为有效 JPEG。
- **首页只展示有封面的卡片**：封面地址为空的条目直接不渲染；封面加载确定失败（三次重试耗尽 / guo 解析失败）或 20 秒挂起无像素的卡片，从当前列表移除、不再展示——切源/换筛选时重置（网络抖动不该永久除名）。
- **18+ 内容源开关（设置 → 内容源分级）**：把 6 个成人内容源（黄豆 / 剧果 / 野果 / 帝果 / 黄果 AI / 黄果视频）归为一类，由 `settings.showAdultSources` 控制。默认关闭：发现页的源选择与搜索结果都不会出现这些源；若关闭时正选中受控源，立即切回红果（否则目录会继续从已隐藏的源加载）。开启后整体恢复。分类依据是各源实际目录内容（2026-09-29 逐源抽查）：帝果实测为日本 AV 站（无码中字/含番号）、黄果 AI 官方分类名即"AI成人短剧 / AI成人漫剧"、黄豆/剧果/野果/黄果视频抽查均含明确成人条目；其余 12 个源抽查为常规短剧。旧设置记录经 serde default 兼容（缺字段视为关闭）。
- **搜索交互重构：砍掉重复输入框的中间页**：此前点顶部搜索框会先跳进一个"搜索页"——页里又有一个输入框和一整块历史卡片，历史藏在那个空页面里（用户反馈"这个页面是多余的"）。现在搜索历史以浮层展示在顶部搜索框正下方（聚焦/点击弹出、点击外部收起、可单条删除与清空）；回车或点历史条目**直接进结果页**；结果页只展示结果（返回按钮 + 「关键词」的搜索结果 + 相关度/计数 + 网格），页内输入框与历史卡片整体移除。配套：搜索请求只在结果页激活时发起——顶部框在其它页面打字（尚未回车）不再让后台空跑一轮请求。
- **搜索框联想下拉**：顶部搜索框输入时在历史浮层上方给出剧名建议，候选里**把命中的关键词片段高亮**（`text-blue-600 font-bold`），↑↓ 可选中、回车提交。移植 guoapp `search_input.dart` 的三条关键机制——300ms 防抖 + 32 条 LRU 近似缓存、命中片段高亮、**中文输入法拼词期间（`compositionstart`~`end` 与 `nativeEvent.isComposing`）绝不发请求**（拼到一半按回车必须是"上屏候选词"而不是"提交搜索"，国内输入法下的经典 bug）。慢响应靠单调递增的 `generation` 计数器作废（`clearTimeout` 只能停掉还没发出去的那条，0.6–1.9s 在途请求只能靠这个），空结果静默退化为只显示历史、不报错。有后端 5 分钟缓存后这一路近乎零延迟。
- **搜索结果"加载更多"分页**：搜索此前固定 `page: 1`，后端返回的 `hasMore` / `nextCursor` / `total` 全被浪费。加载更多复用同一 filter 翻页并按 id 去重（后端带关键词时每页都会再合并一批 App 联想，不过滤会白长出同样几张卡片），**每个续体写动作都复查 `requestIdRef`**（中途改关键词时在途响应不能写进新结果），失败只显示一行错误、绝不清空已有结果。

### 修复

- **首页卡片大量误标「1 集全」，点进详情却是几十集**：花果/无果的目录模板把未填集数的剧填成 **1**（2026-09-30 实测分布：花果 36 部里 19 部 `episodes="1"`、无果 30 部里 29 部；而《暗潮涌动》目录写 1、详情分章实测 60 章）——上一条修复让 `number()` 能读出字符串数字后，这些假 1 以"1 集全"的形式上了卡片，比读成 0 更有误导性。毛果/盒果/饭果/芽果的目录集数同法实测全部可信。卡片集数徽标阈值改为 `>1`：真只有 1 集的短剧几乎不存在，此时"集数未知"也是实话；详情页不受影响（它显示的是分章数，是权威值）。
- **guo 播放错误把内部域名直接暴露给用户（不变量 12）**：实例——花果站《蜂门》整部剧的线路在**站方侧失效**（实测 2026-09-30：播放页返回的 m3u8 指向 `cdn.yddsha2.com`，对 1/14/63 集全部 HTTP 404；用另两个在线 CDN 域名替换同 path 也 404，说明不是换域名而是源文件没了），用户点开任何一集看到的都是"获取花果播放列表失败：cdn.yddsha2.com HTTP 404"——内部 CDN 域名直接进了 UI。体检面板早有先例（step.message 只在成功时显示），但播放/目录错误从 guo-core 直通前端。现在 `GuoBridge::request` 的 Err 统一过 `sanitize_guo_error`：剥 URL/域名/IP（含 Go 的 `Get "…":` 双层包装），"HTTP 404/403/429"、`context deadline exceeded`、`no such host` 等技术短语翻译成用户语言（"播放文件不存在或已下线"/"站点拒绝了本次访问"/"响应超时"/"站点域名无法解析，站点可能已关闭"），guo-core 自己的人话文案原样保留；原始错误进 stderr 留诊断。该错误同时带**误导性**：404 读起来像 TTV 坏了，实际是站方资源下线。
  - **换源出路实测存在**：《蜂门》在无果源 63 章全可播（EP14 resolve 实测通过），网果 1 章可播；发果那份也是坏的（站源未返回有效播放列表）。同一部剧多源转载是 guo 站常态，单源资源失效时换源即恢复。
  - **花果是"部分线路死亡"不是整体死亡**（2026-09-30 目录前 6 部抽样：5 部 EP1 resolve OK、1 部 404）：站方把一批剧留在已下线的 `cdn.yddsha2.com` 上没迁移（《蜂门》《浪子回头金不换》《金猪玉叶第二季》三部死剧全指向它），其余剧走在线 CDN 正常。所以花果**不能**进死源冷却（catalog 一直成功），痛点是用户逐集点开才发现——播放错误卡为此单列"站方资源已失效"分支（按 `sanitize_guo_error` 的稳定字面量判定），文案直接给出"换一集或换站源"出路，不再落进"该媒体无法由 WebView 解码"的错误归因（不变量 8，与 MEDIA_PLAYBACK_STALLED 同款问题）。
- **guo 源「目录能看、点开就挂」的根治：默认直连 +「站源网络」开关**：guo-core 出厂的代理模式是 `auto`（跟随系统代理），而 guo 的 19 个站全是境内 CDN——实测（2026-09-29）挂着系统代理（Clash/V2Ray 类，出口在境外）访问花果站 `www.zywest263.com` 恒为 HTTP 403，同一请求直连 200、详情能拿完整分集；目录还能看是因为吃了本地缓存。目标用户在国内、开着系统代理是常态，`auto` 出厂即坏。现在首次运行（`resource-settings.json` 不存在）把 guo 源网络默认写成**直连**；设置页「视频源」卡新增「站源网络」开关（直连 / 跟随系统代理），经 `guo_proxy_get` / `guo_proxy_set` 读写，真实状态只存 guo-core 自己的 `resource-settings.json`（`saveResourceSettings` 热应用），TTV 侧不存第二份。真机台架（直接驱动 DLL 跑 19 源 catalog→detail→resolve 全链路）在 `proxyMode=direct` 下 14 个源全链路打通，resolve 一律返回 guo-core 本地媒体服务的 `127.0.0.1` URL（CSP 的 `media-src` / `connect-src` 均已放行）。
  - **`set_proxy_mode` 回写必须带全字段**：guo-core 侧按 JSON unmarshal 进 struct、缺字段即零值——只传 4 个字段的旧写法会把 `proxyUrl` / `downloadBySource` **静默清空**，而那个文件是这套设置的唯一持久化。现在读一份完整设置、只改 `proxyMode` 再整体存回。
- **guo 卡片集数徽标全灭**：guo-core 的目录输出把数字字段序列化成**字符串**（实测 item 是 `episodes: "33"`），`number()` 只认 `as_u64`，全部读成 0——19 个源的集数徽标（含详情页分集数）整体显示"集数未知"。`number()` 现在对字符串先按数字解析（空串/非数字归 0 并继续试下一个键），目录集数、详情集数、章节序号三个调用点一并修正。
- **死源拖死 guo 首屏（失败冷却）**：逐源体检实测 yeguo 目录 25s、黄果 AI 60s（6 个镜像逐个试）、牛果 resolve 57s 才吐超时；而 guo 源的失败**不写目录缓存**，意味着死源永远走全量网络——发现页 `Promise.allSettled` 等所有源，启用死源时每次首屏都被拖 25-60s。现在给失败源记 10 分钟冷却，期内再请求 0ms 快速失败（文案不含内部细节），到期自动放行再探——站方恢复无需重启。**顺带救活桥锁**：guo bridge 是全局单锁，死源那 25-60s 的内部重试期间所有 guo 调用（其他源目录、封面、起播）全部堵在锁上排队；冷却中的源根本不进桥，排队随之消失。首屏仍会被死源**第一次**拖住，根治需把 DLL 调用模型异步化，那是另一件事。
  - **19 源链路体检矩阵（2026-09-29，直连）留档**：14 源全链路 OK（红果/黄豆/剧果/帝果/黄果视频/芽果/毛果/饭果/盒果/星果/花果/网果/发果/无果）；5 源站方自身故障——野果目录接口超时、黄果 AI 三个板块全超时、观果详情接口空数据、牛果解析站（`203.0.113.10`）超时、皮果域名 DNS 已失效。死源无法在代码里修活，冷却保证它们不拖累其余 14 个。
- **站源体检「检查」按钮必然白屏**：`guo_source_check` 返回的是**整条源状态记录**（体检报告嵌在 `.health` 下，同 `guoSourceStatus` 的形状），而 `ipc.ts` 把它当成裸的 `GuoSourceCheck` 断言、调用方直接读 `report.steps` → `undefined.length` 在渲染期抛 TypeError。仓库里**没有 ErrorBoundary**，一处渲染异常就是整棵 React 树卸载白屏。后端失败时返回的是 `{error}`（不是 Err），所以 `catch` 压根走不到、失败也会被当"已完成"渲染。现在前端显式解包 `.health` 并把 `{error}` / 缺 health 转成抛错。
- **guo 画质探测从第二集起必然失效**：`qualities()` 把 `sequence` **写死 1**，而 guo-core 的 `nativeBeginPlayback` 把 `engine.playbackSequence` 当**全局单调高水位**（`if sequence <= engine.playbackSequence { return context.Canceled }`）。首次起播就用 `session_id`（前端从 100 起）把水位抬过 100，此后每次画质探测都被上游直接 Cancel → 任意 guo 源播完第 1 集换第 2 集，清晰度恒退回单档"自动"。上一版"guo 画质档位整条轴是死的 → 补上探测"的修复**并未成立**：探测代码在，但恒被上游拒。现在 sequence 收口到 provider 内的 `AtomicU64`（基数 1_000_000、`fetch_add` 递增），起播与探测共用，探测号必然大于任何一次起播号。
  - 顺带根治画中画撞号：AGENTS §5-13 早就预警过"两个窗口各自持有一份会话号计数、都从 100 起"，而 guo 链路把 `session_id` **裸作** sequence，恰好会把那条预警兑现成 `context.Canceled`。
- **guo 会话表只增不减，取会话结果不确定**：`ipcService.playback.command(...)` 在 `src/` 里**零调用点**（`stopPlayback` 是纯前端收口），所以 `main.rs` 的 `stop` 分支永不执行，`sessions` 只随播放时长线性涨；同一集播过两次就有 ≥2 条同 `episode_id` 记录，而 `playback_session` 用 `HashMap::values().find(...)` 找——**迭代顺序不确定**，拿到哪条随进程状态而变，旧那条在 guo-core 侧可能已过期。现在 insert 前 retain 最近 16 条（同一时刻真正在播的只有一集 + 画中画小窗 + 连播刚解析过的几集），查找改成取 `session_id` 最大的那条。
- **无限滚动只能翻到第 2 页**：`step()` 里页码**从不 +1**，第二次 `loadMore` 仍在请求第 2 页 → 全部去重 → `hasMore` 置 false，60 条到底。另外 `res.hasMore` 是各源的**或**，只有全部到底才推进，而一个只有 30 条的源会被反复请求。现在页码 +1，回传 `hasMoreBySource` 逐源置 0 并把到底的源整个从请求列表剔除。
- **卡死自愈成功后横幅永久挂在画面上**：`onHealthy` 只在同一个看门狗实例的 `stalled` 由 true→false 时触发，而自愈走的是"重装载 → 新建看门狗（`stalled` 初值 false）"，`onHealthy` 永不触发。现在三条路径都能收回：用户切集（复用 `stallReloadingRef` 判据区分"用户换集"与"看门狗重装载"）、`onHealthy`、以及新会话的 `playing`（画面真回来的唯一信号）。
- **看门狗升级动作会违背用户暂停意图**：`escalateTimer` 触发时不复查 `paused` / `seeking`（那两条排除判据只作用于第 1 级），卡死后 2 秒内用户按暂停仍会被强制重新起播。现在 `onEscalate` 开头补上——**用户主动暂停优先于自动恢复**。
- **`stallReloadingRef` 可能永久卡在 true**：`openEpisode` 对同一 `(剧, 集, 起播点, 清晰度)` 有在途去重，命中时 `runOpenEpisode` 不执行，而标志在调用**之前**置位 → 之后用户手动换集也不再清 `stallRecoveredRef`，每集一次的重装载额度跨集累积。改用 `.finally` 复位。
- **题材词表门闩失败后永不重试**：门闩在 `await` **之前**置位，词表拉空时直接 return，该 `source×channel` 组合永久不再汇总。失败路径改为回收门闩。
- **卡死错误卡文案与实际行为对撞**：正文写"可重新解析播放源"、按钮写"重新解析播放"，实际执行的是"同一集回退 3 秒重载"——而该集整集已缓存，重签名/重下收益为零，用户点按钮拿到的还是同一个卡死的集。改为如实描述并把按钮改成"重新载入本集"。
- **站源体检面板三个连带问题**：① 一次失败会让该源永久停在"检查失败"（徽章无条件短路 + `checks` 无清除路径）——改为回落到站方真实记录并加「上次」前缀，另给「清除检查结果」；② 点「检查」没有并发闸，同帧两次点击会双发、后端把同源判为"正被另一个任务占用"；③ 首次拉取失败时 `loadedRef` 已在 `await` 前置位，面板**再也不会重试**。
- **中文数字季号解析会"凑数"**：`parse_season_number` 的注释声称"个位堆了两位（十二三）一旦硬算就会得到看着像季号、其实来自错误标题的数字"，但累积个位没有 `>9` 上界，`「十二三」` 实际返回 `Some(33)`、`「百十」` 返回 `Some(110)`。畸形标题会拿错误季号拼回查词（烧掉补查预算）并据此错排分季。补两道护栏，代码向既有注释看齐。
- **guo 源：删掉零调用方的 `guo_sources` 命令与手填 `status`**：该命令在 `src/` 里零命中（前端已改用静态表 + `guo_source_status`），输出的 12 个 `"available"` 全是硬编码快照，恰好与"手填快照会过期并误报可用"的治理方向相反；它还缺 `kind` / `adult`，任何调用方一接上就会破坏 `enabledSourcesForTab`。`GUO_SOURCES` 表本身保留（`source_name()` 等仍用）。
- **画中画小窗接不住新频道「神秘小窝」（`adult`）**：`PipHandoff.channel` 自己是窄写的 `'drama' | 'comic' | 'anime'`，而 `openPip` 直接传 `series.type`——`ChannelType` 加上 `adult` 之后这里就编译不过了。该字段唯一的消费点是回流时写 `WatchHistoryItem.channel`（本来就是 `ChannelType`），窄写一份等于在两处各维护一次频道列表。现在直接用 `ChannelType`。
- **guo 源目录全部打不开（一律"目录加载失败"）**：前端把红果语义的分类原样传给 guo-core——默认的"全部"外加题材栏里的中文名——而各站源的分类校验各按自己的 ID 体系执行（黄果视频要求纯数字、黄果 AI 要求 slug、duanju 系要求英文键），于是**连默认首屏都被整体拒绝**（guo-core 报"内容分类无效"）。实测证据：`sources.json` 里连续 6 个源清一色"内容分类无效"；直接调 DLL 复现，`category="全部"` 报错、`category=""` 正常返回 40 部。修法是在 Rust 侧统一归一化：空/"全部" → 空串（不筛选），显示名按该源分类表映射回源侧 ID（分类表按源缓存；查不到回退"全部"而不是报错——切源瞬间词表可能残留上一个源的题材）。
- **切源后题材栏不刷新、预取缓存跨源混用**：题材词表与"已汇总"门闩只按频道（drama/comic）隔离，切源后从不重新汇总，显示的"爱情/古风"全是红果的分类，点击必然筛选失败；第 2 页预取槽的键还不含 source，不同源的同一筛选组合会互相顶掉缓存。现在词表/门闩/预取槽统一为 `${source}_${channel}`，切源即把分类重置为"全部"并重新汇总新源题材。
- **guo 剧集画质档位整条轴是死的**：guo 详情接口不返回档位（恒空数组），而红果那条走 worker 的探测对 guo 源不适用，也没有任何替代探测——画质按钮永远停在禁用态，档位探测在代码里没有任何调用点。现在补上与动漫链路同构的探测：按"剧+集"调一次 resolve（`anime_qualities` 命令已支持 `guo:` id），成功才更新档位、失败退回单档"自动"，绝不虚构源里没有的档位。
- **guo 分集解析的集数序号被硬编码成 1**：resolve 的 `index` 是"第几集"，黄豆等源在章节自身没带集数时靠它推导播放序号——硬编码会让这些源的所有分集都去请求第 1 集。现在传真实章节序号。
- **站源健康度面板（设置 → 站源状态）**：19 个源的可用性此前是**手工填进 `guoSources.ts` 的静态快照**（`available` / `partial` / `blocked`），填完就不再变——芽果当时记着"未返回有效的访问令牌"却仍被标成 `available`，界面上一直显示成可用。而 guo-core 一直在跑五步链路体检（入口与目录 → 分集目录 → 播放地址与播放列表 → 播放密钥 → 媒体连接），TTV 从没读过。现在接上 `sourceStatus` / `sourceJob` 两个 action：面板逐源显示状态徽章、条目数、是否还有更多页、最后更新时间与错误摘要，"检查"按钮可现场跑一次体检并展开每一步的 host / HTTP 状态 / 耗时。**没体检过一律显示"未检测"，不显示成"可用"**（不变量 8）。`guoSources.ts` 里的手填 `status` 整个删掉，源表只保留结构性属性（`kind` / `adult`）。
  - ⚠️ **信息脱敏是刻意收窄的**：`step.message` 只在 `state === 'ok'` 时显示（Go 侧成功文案是写死字面量），失败一律换成"该步骤未通过"——因为 `helpers.go` 的 `redactErrorString` **只把 URL 的 query 打成 `[redacted]`，不挡本地路径和裸 token**。`cfRay` 完全不展示。
  - `sourceJob` 是**异步起任务**（`go engine.runSourceTask(...)` 后立刻返回 `running:true`），`health.steps` 每跑完一步增量长出。Rust 侧就地 1s 轮询到终态（上限约 3 分钟，与 Go 侧 ctx 超时一致），超时返回最后一份而不是报错。
- **短剧链路卡死看门狗（自愈）**：短剧集播到中途静默卡死（`readyState` 卡在 2、解码线程不再吐帧）时，画面永远停住、进度条不动、也没有任何提示——动漫侧一直有看门狗（`useAnimePlayerStore` 的 `PlaybackHealth.stalled`），短剧侧 grep `watchdog` 零命中。现在按同构思路补上，但**语义是自愈而非只提示**：连续 10 秒「本该在播」却既没有时钟推进、又没有新解码帧、也没有新数据进入（`buffered` 末端不增长）→ ① 原地重试（`currentTime = currentTime`，不换 `src` 不黑屏）→ ② 2 秒未恢复则重装载**同一集**（走既有的三级兜底链）→ ③ 失败才停。
  - 三个关键判据：排除 `paused` / `seeking`（把"正常不动"和"卡死"分开）；**不看 `readyState`**（解码卡死时它恒停在 2，与网络缓冲观感完全一样）；**缓冲时不卸看门狗**（解码卡死时 `waiting` 照样派发且再也不回来，卸掉恰好漏掉要治的症状）。
  - **不踩既有不变量**：恢复前必过 `activeSessionRef.current !== sessionId → return`（等价 `pauseIfStale`）；**只重装载同一集、绝不推进下一集**，`autoAdvanceLatchRef` / `tryClaimAutoAdvance` 一行未碰；每集只有一次自动重装载额度；定时器在 `handleError` / `stopPlayback` / 卸载三处收口。
  - 顺带修掉一处**归因错误**：卡死错误码 `MEDIA_PLAYBACK_STALLED` 原先落进错误卡的默认分支，显示成"该媒体无法由 WebView 解码，已尝试备用源"——源是好的、是解码线程卡了，把它归因给源与 WebView 是错的（不变量 8）。现在单列"播放已停止响应"文案，重试按钮也从 `position - 3s` 续播而不是从头。
- **连播卡死在装载链的「最后一跳」：`play()` 无界挂起，整条链路失去终点**：实测（2026-09-30，《天道余途》连播 42 → 43 集）画面停在旧帧、时间码归 00:00/00:00，无错误卡、无倒计时、十分钟后仍无任何进展。时间码归零是铁证——换源时 load 算法会触发一次 timeupdate(0, NaN)，说明第 43 集的源**已经**赋给了 video 元素，只是永远等不到数据也不报错。装载链上其余每个等待都有超时兜底（preload 探针 10s、adopt firstFrame 8s、webFirstFrame 8s），唯独最后一跳 `video.play()` 没有：本地 asset 协议请求被并发读同一文件的探针顶住、远端连接吊死等场合，play() 的 promise 永不落定，`openEpisode` 的 await 永不返回——错误卡、兜底降级全在它后面，永远轮不到。现在 `playBounded` 给 play() 挂 8 秒保底：超时先看 `readyState >= 3 && !video.error`（play() 迟到但画面已在推进，按成功算，不能把好端端的播放重装载一遍），否则按 error 交给既有降级链（清缓存 → 重解析 → 公开直链 → 错误卡），死局变自愈。覆盖四处落点：adopt/playDirect 共用的 `startPlayback`、公开直链兜底、备用直链、Blob 代理。
- **看门狗把「播完了」当「卡死」**：HTML 规范里视频播到结尾后 `paused` 仍是 `false`，而"播完停在结尾"与"解码线程卡死"在时钟/帧/缓冲三个信号上完全一致——本节引入的看门狗若不管，每集播完静置 10 秒都会被误判：`onRetry` 对 ended 视频做 `currentTime = currentTime` 会把已结束的视频"倒带重生"再立刻播回结尾（用户看到末帧无故闪回一次），2 秒后升级重装载、再 10 秒后报假"播放已停止响应"。三处收口：tick 的排除判据加 `video.ended`；`handleEnded` 顶部 `stopStallWatchdog()`（一集播完看门狗的使命即结束，下一集真正开播时 `handlePlaying` 会重新武装）；`onRetry` 开头补 ended 守卫，且在弹横幅**之前**——ended 视频连"画面卡住了"横幅都不该出。
- **`usePlaybackStore.tsx` 无法 Fast Refresh，每次编辑都整树刷新**：`disposePrepared` 以非组件形式从组件模块导出，react-refresh 判定整个文件"无法 Fast Refresh"（dev 日志可见 "Could not Fast Refresh" invalidate）——2026-09-30 11:22~11:23 追剧期间实测连吃 4 次整树刷新，播放现场、会话号、预取缓存全灭。该函数仅本文件使用，改为模块私有后实测编辑只触发干净的 HMR update。
- **卡片"追剧状态"角标**：`SeriesCard` 读收藏 store 的 `markBySeriesId`，按「想看 / 在看 / **已看**」三态显示——`FavoriteMark` 实际有第三个值 `done`，只渲染两态等于把"已看"显示成"没收藏"（又一例不变量 8）。**无收藏记录则整块不渲染**，不显示"未收藏"噪音。位置接在评分角标下方（`top-2 right-2` 改成一个纵向列），不塞进左上角标签组——那会把 `tags[0]` 往右挤，窄卡上两张标签并排会压边。

### 移除

- **红果弹幕（接入后当轮撤回）**：曾转发 guo-core 的 `danmaku` action（域名、鉴权、protobuf 解析、30s 窗口翻页全在 DLL 里）并做 `<canvas>` overlay，**最终整段删除**（前端 338 行 overlay + 29 行类型 + store 数据层 + IPC 方法，后端转发与 6 个纯函数，约 -420 行）。
  - **为什么接不上（负面结论，留档防重蹈）**：guo-core 的 `danmaku` action **压根没有 drama/chapter 入参**，弹幕身份（红果剧 id 与视频 id）只挂在**播放会话**上（`nativeDanmaku` 第一件事就是查 `engine.playbacks`），所以它只能接受 `guo:hongguo:<id>` 这一族 id。而 TTV 里红果走的是**自有链路**（`main.rs` 三处 `if source != "hongguo"` 显式把它排除在 guo 链路外），剧集 id 是裸 `series_id` —— **`guo:hongguo:` 这个前缀永远产生不出来**。于是 `danmakuSupported` 恒为 false、开关永不渲染、`guo_danmaku` 恒返空数组：整条链路是**实现了但接不上**的死代码。
  - 更正一处此前的错误记录：写这条时曾以为"红果走 guo 链路"，实测 guo-core 侧 `ui_playback_danmaku.go` 的 `hongguoPlaybackIDs` 是按 `source:seriesID` 查会话的，并不要求字面前缀；但 TTV 侧只有该前缀能产出会话，结论不变。
  - 保留的只有**结论性注释**（`guo_provider.rs` 顶部与 `usePlaybackStore.tsx` 各一处），说明"为什么不接"，防止下一个人再接一遍。
  - 顺带删掉的两类半成品：会话表里的 `episode_id` 字段（只被弹幕反查用）、以及 `playback_command` 的 guo 释放分支依赖的 `playback_session` 查找链。**`sessions` 表本身与 `release()` 保留**——那是资源释放语义（转发 guo-core 的 `release` action），与弹幕无关。

### 优化

- **连播预取补全：小窗与 guo 源不再"播完才开始加载"**：红果在主播放器早有预取队列（下三集，命中秒开），但两处空白让用户最直观的连播场景全程黑等——① **画中画小窗**任何链路都没有预取，红果剧每集播完才开始整集解析（实测约 7.4s）；② **guo 源被预取队列显式排除**（那张表存的是红果本地文件路径，guo 的产物是 guo-core 本地媒体服务 URL，语义不同），主播放器连播每集播完才现场 resolve（实测 0.6~5.8s），"从小窗返回播放器"后每集都等一轮。现在：小窗起播稳定后 3 秒对下一集发 `prefetchNative`（纯缓存预热：产物落盘、跨会话有效、失败静默，前台 resolveNative 命中即秒回）；guo 播放成功后后台对下一集发 `playback.open`，产物存独立会话表，连播的 open 快路径命中直接装载（预取专用会话号走独立计数——绝不能推进 `activeSessionRef`，那会把正在播的集立即作废）。guo-core 的 resolve 高水位推进对正在播的集无影响（画质探测在播放中调 resolve 是既有实证）。预取触发不等 `play()` 成功：自动播放被拦等起播问题与本集 URL 有效性无关。
  - **顺带修正小窗的 guo 路由**：`playEpisode` 原本只认 `kind === 'anime'` 走 `playback.open`，其余一律 `resolveNative`——而后者只认红果纯数字 vid，guo id 进去必报"缺少有效的集 vid"，guo 剧的画中画整条链路从未通过。现在 guo id 与动漫同走 `playback.open`（后端按 id 前缀路由，`is_guo_id` 优先）。
- **18+ 内容源门闩下沉到后端（原先只在前端生效）**：6 个成人源（黄豆 / 剧果 / 野果 / 帝果 / 黄果 AI / 黄果视频，受 `showAdultSources` 总开关控制、默认关闭）此前**只有前端知道哪些源是 18+**，后端零校验——`invoke('catalog_list', {filter:{source:'dsd'}})` 就能拿到帝果目录，`playback_open` 更能绕过目录直接取流。现在 `GUO_SOURCES` 带上 `adult` 标记（判定依据照抄前端同一条实测注释），后端在入口按 `settings_get()` 的总开关裁决。
  - **守住的入口**（逐个查过，不是只守目录）：`catalog_list` / `catalog_fast_search` / `catalog_categories` 静默回落红果；`series_detail` / **`playback_open`** / `guo_cover` / **`anime_qualities`** 报错。后两个是容易漏的：`guo_cover` 会带源侧 Referer 去站点把图**下载到本地缓存**（漏了它的表现最隐蔽：目录详情都挡住了，列表里却还有一排 18+ 缩略图）；`anime_qualities` 命令名像动漫，实际 `is_guo_id` 分支会真起一次 resolve 拿档位。**画中画小窗也一并兜住**——它自己发 IPC，但唯一出口就是 `playback_open`。
  - **`catalog_fast_search` 的守卫必须早于缓存查表**：否则受控源的搜索结果会以"红果的结果"落进同一个缓存 key，关掉开关后仍读到旧缓存。
  - **回落与报错要分开**：目录/搜索回落（用户只选了个源，Err 会凭空多出一张"目录加载失败"红卡片，而用户什么都没做错）；直达类报错（剧已在手上，静默放行等于"照播了但你看不见"，用户会以为设备坏了）。
  - `settings_get()` 的 Mutex **绝不跨 `.await`**：只把 `bool` 带出锁，读失败按"关闭"处理（门闩默认关着，故障时放行等于门闩自己打开）。
  - **刻意不动 `enabledSources` 里的 18+ 源**（这一条差点写反）：关闭总开关时把 18+ 源从启用列表剔除看着更"干净"，但设置页的设计决策是**置灰而不是静默取消勾选**（用户回来开开关不该发现选择被吃掉，取消勾选是用户没要求的数据丢失）。而且留一个源 id 在磁盘上**不构成内容泄露**——门闩拦的是内容本身，磁盘上存着"用户曾授权过帝果"这个事实，既拿不到目录也开不了流。有一条测试把这个语义写死，防止下一个人看到"关着开关还启用着帝果"就顺手加回剔除。
  - 有一条 `GUO_SOURCES.len() == 19` 的测试当"两份名单会漂"的护栏：18+ 源清单现在前后端各存一份，改一处必须改另一处。


- **首页取消源下拉，源管理挪进设置页；发现页按 tab 聚合全部启用源**：此前首页左上角一个 `<select>` 是唯一的源入口，19 个源平铺在一个原生下拉里，而"源"本身是全应用影响面最大的开关（目录、搜索、题材词表全跟着它走）却藏在浏览页。现在下拉整体移除，首页只留顶栏「短剧专区 / 漫剧次元」两个区域；设置页新增「视频源」卡片，按**实测归纳**的真人/漫剧分组勾选，18+ 总开关保留并升级为整组门闩（关闭时那组置灰不可点，而不是静默取消已勾选项——否则用户回来开开关会发现选择没了）。
- **逐源实测归类，19 个源里只有 3 个含漫剧内容**：分类不是按站名猜的，是用 guo-core 的 `catalog` action 逐源拉前 12 条看标题/分类/标签/集数（探针跑完即删）。结论是**只有红果、黄豆、花果**含漫剧（红果走自有双频道接口；黄豆有"国漫"分类如《牧神记》《凡人190》；花果有条目《工资真相-动漫合集》），其余 16 个全是真人短剧——所以"漫剧次元"的实际内容由这三个源决定。**已知限制**：guo-core 的 `catalog` 不接收频道参数（请求体只有 source/category/query/page/force），除红果外同一个源在两个 tab 返回同一份数据，这是源的限制而非前端可修的。
- **多源聚合：单源失败不再拖垮整页**：聚合用 `Promise.allSettled` 逐源收口——实测网果 403（站点要求浏览器验证）、发果 444、皮果 492，若 fail-fast 则用户看到的是"整个 tab 空了"而不是"少一个源"。合并按 id 去重（不同站转载同一部剧时卡片标出来源即可，网格不该出现两张一样的卡）。全部源都失败才报错。
- **翻页游标改为按源维护**：聚合下"第 2 页"不再是单一状态，原来那对 `nextCursor`/`nextPage` state 在多源下会互相覆盖。改为 `pagingRef` 逐源推进，某源到底（`page: 0`）就跳过它、其余继续翻——否则一个只有 30 条的源会把整页无限滚动卡死。连带删掉两个预取 effect（预热另一频道、预取第 2 页）：它们各自假设"单源单请求"，聚合下要么算错缓存键、要么变成 N 倍请求，而 ExploreView 的 1200px 预加载窗口已经足够掩盖这一跳。
- **搜索相关度从 2 级升到 5 级，补上归一化与同系列分季升序**：原 `rank_search_items` 只有"标题含完整关键词=0 / 其余按未命中字数"两档，且**不做归一化**（全角关键词、标点差异全部失效），也**不识别分季**。搜「聚宝仙盆」时第三季会排在第一季前面——用户点进详情自然像"下载了错误的剧"。现在分级为 完全相等 0 / 前缀 1 / 包含 2 / 全分词命中 3 / 其余 4（移植 guoapp 的 `hongguoTitleSearchRank`），同 base 同量词的条目按季号升序。归一化用手写 std 实现（`is_alphanumeric` + 全角 ASCII 减 `0xFEE0` + `U+3000`），**不引入新 crate**：为搜索排序加一个 unicode 归一依赖不值当。全角标点的关键词归一后会是空串，此时回退 trim+小写——否则所有标题会并列判成"同级命中"而丢掉区分度。
- **分季主动补齐（全局最多 2 次回查）**：此前搜主标题时分季条目只能靠 App 联想"碰运气"补，红果官网的模糊匹配经常只吐中间几季。移植 guoapp 的 `completeHongguoSearchSeasons` 思路：解析 `第N季/部` 后缀（中文数字十/百进位手写解析），对"已知 ≥2 季、缺最大季号"的系列用 `<剧名>第N<量词>` 回查，缺头则补最小季号 −1。**硬上限 2 次**：TTV 每次网页搜索都是真实 HTTP 请求且用户在搜索页干等，guoapp 敢调 32 次是因为它常驻进程且有单飞+5 分钟缓存——缓存本轮落地后这个上限可放宽到 4（已写在代码注释里）。补查失败静默忽略，不改变本次搜索的成功/失败语义。
- **搜索结果加 5 分钟缓存**：`catalog_fast_search` 与 `catalog_suggest` 各挂一张 `Mutex<HashMap>` 表（TTL 300s、容量 128 超限整体清空、不做 LRU）。此前点搜索历史、重搜同一个词都要重打后端，而联想那一路每次要冷启动一个 Python 进程（实测 0.6–1.9s）。key 编码命令名/source/channel/keyword/page/page_size；**无关键词的目录浏览不缓存**——浏览必须永远拿最新。锁只 `get`/`put` 同步块内持有，不跨 await。
- **搜索不再被浏览页选中的源卡死**：`SearchView` 原先把 `useCatalogStore().source` 拼进 filter，导致在发现页选了黄豆之后搜索也只搜黄豆——换个源就换个搜索结果。现在搜索恒走全源（`source` 传 undefined，走后端三路合并），选源只影响浏览。
- **来源与降级在结果页可见**：`merge_search_sources` 把动漫源失败等情况写进 `CatalogPage.source` 尾部（如"红果官网搜索 · 词；动漫来源暂不可用"），结果页显示为副标题。⚠️ 判定降级只能靠字符串词表（`不可用`/`可重试`/…），用户搜的词本身含这些字会把正常来源行染成琥珀色——补一个 `degraded: bool` 字段可根治，本次未改 `models.rs` 故未做。
- **顺带修掉两处让 `npm run build` 直接失败的半成品**（guoapp 接入那批遗留；`tsc --noEmit` 在有 `tsbuildinfo` 时会漏报，CI 上必然炸）：`ExploreView` 仍 import `guoSources.ts` 早已删除的 `visibleGuoSources` / `isAdultGuoSource`（新 API 是 `enabledSourcesForTab`），以及 `DEFAULT_SETTINGS` 缺 `UserSettings.enabledSources` 必填字段。
- **guo 目录接上 guo-core 自己的磁盘缓存（实测 2885ms → 0.8ms）**：`guo_provider.rs` 的 `catalog` / `categories` 此前**硬编码 `"force": true`**，直接绕过了 guo-core 内部的磁盘缓存——实测 `%LOCALAPPDATA%` 下那份 `catalogs.json` 已经写到 527KB，**一直在写、从来没有被读过**。现在改为 `cached` 探针（不带 force）→ 命中即返回 → 未命中才回落 `force: true` 拉一次并写缓存。本机实测（临时目录 + 拷贝的真实缓存，不碰开发数据）：冷 `cached` 0.08ms 判未命中 → 网络 `catalog` 2884.64ms / 72 条 → 热 `cached` 0.92 / 0.82 / 0.74ms 判命中 / 同样 72 条。
  - **判据必须是 `fresh`，不能是"结构完整"**：最初的设计是"`cached` 返回的响应只要结构完整就采信"，实测这会造成**永久空白死锁**——冷缓存时 `cached` 返回 `fresh=false` + `items=[]`，直接返回意味着缓存永远不被填充，下次还是这条空结果。`fresh` 是 guo-core 自己给的"这份缓存可信"结论（items 非空 && 无 warning && `updatedAt` 非零 && 距落盘 < 15min `nativeCatalogTTL`），items 为空时它必然为 false。抽成纯函数 `cached_is_usable` 覆盖 6 种输入。
  - **顺带纠正两个文档性误解**：`cached` **不接收 `page` / `query`**（只吃 `source` + `category`），所以搜索和第 2 页以后仍然直走网络；`cached` **也没有 `total` 字段**（`total` 是 `map_page` 自己按 `items.len()` 算的）。
- **搜索结果的"降级"从字符串升级为结构化字段**：`CatalogPage` 加 `degraded: bool`，`main.rs::merge_search_sources` 把判定收成具名布尔（当前唯一条件是动漫源那路返回 `Err`；App 联想返回空**不算**降级——联想失败与"这词本来就没联想"共用同一个 `Vec`，算进来会把绝大多数正常搜索误标）。`SearchView` 删掉 `DEGRADED_MARKERS = ['不可用','已跳过','可重试','失败','超时']` 这套字符串词表，改读 `page.degraded`。**词表本来就是错的**：用户搜"失败"或"超时"就会把正常来源行染成琥珀色。`page.source` 文案保留不变，用户仍能看到"哪个来源不可用"。
- **删掉卡片上的两处伪造内容**：`SeriesCard.tsx` 顶部徽章在标签缺失时写死「热门」、副标题在标签不足时写死「精品短剧」——**这是在伪造内容热度与质量**（与 §5 不变量 8「不把不存在的档位显示成可用」同类）。改为**取不到就不渲染**（中性词如"短剧/漫剧"是零信息量：频道已由徽章配色、封面占位字、悬停色三处表达；"精品"则是在断言入选与质量状态）。副标题那处影响面更大——**只有 1 个标签的卡片（很常见）会整片显示"精品短剧"**。
- **`SeriesItem` 补 `rating` 字段，并接上红果的真实评分**：前端 `types/catalog.ts` 与 `SeriesCard.tsx` 早有评分角标，但 Rust 侧根本没有这个字段，真实数据下永远是空的（只有演示数据出现过）。
  - **结论要如实说：红果只在详情页给评分，所有列表/搜索/榜单页一个都没有**（实测逐页抓取：`/category/real-drama`、`/category/comic-drama`、题材页、榜单页均无；唯一来源是 `/detail` 的 `loaderData.detail_page.seriesSocialInfo.rating`，0-10 量纲，7.8/8.3/8.7/9/9.6 且整数与浮点混发）。而 `SeriesItem` 由列表/搜索产出，**所以卡片评分角标在真实数据下仍然是空的——这是站点事实，不是解析漏了**。已接上 `parse_search_items`，站点哪天补上就自动亮。
  - **刻意不认 `score` 键**：`/search` 的 `video_data.hot_score_data.score = 44456111` 是**热度**不是评分（配套文案"4445万热度"），键名撞车；认了就会把 44456111 显示成"44456111.0 分"。超 0-10 量纲的值一律 `None`（防站点改量纲后显示"87.3/10"），解析失败**绝不填 0**——0 分会被渲染成"0.0 分"，同样是伪造。
  - `degraded` 在 `provider.rs` 的取值是逐路径判定的：`catalog_index` 的"单页失败不整体失败"跳过页 = 真的搜不到（`index_degraded` 连同条目存进 `CatalogIndex` 缓存，否则只有冷启动那一次会亮）；题材词表挂掉但内容可用 = `true`；`anime_provider` 是单来源单请求、失败即整体 `Err`，填 `false`。
  - 顺带修掉一个真缺陷：只加 `#[serde(default)]` 时 `rating` 会序列化成 `"rating": null`，而 `types/catalog.ts` 的 `rating?: number` 在 `strictNullChecks` 下不合法——补 `skip_serializing_if = "Option::is_none"`（沿用本文件 `PlaybackSession.backup_url` 的既有惯例）。：这三处此前各手抄了一份，且确实长得不一样——**搜索页那版没有 `MicaCard` 的玻璃底**，信息区是 `px-1 pt-2.5 pb-3 bg-transparent`（标题不随断点放大、悬停不变色）、悬停播放盘是白底蓝图标而不是 `fluent-convex-disc`、网格 2xl 档少一列、无评分角标。差异不只是观感：搜索页**漏了 guo 封面的 `resolveSrc` 异步解析**，而 guo 源的封面直连不可用（Cloudflare/加密，见新增条目），所以**在搜索里搜到的 guo 剧封面永远只能显示首字占位**。现在抽出 `src/components/common/SeriesCard.tsx` 单份实现 + 导出 `SERIES_GRID_CLASS`（连骨架屏也共用），三处共用，净删约 130 行重复。频道差异（徽章与悬停色蓝/紫、占位首字「剧/漫」、底部集数文案逻辑）全部由 `series.type` 推出，不加变体 props——数据本身已带频道。评分角标改为三处统一按 `series.rating` 有值即显示（动漫源本就无该字段，视觉不变）。历史/收藏是横排列表，设计如此，未动。

### 验证

- `npx tsc --noEmit`、`npm run build`、`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --bins` 已通过（**78 项测试通过**，6 项联网/真机测试按既有规则忽略）。搜索改进 + 缓存/评分 + FFI 转发 + 缺陷修复四轮共新增 26 项纯逻辑测试（相关度分级 / 全半角归一 / 分季解析与补齐计划与中文数字拒绝 / 搜索与联想缓存 / 评分量纲与越界拒绝 / `cached_is_usable` 六种输入 / sequence 单调性与越界 / 会话表 retain 与选取 / 源任务轮询终态），全部不联网。⚠️ 验证时须先删 `tsconfig.tsbuildinfo`：`tsc` 的增量缓存会让上一轮的错误**漏报**通过（已因此假绿过两次）。
- **搜索缓存与 guo 目录缓存的已知取舍**：`catalog_fast_search` 的 5 分钟缓存缓存的是整个 `CatalogPage`（含 `degraded`），源恢复后仍会显示琥珀色最多 5 分钟；`cached` 探针让每次列举多一次 FFI 往返（~0.8ms，对 2885ms 是净赢）且共用那把全局单锁。guo 源**第 2 页以后仍走网络**（`cached` 不认 page/query），且 `saveCatalogCache` 会在第 1 页刷新时把旧条目追加到末尾、顺序不稳定——分页该在 guo-core 侧切，不该在 Rust 硬凑。`catalog_refresh` 已就绪但尚未接到任何 Tauri 命令（用户暂时无法手动绕过 TTL；健康度面板的"检查"是另一条路，它会重跑体检并写回源记录）。
- **guo 侧评分仍然拿不到（负面结论）**：解析已按 0-10 量纲校准（`"9.0分"` → `9.0`，`44456111` 这类热度值与越界值一律 `None`），但 **`guo-core/core/app_runtime.go:207-231` 的 `nativeNormalize` 没有把 `Drama.Score` 复制进 `nativeDrama`**（该结构体只有 `heat` / `views`，没有 Score 字段），所以走随包 0.2.17 DLL 的目录这条路实际恒为 `None`。guo-core 哪天透出评分即可生效，代码这边不用再动。
- **源健康度尚未在 Tauri 窗口里实测**：依赖 guo-core 的运行时行为（源体检要真连站方），单测覆盖不到。需实测两件事——① 面板对某个已知坏源（如网果/发果）是否如实显示失败步骤；② 「检查」是否会在源被别的任务占用时给出可读提示而不是一直转圈。
- **分季补齐尚未在 Tauri 窗口里实测**：补查走的是红果官网 `/search/{剧名第N季}`，而 guoapp 那边补的是 App 名称联想接口（更准）。站点对"剧名第N季"这种词的模糊匹配若很弱，补查会静默返回空——需在窗口里搜「聚宝仙盆」确认是否真的补齐。若无效，改成把补查词交给 `catalog_suggest`（那条已有 5 分钟缓存，成本可控）。
- guoapp 侧已实测 11 个外部源真实首帧解码、红果短剧/漫剧 CENC 解密播放和真实画质切换。
- TTV 侧（2026-09-29 修复后）实测：DLL 层黄果视频 `category=""` 返回 40 部、分类 ID 返回 20 部，`id→name` 映射正常；Tauri 窗口里黄果 AI / 黄豆 / 野果目录均加载成功（野果 120 条），野果首集播放并写入历史。
- **已知边界（不是档位探测缺失）**：红果漫剧的低档位（360/480/540/720）实测为 bytevc2（H.266）编码——`ffmpeg -i` 对样本报 `unknown codec (bvc2)`，WebView2 亦无 H.266 解码能力——worker 跳过它们是对的：画质菜单只剩 1080P（HEVC）一档并禁用切换，这是源的真实编码分布（聚宝仙盆第十二季第 15 集实测 5 档中 4 档为 bvc2）。
- **连播预取与卡死修复复验（2026-09-30）**：`npx tsc --noEmit` 与 `cargo test --bins`（87 项）通过；预取 m3u8 URL 搁置 150 秒后实测仍 HTTP 200（TTL 足够覆盖一集间隔）；`usePlaybackStore.tsx` 编辑后 dev 日志只出现干净的 HMR update、不再整树 invalidate。**连播 42→43 集场景需在 Tauri 窗口里复验**：确认播完即接续下一集；若预取未命中，起播最迟 8 秒后应落到错误卡或自愈重载，而不是永久停在旧帧。

## 0.2.12 - 2026-09-28

### 修复

- **切换下一集后播放倍速回到 1x**：短剧/漫剧和动漫播放器在换集时把 `playbackRate` 写在新源挂载之前，媒体装载完成后倍速可能被重置；部分异步动漫换集路径还读取了滞后的 React state。现在两条播放链路都在新源就绪后按 `playbackRateRef` / `rateRef` 恢复用户倍速，自动连播、手动下一集和小窗回流都沿用当前设定。

## 0.2.11 - 2026-09-27

### 修复

- **小窗自动连播切换下一集固定等待 5 秒**：`MiniPlayer.handleEnded()` 在视频结束后先按 `handoff.countdownSeconds || 5` 创建 1 秒读秒定时时器，倒计时归零才调用 `playEpisode()`，因此用户看到的是“播完等 5 秒才进下一集”。现在小窗自动连播在 `ended` 后直接解析并播放下一集，不再展示或等待读秒；主播放器的连播倒计时链路保持不变。

## 0.2.10 - 2026-09-22

### 修复

- **没装「动漫共和国」客户端的机器上，动漫专区整体失效**：详情页只剩一个标题，徽章显示「共 0 集全」，选集格子全空。根因是**来源路由把暴风兜底源的剧集送进了红果链路**。暴风的 `vod_id` 与红果的 `series_id` 都是纯数字（`provider.rs` 的 `validate_numeric_id` 只校验数字），格式完全相同；而 `series_detail` / `playback_open` 的动漫判定是 `channel == "anime"` **或** id 以 `dmghg:` 开头——走正式源时 id 自带前缀、判定可靠，走暴风兜底时 id 是裸数字，判定就全押在前端 `channelBySeriesId` 这个**内存 Map** 上。这个 Map 在应用重载后是空的，从收藏 / 历史进入也不会填（那些入口只传 id）。于是暴风的数字 id **通过了**红果的 id 校验，撞号查到红果同 id 的一部剧，而那部剧的 `vid_list` 是空的——于是只剩标题、`episodes_count = 0`。开发机上一切正常，只是因为那台机器装着客户端、走的是带 `dmghg:` 前缀的正式源。
  **判定依据**（一条很硬的证据）：详情页显示的是「共 0 集全」而不是「单集/已完结」——`DetailView` 只在 `detail.type !== 'anime'` 时才渲染前者，而动漫链路返回的 `item_type` 恒为 `anime`。显示前者就等于证明 `detail.type` 是 `drama`/`comic`，即数据来自红果链路。
  修法是让 id 自己携带来源：暴风 id 统一带 `bfzy:` 前缀（与 `dmghg:` 对齐），`series_detail` / `playback_open` / `anime_qualities` 一并认这个前缀。路由从此不依赖任何易失状态，顺带解决 `merge_search_sources` 按 id 去重时红果与暴风撞号会静默丢掉一条的问题。另有两点配套：`detail` / `open_episode` / `qualities` 改为**按 id 前缀**分流、不再看 `use_dmghg()`——id 跨会话持久，而源可用性只在进程内算一次，历史里存着上次会话生成的 `dmghg:` id 时，按 `use_dmghg()` 会把它当暴风 id 去查（两套数字 id 互不相通），现在改为前缀指向的源不可用就如实报错，比静默串源好排查；历史 / 收藏加载时回填 `channelBySeriesId`，让加前缀之前生成的旧裸数字 id 仍能正确路由。
- **动漫封面一张不剩**。暴风的封面域名 `img.bfzypic.com` 与播放域名 `p.bvvvvvvvvv1f.com` 实测都解析到 `193.148.95.x`（境外 IP），而 API 域名 `bfzyapi.com` 走 Cloudflare——所以列表能出标题，唯独封面全挂。同一台机器上浏览器打得开这些图、应用里 `<img>` 却超时，差异只在**走没走系统代理**。现在封面与 m3u8 共用同一个本地代理端点（`/stream` 本就是通用 http(s) 转发器，二进制分支透传上游 `Content-Type`），由挂了系统代理的 Rust 侧出网；封面请求同时改为不发 Referer（图床普遍按 Referer 做防盗链，而 WebView2 里 `<img>` 的 Referer 是应用自身地址，最容易被当盗链）。
  实测：`img.bfzypic.com` 与 `p.bvvvvvvvvv1f.com` 的 A 记录同为 `193.148.95.186` 等，而 `bfzyapi.com` 为 `172.67.190.220` / `104.21.92.88`；封面 GET 返回 200（26755 字节、`image/jpeg`），三种 Referer（无 / `bfzyapi.com` / `127.0.0.1:5175`）均放行——即这张图本身可达，问题在网络出口而非防盗链（首次探测得 403 是因为误用了 HEAD 方法，不是防盗链）。

- **封面走本地代理后，历史 / 收藏里的封面下次启动全挂**（本次改动自查发现的回归，未流出）。落历史时存的是 `currentSeries.cover`，而它已被改写成 `http://127.0.0.1:{port}/stream?u=…&t=…`——代理端口是 `bind("127.0.0.1:0")` 随机分配、令牌是 `Uuid::new_v4()`，**两者每次进程启动都不同**，于是写进库里的封面地址跨会话即死链（403 令牌无效），表现是「历史里的封面一夜之间全空」。现在收口在存储层做双向转换：**落库前 `restore_image_url` 还原成原始地址，读出后 `proxied_image_url` 才改写**，库里永远不会出现代理地址。补一条往返单测锁住「还原是改写的逆操作」——顺带踩到 `tokio::runtime::Builder::new_current_thread()` 默认**不带 IO driver**，`TcpListener::bind` 直接 panic，测试 runtime 必须显式 `.enable_io()`。

### 优化

- **业务侧 reqwest 统一挂系统代理**（动漫源、HLS 代理、红果抓取）。reqwest 只认 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量、**不读 Windows 的「Internet 设置」**，这个坑上次只在下载器上补了，理由是「其他链路都是国内源」——**该结论被上面的实测推翻**（暴风的封面 / 播放域名就是境外 IP）。顺带把转发器的缓存策略改为优先沿用上游 `cache-control`：封面这类小图必须让浏览器缓存（列表卡片的封面会反复进出视口），ts 分片上游一般不给 `cache-control`、回退 `no-store`，行为不变。
  已知边界：若那台机器既直连不通境外 IP、又没配可用的系统代理，封面仍然加载不出来——本地代理无法凭空创造连通性，这种情况需要用户侧配好系统代理（Rust 侧现在会自动读取并使用）。

## 0.2.9 - 2026-09-19

### 新增

- **设置页的「检查更新」**：从 GitHub Releases 拉取最新安装包。网络请求全部由 Rust 侧发出（`src-tauri/src/update.rs`）——前端的 CSP 是收紧的且**只在生产构建注入**，“浏览器里试通、打包后才挂掉”是这类功能的经典翻车方式，而走 reqwest 既不碰 CSP、也不把 GitHub 域名暴露给页面。
  下载只落到系统下载目录（先写 `.download` 临时文件、成功才改名，中途失败不会留下一个“看起来是安装包”的半截文件），完成后**只打开资源管理器定位到包，不会自动安装**——静默运行一个从网上下载的可执行文件是这类功能最不该做的事。
  几处刻意的限制：版本比对按段比数字（`0.2.10` 必须大于 `0.2.9`，字符串比较会判反）；下载地址限定 GitHub 发布域名（参数来自页面，不加限就等于给了一个任意下载能力）；文件名净化掉路径穿越；“打开文件夹”只允许打开下载目录内的文件。
  实测（真实窗口 + CDP）：`app_version` 与三处版本号一致；仓库未公开时 API 返回 404，错误文案如实说明“可能尚未公开或还没有发布过 Release”——没有拿一句笼统的“检查更新失败”把可诊断的信号藏起来。
- **画中画小窗（独立置顶窗口）**。控制条右侧新增「画中画」按钮（两个播放器共用同一个入口），把正在看的这一集交给一个**独立的无边框置顶小窗**继续播：小窗可拖动、八向拉伸改大小（最小 264×148），自带播放/暂停、上一集/下一集、进度条、音量、连播倒计时，以及两个出口——“回到播放器”与“关闭小窗”；主窗口在小窗打开期间可以正常浏览发现/收藏/历史/选集，也能直接最小化。
  形态上刻意**不做应用内浮层**：主窗口一最小化浮层就跟着消失，想一边看剧一边用别的软件更是不可能，只有真正的独立窗口（`alwaysOnTop` + `skipTaskbar` + `decorations: false`，拖动与缩放交给前端 `startDragging` / `startResizeDragging`）才成立。
  **播放权同一时刻只属于一个窗口**：仓库里“两块 `<video>` 同时活跃”曾经造成两个声音与 MSE 互相抢占，所以交接做成接力——主窗口先 `pause()` 再把播放权交出去，小窗打开期间主窗口一旦要自己起播（用户点了某一集）就先 `pip_dismiss()` 把小窗收掉；关闭小窗时按最后上报的秒数接回播放器（短剧/漫剧命中整集缓存即秒开，动漫重新解析一次直链）。
  交接包里传的是**身份 + 播放参数**（seriesId / episodeId / 秒数 / 音量 / 静音 / 倍速 / 连播设置 / 集列表），**不传播放地址**：动漫链路主窗口上挂的是 hls.js 的 MSE `blob:`（跨窗口根本用不了），短剧链路的本地文件地址也深埋在播放 store 的 ref 里，所以小窗用同一条 IPC 命令自行解析，每个窗口只对自己那条媒体链路负责。小窗可能自己连播到了下一集，因此进度回传带的是“此刻真正在播的那一集”，主窗口据此落历史（观看进度不会因为在小窗里看了半小时而丢掉）。
  顺带修掉一个同类快照问题：`usePlaybackStore` 的音量/静音/倍速在起播链路里是**在异步续体里**写进媒体元素的，读 state 拿到的是发起起播时那份快照。从小窗回播放器是“同一 tick 先 `setVolume`/`setMuted` 再 `openEpisode`”，用快照会把元素写回旧值——表现就是“在小窗里静音了，回到播放器第一声却是外放的”。现在这三个值多了 ref 镜像，起播链路一律读 ref（动漫播放器一直如此）。
  已知边界：两个窗口各自持有一份前端会话号计数（都从 100 起），靠“播放权唯一”避开撞号（`playback_command` / `playback_snapshot` 前端并未使用）；若将来允许两路同时播，会话号需要收口到后端。
  **真实窗口内实测**（走同一套前端代码，经 WebView2 的 CDP 端口采集）：短剧/漫剧链路点「画中画」→ 小窗默认 420×236 贴在屏幕右下角，数秒内自动续播（`videoWidth=1920` / `paused=false`）；小窗自行连播第 5 → 第 9 集，关闭后历史正确落到"此刻真正在播的那一集"（第 9 集、13s），而不是交接时那一集；点「回到播放器」后主窗口接着同一集同一秒播（`101s`），且小窗里接下的静音被一并接回（`video.muted=true`、`volume=0`）；小窗开着时在主窗口点某一集，小窗被 `pip_dismiss` 收掉（`pip_is_open` 由 true 变 false），两路声音不会同时响；`WM_GETMINMAXINFO` 回报 `ptMinTrackSize = 396x222`（即逻辑最小尺寸 264×148 × 150% 缩放），缩放拖到临界值即止。
- 修正「检查更新」把版本号显示成 `vv0.2.9`：GitHub 的 tag 本来就是 `v0.2.9`，前端又统一按 `v{版本}` 渲染了一次。现在在 Rust 侧把 tag 的 `v` 前缀归一化掉（发布标签的习惯不该泄漏到展示层）。
- 修正「下载安装包」在本机开着系统代理时直接失败：reqwest **只认 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量，不读 Windows 的「Internet 设置」**，而本机代理是写在注册表里的 `127.0.0.1:10808`。这造成一个很迷惑的现场：`api.github.com` 直连能通（所以"检查更新"看起来一切正常），但资产下载域名 `objects.githubusercontent.com` 直连失败，只报一句 `error sending request`——**同一个地址用 PowerShell 下载却有 4.88 MB/s**。现在下载客户端会读 HKCU 的 `ProxyEnable` / `ProxyServer` 并挂上代理（`host:port` 与 `http=…;https=…` 两种写法都认），失败信息也带上 reqwest 的 source 链，不再只给一句笼统的提示。实测修复后完整下完 76.62 MB 的安装包，102 次进度事件、`percent` 从 0 递增到 100，文件正确落在系统下载目录。

### 优化

- **搜索首屏不再等 App 联想**。搜索此前把红果网页、动漫源、App 联想三路放进同一个 `tokio::join!` 里等结果，而联想每一发都要冷启动一个 Python worker 进程（代码里实测端到端 0.6-1.9s）——网页搜索 0.3s 就绪，用户却要盯着"搜索中…"再等一秒以上。现在拆成两段：新增 `catalog_fast_search`（只跑两个结构化来源）先把首屏画出来，联想由新的 `catalog_suggest` 命令随后按 id 去重追加到结果尾部。`catalog_list` 的三源并发语义保持不变，其他调用方不受影响。
- **搜索加 300ms 防抖**。旧实现每敲一个字就发一次全量搜索，而每一发在后端都要冷启动一个 Python 进程跑联想——打字快时等于连开好几个进程。现在停手才发，且关键词一变立即作废在途请求，旧响应不再往屏幕上画。
- **点题材不再现场抓两次网络**。题材名要先换成子路由 slug，为此每次点题材都得先抓一次 `/category/{segment}`、再抓题材页，两次串行往返都压在用户的点击路径上。现在目录首屏返回后由 `warm_theme_routes` 后台预热两个频道的题材路由（命中缓存时只是内存查表），点击时只剩题材页一次往返。
- **题材页加 60s 结果缓存**。来回点 A→B→A 此前是三次完整抓页 + 解析（每页约 280KB）。实测同一题材第二次命中缓存：**199.3ms → 26.4µs**（`theme_catalog_live` 里打点）。TTL 刻意只有 60s——题材页是实时排行，久缓存会让新上的剧进不来。

### 修复

- **点题材后"看着像没反应"**。切换期间旧卡片原样留在屏幕上，只有一行 11px 小字提示，用户以为点击没生效。现在保留旧卡片（清空会整页闪白）的同时压暗并屏蔽点击，另外挂上明确的"正在切换"指示；压暗同时表达了"这张卡不再属于当前筛选"，避免用户点进一个已经不属于该题材的剧。
- 修正 `catalog_list` 里一处与代码不符的顺序注释：实际追加顺序是「网页 → 动漫 → 联想」，原注释写反了。
- **分类栏里混进了剧名**（"你让我当牛马我在荒岛成王第一季""破库房的秘密"这类）。目录卡片解析靠"这段文本 != img alt"来剔除标题，但站点同一部剧在不同位置的空格并不一致——实测某张卡的 alt 是 `你让我当牛马我在荒岛　成王第一季`（中间一个 U+3000 全角空格），而卡片标题元素里没有空格：精确比较漏判，于是整条剧名被当成题材标签收下，再跟着前端"只增不减"的题材词表**永久**留在分类栏（切频道、重进发现页都还在——词表只在内存里累加、从不清减，所以一旦混入就再也甩不掉）。现在标题优先从卡片自己的标题元素读（`pc-title-*` / `m-title-*`，img alt 只作兜底），标签判定先做空白归一化，并要求文本是纯字词（真题材词是"爱情""无限流"这种，而剧名常带"，""！"）。新增两条单测 + 一条联网护栏；实测漫剧第 10 页（当初出事的那一页）解析结果已干净。
- **关闭小窗后声音还在响（"关不干净"）**。根因有两层，叠在一起才致命：
  ① **窗口被隐藏后音频不会停**。这是 Chromium 的标准行为（后台/隐藏页面不因不可见而暂停音频），而**页面的 `document.visibilityState` 仍然是 `visible`** —— 前端因此没有任何可用的判据去发现"我已经被藏起来了"。实测（对一个正在播放的小窗用 `ShowWindow(SW_HIDE)` 只隐藏不销毁）：`video.paused` 仍为 `false`、`currentTime` 从 51.4s 持续跑到 72.2s（21 秒）、`visibilityState` 报 `visible`，CDP 里目标也还活着。
  ② **"声音停掉"完全依赖销毁 webview，而销毁不可靠**。旧实现是 `hide()` 然后异步 `destroy()`，并把错误 `let _ =` 吞掉；只要 destroy 延迟或失败（主线程正忙、"主窗口点某一集"与"小窗正在销毁"撞在一起等），窗口就停在"已隐藏但仍在播放"——用户听到的就是关不干净的尾巴。最典型的触发路径是 `pip_dismiss`：主窗口要自己起播时直接收小窗，**小窗页面从头到尾没有 pause 的机会**（点 X 的路径至少还有 `leave()` 里的 `pause()` 兼一下）。
  现在把"停播"从"销毁窗口"里拆出来单独做：`destroy_window` 先注入一段脚本（`pause()` + 清 `src` + `load()`）→ 再 `hide()` → 留 150ms 让媒体管道排空 → 最后才销毁；销毁失败不再静默，退一步用 `close()` 并把原因写到 stderr（此时声音已经停了，最坏只是窗口没销掉）。系统关闭路径（Alt+F4 / 任务栏）补在同一处的 **`CloseRequested`**：这是唯一还来得及注入脚本的时机，`Destroyed` 是事后的、webview 已经没了。
  另外补上一个自己看出来的竞态：那 150ms 里用户可能又点了"画中画"（`pip_open` 会 `show()` 复用仍在的小窗），此时若照常销毁，用户看到的就是"点了画中画，小窗闪一下就没"，而主窗口已经离开播放器。现在销毁前先看窗口是否可见，可见就认作"刚被重新启用"并收手。
  验证（三条关闭路径逐条走真实窗口 + CDP）：在小窗里挂 `emptied` 监听作为"停播脚本确实跑到了"的凭据，点 X、`pip_dismiss`、Alt+F4 三条路径各捕获到一次 `emptied`（`emptied` 只在源被移除并 `load()` 时触发，别处不会产生）；`pip://returned` 仍正常到达且 `mode` 正确（`close`），`pip_is_open` 由 `true` 正确翻成 `false`；"`pip_dismiss` 后立即 `pip_open`" 的竞态用例里小窗存活并重新播放，没有被那 150ms 的销毁带走。
- **画中画小窗停在空白页（`pip_open` 是同步命令）**：Tauri 的同步命令跑在**主线程**上，而 `WebviewWindowBuilder::build()` 在主线程里会内联执行窗口与 WebView2 的创建，创建过程又需要事件循环继续泵消息——两边互等，于是这次 IPC 调用永不返回，小窗的 webview 停在 `about:blank`。实测现象：小窗窗口确实出现了（标题 `TTV 画中画`、`WS_THICKFRAME` 已在），但里面一片空白，前端 `await openPip(...)` 一直 pending，控制条上的画中画按钮点了没反应。改成 `async` 命令后命令跑在异步运行时线程，Tauri 把创建请求投递回主线程，两边都不再互等；实测 `pip_open` 立即返回 `ok`，小窗几秒内完成渲染与起播。
- **小窗交接后停在首帧不动（WebView2 省电暂停）**：小窗刚创建、还没有前台激活权限，首次 `play()` 几乎必定撞上 WebView2 的省电策略（`AbortError: video-only background media was paused to save power`），而小窗的常态就是"别的窗口在前台"，这个状态会一直持续。实测：主窗口已 `pause()`、小窗稳定停在 `paused: true` 的首帧上，手动 `play()` 立刻成功——用户看到的就是"点了画中画却没有在播"。只挂 `focus` / `visibilitychange` 监听不可靠（窗口被遮挡不一定改变 `document.visibilityState`、也不一定发原生 focus），现在改成**意图驱动 + 周期重试**：只有在"用户意图是播放 + 确实暂停 + 文档可见"时才续播，上限 50 次（约 30 秒）；用户主动暂停、播完、退出手势都会先把意图置假，绝不会把有意按下的暂停又自动打开。
- **个别卡片没有封面（点进详情页是一块白框）**。根因在**源站数据**，不在我们的解析：dmghg 部分条目的 `pic` 指向与源站无关的第三方图床——`dmghg:184574`（奥特Q）给的是 `spore-mall.cdn.bcebos.com/avatar-mall/...png`（HEAD 实测 **404**）、`dmghg:194837`（怪奇物语 第四季）给的是抖音电商 CDN `p3-aio.ecombdimg.com/obj/ecom-shop-material/...`；而同一批里正常条目（`dmghg:181412` 剑来）给的是 `p2-ad.adukwai.com/udata/pkg/*.jpg`。
  为确认能不能绕开，新增诊断测试 `dmghg_dump_raw_detail`（默认 ignore）把源返回的**全部图片类字段**打出来：详情里**只有 `pic` 一个**封面来源（无 cover / img / image 等备用字段）。也就是说既无法从源头修，也无从从别处补——能做的只有让界面优雅降级。
  而当时**只有列表卡片**有兜底（AnimeView / ExploreView / SearchView 各写了一遍同一套“失败重试一次 → 隐藏图片露出剧名首字”），**详情页的 Hero 海报、卡片展开动画的海报、收藏与历史列表的小图都是裸 `<img>`**：源站给了坏地址就整块留白（海报父容器还是 `bg-white`，白底白框尤为刺眼）。
  现在把这些位置**全部收口到 `CoverImage`**（`src/components/common/CoverImage.tsx`）：占位层始终铺在最底层（地址为空 / 仍在途 / 被源站拒绍都不会留白）、失败带 `?r=1` 重试一次、重试仍失败才隐藏图片；同时把三份重复的兜底实现也合并了。
  验证（真实窗口 + CDP）：进入 `dmghg:184574` 详情页，Hero 海报 `img.style.opacity === '0'`、其下方渲染出 `text-5xl` 的“奥”字占位（白框消失）；动漫专区视口内 16 张卡片的封面全部 `naturalWidth > 0`。
- **封面“顽固地加载不出来”——图其实已经下载好了，只是被永久藏住**。上一版给封面加了兜底（失败重试 + 首字占位），但用户反馈“滑到下面还是有的加载不出来，很顽固”。用 CDP 查图片对象状态才看到真相：**好几张图 `img.complete === true`、能正常解码，元素的 `opacity` 却永远是 `0`** —— 它们一直在页面上，只是永远不可见（实测动漫专区滚动后固定有 8 张卡在这个状态）。三个叠加的缺陷：
  ① **命中缓存的图片收不到 `onLoad`**。同一张封面在前面已经加载过时，`load` 事件可能在 React 挂上监听器**之前**就已经发生过了，事件不会重放，于是 `loaded` 永远停在 false，图片保持透明；
  ② **重置状态的重置 effect 在挂载时无条件执行**（`useEffect(..., [url])`），而命中缓存时 `load` 跑在 passive effect 之前，于是 `onLoad` 刚把 `loaded` 置真、紧接着就被重置改回假。两个缺陷方向相反、结果相同。
  现在在每次渲染提交后**主动核对一次元素真实状态**（`img.complete && naturalWidth > 0` → 当作加载成功；已完成但没像素 → 走重试），把漏掉的事件补回来；重置只在**地址真的变了**时执行（用 ref 对比上一个地址）。
  ③ **重试时的 cache-bust 会弄坏一部分地址**：上一版无条件拼 `?r=N`，而百度图床那类地址把参数写在路径里（`/gimg/app=2001&n=0&fmt=webp&src=xxx.jpg`，整个 URL 里没有 `?`），拼上去会把 `src` 参数污染成 `xxx.jpg?r=1`——本来只想绕过失败缓存，结果把一次抖动变成永久失败。现在只在 URL 确实带 `?` 时才追加参数。
  同时把原生 `loading="lazy"` 换成**自管懒加载**（IntersectionObserver，提前一屏预载）：原生懒加载把“何时开始加载”交给浏览器后，我们既判断不了它有没有开始，而在**常驻 DOM + `display:none`** 的卡片宿主里它更不可靠（与“卡片空白”同源）。现在只有进入过预载区的封面才渲染 `img`（实测 150 张卡片只创建 85 个 `img` 元素），图片在 `onLoad` 前一律透明，所以**加载中看到的是首字占位而不是白框**，一旦成功自动浮现。
  验证（真实窗口 + CDP，改前/改后对照）：`complete 但透明` 的图片从 **8 → 0**；逐步滚动到底共 6 轮、150 张卡片，每轮视口内封面均 15/15 加载完成；发现页 25 张 / 历史 34 张卡片同样 `0` 卡死、`0` 不可见。
- **卡片加载后是空白的，鼠标扫过去才显示**。根因在**入场动画**与**常驻 DOM**的交界处，实测结论很反直觉：`animate-fluent-card-in` 的关键帧里带着 `opacity: 0`，而卡片的宿主视图是**常驻 DOM + hidden** 的（`App.tsx` 的视图切换只改 `display`，为的是切换不闪屏）。元素在 `display: none` 的祖先里创建时，Chromium 的动画**永远卡在 `0%` 帧**——它既不在推进、也不被移除：`getAnimations()` 返回空、`animation-play-state` 却是 `running`，而且**`0%` 里的 `opacity` 被当真、`transform` 却不计算**（同一元素实测 `opacity: 0` 而 `transform: none`）。于是那些卡片是**真的空白**，直到鼠标扫过触发重绘/重新合成才现形。
  先按常规怀疑 `animation-fill-mode: both`（backwards 把起始状态应用到未开始的动画上），改成默认的 `none` 后**实测无效**——fill-mode 只管“延迟期间”与“结束后”，而这里是“运行中停在第一帧”。逐 class 二分定位确认元凶就是 `.animate-fluent-card-in`（去掉它 opacity 立刻回到 1）。
  真正的修复是**让入场动画不碰 opacity**：关键帧只留 `translateY(14px) scale(0.97) → translateY(0) scale(1)`。即使动画卡在 `0%`，卡片也只是位移 14px、缩小 3%，**始终可见**；同时因为无 fill-mode，动画结束后不再锁定 transform，被它一直压着的 `hover:-translate-y-1.5`（卡片悬停上浮）也顺带恢复生效。
  代价与取舍：入场不再淡入（仍有滑动与缩放），且调用处不能再加 `animation-delay`（无 fill-mode 时延迟期间元素可见，动画一开始会“闪一下”），五处 `animationDelay` 一并移除，卡片改为同时入场。
  验证（真实窗口 + CDP，改前/改后对照）：改前隐藏视图里的 30 张卡片 45 秒后 computed `opacity` 仍是 `0`；改后同一个位置上全部为 `1`。逐视图抽查共 92 张卡片（发现 25 / 动漫 30 / 历史 34 / 设置 3）**全部 `opacity: 1`**，尺寸与布局不变（卡片 221×359）。

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

附带结论：批量采样分片时不能用 ffmpeg 直接吃 HLS 地址——该源把 TS 分片伪装成 `.png`/`.pdf`/`.wav` 扩展名，ffmpeg 的 HLS 解复用器按扩展名白名单直接拒绝（`URL ... is not in allowed_segment_extensions`），会把好源误判成坏源。采样脚本改为自己按内容嗅探容器后再交给 ffmpeg（该采样脚本已随私有渠道调研记录一并移除）。

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
