export interface UserSettings {
  defaultQuality: '4k' | '1080p' | '720p' | 'auto';
  autoNext: boolean;
  /** 已废弃：增强/补帧链路已移除，仅兼容旧设置记录。 */
  preferredEngine: string;
  /** 已废弃：补帧链路已移除，仅兼容旧设置记录。 */
  targetFps: number;
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
}
