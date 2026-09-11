import { ChannelType } from './catalog';

export interface EpisodeItem {
  id: string;
  seriesId: string;
  episodeNumber: number;
  title: string;
  durationSeconds: number;
  previewUrl?: string;
  // Real playback URLs are short-lived and are resolved only when an episode opens.
  videoUrl?: string;
  watchedSeconds?: number;
  isFinished?: boolean;
}

export interface VideoQualityOption {
  label: string; // '4K 杜比视界' | '1080P 超清' | '720P 高清' | '自动'
  value: '4k' | '1080p' | '720p' | 'auto';
  resolution: string; // '3840x2160' | '1920x1080' | '1280x720'
  bitrate?: string;
}

export interface PlaybackSource {
  id: string;
  name: string;
  isPrimary: boolean;
  health: 'healthy' | 'degraded' | 'unavailable';
  pingMs: number;
}

export interface SeriesDetail {
  id: string;
  title: string;
  cover: string;
  backdrop?: string;
  type: ChannelType;
  tags: string[];
  origin: string;
  episodesCount: number;
  updateTime?: string;
  description: string;
  actors?: string[];
  director?: string;
  episodes: EpisodeItem[];
  availableQualities: VideoQualityOption[];
  sources: PlaybackSource[];
}
