export interface UserSettings {
  defaultQuality: '4k' | '1080p' | '720p' | 'auto';
  autoNext: boolean;
  /** 已废弃：增强/补帧链路已移除，仅兼容旧设置记录。 */
  preferredEngine: string;
  /** 已废弃：补帧链路已移除，仅兼容旧设置记录。 */
  targetFps: number;
  /**
   * 是否启用硬件加速（WebView2 的 GPU 合成）。**后端契约字段，前端不提供开关。**
   *
   * 历史坑：`src-tauri/src/models.rs` 的这个字段早于前端存在，而前端 `UserSettings`
   * 一直漏了它。`settings_save` 的入参是**反序列化出来的** `UserSettings`——缺字段
   * 会在反序列化阶段整体失败、命令体一行都不执行（错误只被 `useSettingsStore`
   * 吞成一行 console.warn）。表现为：设置页任何改动都"看起来生效了"（前端内存里
   * 确实变了），但从不落库、重启回到默认，而且 `set_vsr_enabled` 也一并没执行 ——
   * 这就是「开关 VSR 都没用」的另一半根因。
   *
   * 因此这里**必须**与后端保持字段同形，哪怕界面上没有对应开关。
   */
  hardwareAcceleration: boolean;
  catalogCacheMb: number;
  playbackCacheMb: number;
  /** 是否展示 18+ 外部内容源（默认关闭；关闭时首页与搜索都不会出现这些源）。 */
  showAdultSources: boolean;
  /**
   * 用户勾选启用的视频源 id 列表。
   *
   * 默认只有红果：19 个源全开等于首屏并发打 19 个站点，最慢的那个决定首屏时间。
   * 空数组按"未配置"处理并回落到默认集合，避免旧设置记录升级后变成"零可用源"。
   */
  enabledSources: string[];
  /**
   * 启动进入动画是否发声（合成音效 + 入场底噪）。
   *
   * 音频不走任何资源文件，是 Web Audio 现场合成的（`services/launchAudio.ts`），
   * 所以这里只是一个开关键。旧设置记录里没有这个字段，
   * 读取时按 `!== false` 判定（见 `LaunchAnimation`），保持默认开。
   */
  launchSound: boolean;
  /**
   * 是否启用 RTX VSR 播放增强链路（只作用于非动漫的短剧/漫剧）。
   *
   * 开：源流经本地 media_enhance 转成 H.264 分片再喂给 <video>，
   * 让 NVIDIA 驱动触发 RTX VSR（H.264 是本机 WebView2 触发 VSR 的硬条件，
   * 见 AGENTS.md 不变量 25），代价是首次起播要多等一次转码。
   * 关：完全回到未引入 media_enhance 之前的旧链路——直接播原始源 URL，
   * 起播更快，但没有 RTX VSR 增强。
   *
   * 旧设置记录里没有这个字段，读取时按 !== false 判定（与 launchSound 同款），
   * 保持「默认开」——现状默认就走 VSR 链路，默认关等于让老用户行为突变。
   */
  vsrEnabled: boolean;
  /** LibMPV/LSFG interpolation is opt-in and uses 2x when no multiplier was saved. */
  frameInterpolationEnabled: boolean;
  frameInterpolationMultiplier: 2 | 3 | 4 | 5;
  /**
   * 是否显示弹幕。
   *
   * 数据来自红果真实的弹幕接口（按 30 秒时间窗分页拉），渲染在
   * `components/player/DanmakuOverlay.tsx`。关闭时**不发起任何请求**，
   * 因此关掉它也能省掉一轮网络往返。
   *
   * 与 `vsrEnabled` 同款：旧记录缺字段时按 `!== false` 判定，默认开。
   */
  danmakuEnabled: boolean;
  /**
   * 弹幕显示区域：占播放器高度的百分比（25 / 50 / 75 / 100 四档）。
   *
   * 播放器内是「弹幕设置」面板的第一根滑条（2026-11-07）。轨道数不再写死 4，
   * 而是按实际层高 ÷ 行高推导——窗口化时 25% 恰好等于旧的 4 行观感，
   * 全屏时随画面高度自动获得更多轨道。
   */
  danmakuArea: number;
  /** 弹幕层不透明度（10–100%），默认 100。 */
  danmakuOpacity: number;
  /** 弹幕字号缩放（50–200%），基准 20px，默认 100。 */
  danmakuFontScale: number;
  /**
   * 弹幕速度档：0 = 慢（12s 飞完全程）/ 1 = 适中（8s，即移植自真果鉴的
   * `DANMAKU_LIFETIME_MS` 原值）/ 2 = 快（5s）。默认 1。
   */
  danmakuSpeed: number;
  /** 弹幕字体（CSS font-family 的首选族名），默认「黑体」。 */
  danmakuFont: string;
  /**
   * 弹幕文字颜色（#RRGGBB，默认 #FFFFFF 白）。
   *
   * 面板给 9 个预设色板 + 自定义取色器；旧记录缺字段或格式非法时回落白色。
   */
  danmakuColor: string;
  /** 弹幕加粗。默认开（与引入设置前的 fontWeight 700 一致）。 */
  danmakuBold: boolean;
  /** 描边类型：重墨（默认，四向粗黑边+投影）/ 描边（细黑边）/ 45°投影。 */
  danmakuStroke: 'heavy' | 'outline' | 'shadow';
  /**
   * 红果官网链路走不走系统代理。
   *
   * 自动判断在代理软件退出后必然判错（启动时固化的代理与运行时读到的注册表
   * 对不上），所以最终决定权交回用户。详见 Rust 侧 `models.rs` 的同名字段。
   *
   * 旧设置记录没有这个字段，读取时按 `'auto'` 处理。
   */
  proxyMode: 'auto' | 'direct' | 'proxy';
  /**
   * 是否启用「智能体联动」。
   *
   * 开：本地智能体工具（Claude Code / Codex / Gemini / Cursor 等，凡是能在
   * 事件发生时执行命令的工具都支持）的 hook 事件经本机桥转发过来时——
   * 正在播放则自动暂停，并弹「智能体呼叫卡」；点「前往」后播放器收起为
   * 悬浮卡片，点击卡片回到播放器**原位置**续播。
   * 关：桥不响应事件，播放不受任何影响。
   *
   * 默认关：联动会打断播放，必须用户显式开启（与 Rust 侧 `#[serde(default)]`
   /// 的 false 一致，理由见 models.rs 的字段注释）。
   */
  agentWatchEnabled: boolean;
  /**
   * 「自定义源」灰度开关（默认关）。
   *
   * 自定义源（用户自填苹果 CMS 接口）目前只做到「登记 + 测试」，还没接进
   * 发现页的目录/详情/播放。灰度期默认隐藏整块入口——否则用户加完源会
   * 发现首页什么都没变。接进聚合后再把默认值改成 true（Rust 侧
   * `models.rs` 的同名字段与这里必须同步）。
   */
  customSourcesEnabled: boolean;
}
