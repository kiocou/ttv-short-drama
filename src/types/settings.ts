export interface UserSettings {
  defaultQuality: '4k' | '1080p' | '720p' | 'auto';
  autoNext: boolean;
  countdownSeconds: number;
  /** 已废弃：增强/补帧链路已移除，仅兼容旧设置记录。 */
  preferredEngine: string;
  /** 已废弃：补帧链路已移除，仅兼容旧设置记录。 */
  targetFps: number;
  catalogCacheMb: number;
  playbackCacheMb: number;
}
