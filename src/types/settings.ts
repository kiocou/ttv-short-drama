import { EnhancementEngine } from './enhancement';

export interface UserSettings {
  defaultQuality: '4k' | '1080p' | '720p' | 'auto';
  autoNext: boolean;
  countdownSeconds: number;
  preferredEngine: EnhancementEngine;
  targetFps: 60 | 120;
  catalogCacheMb: number;
  playbackCacheMb: number;
}
