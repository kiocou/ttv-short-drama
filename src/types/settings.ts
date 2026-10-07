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
}
