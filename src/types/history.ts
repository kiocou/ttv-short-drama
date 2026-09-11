import { ChannelType } from './catalog';

export interface WatchHistoryItem {
  seriesId: string;
  episodeId: string;
  title: string;
  seriesCover: string;
  episodeNumber: number;
  totalEpisodes: number;
  positionSeconds: number;
  durationSeconds: number;
  progressPercent: number;
  updatedAt: number; // timestamp
  isFinished: boolean;
  channel?: ChannelType;
}
