import type { HongguoDiscoverChannel, HongguoSeriesDetail } from './ipc';
import type { ChannelType, SeasonApiEntry, SeriesItem } from '../types/catalog';
import type { WatchHistoryItem } from '../types/history';
import type { EpisodeItem, SeriesDetail } from '../types/series';
import { getSeriesDetail, MOCK_SERIES_LIST } from './mockData.ts';
import { parseSeasonLabel } from './seasonLabel.ts';

export type FeedChannel = 'drama' | 'comic';

export interface FeedDetail extends SeriesDetail {
  isMultiSeason: boolean;
}

export type FeedGesture = 'next' | 'previous';

/** 真人推荐单独走 live；recommend 是短剧与漫剧混合流。 */
export function discoverChannelForFeed(channel: FeedChannel): HongguoDiscoverChannel {
  return channel === 'comic' ? 'comic' : 'live';
}

/** 详情返回的 item.type 是应用频道，与 discover 使用的 tab 字面量不同。 */
export function detailChannelForFeed(channel: FeedChannel): FeedChannel {
  return channel;
}

/** 队列去重，同时丢掉不属于当前频道的条目。 */
export function dedupeFeedItems(items: readonly SeriesItem[], channel: FeedChannel): SeriesItem[] {
  const seen = new Set<string>();
  const result: SeriesItem[] = [];
  for (const item of items) {
    if (!item?.id || !item.title || item.type !== channel || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

export function mockFeedItems(channel: FeedChannel): SeriesItem[] {
  return dedupeFeedItems(MOCK_SERIES_LIST, channel);
}

/** 最近的同频道红果记录；旧版缺频道时只按真人剧回退，排除动漫与 guo 站源。 */
export function latestHistoryForFeed(
  records: readonly WatchHistoryItem[],
  channel: FeedChannel,
): WatchHistoryItem | undefined {
  return records
    .filter(record => {
      if (!record.seriesId || record.seriesId.startsWith('guo:') || record.seriesId.startsWith('anime_')) {
        return false;
      }
      if (record.channel) return record.channel === channel;
      return channel === 'drama';
    })
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
}

/** 未完成记录按 episode id 续播；源 id 改变时按集号回退匹配。 */
export function pickResumeEpisode(
  episodes: readonly Pick<EpisodeItem, 'id' | 'episodeNumber' | 'durationSeconds'>[],
  history: WatchHistoryItem | undefined,
): { index: number; position: number; finished: boolean } {
  if (!episodes.length || !history) return { index: 0, position: 0, finished: false };
  let index = episodes.findIndex(episode => episode.id === history.episodeId);
  if (index < 0 && history.episodeNumber > 0) {
    index = episodes.findIndex(episode => episode.episodeNumber === history.episodeNumber);
  }
  if (index < 0) return { index: 0, position: 0, finished: false };
  if (history.isFinished) {
    return index < episodes.length - 1
      ? { index: index + 1, position: 0, finished: false }
      : { index, position: 0, finished: true };
  }
  const episode = episodes[index];
  const rawPosition = Number.isFinite(history.positionSeconds) ? Math.max(0, history.positionSeconds) : 0;
  const position = episode.durationSeconds > 0 ? Math.min(rawPosition, episode.durationSeconds) : rawPosition;
  return { index, position, finished: false };
}

export function feedDetailFromHongguo(detail: HongguoSeriesDetail): FeedDetail {
  const series = detail.series;
  return {
    ...series,
    id: series.id,
    title: series.title,
    cover: series.cover,
    backdrop: series.backdrop,
    type: series.type,
    episodesCount: detail.episodes.length || series.episodesCount,
    tags: series.tags ?? [],
    origin: series.origin || '红果推荐',
    description: series.brief ?? '',
    episodes: detail.episodes.map((episode): EpisodeItem => ({
      id: episode.id,
      seriesId: episode.seriesId || series.id,
      episodeNumber: episode.number,
      title: episode.title || `第 ${episode.number} 集`,
      durationSeconds: episode.durationSeconds,
    })),
    availableQualities: [{ label: '自动', value: 'auto', resolution: '自适应' }],
    sources: [],
    isMultiSeason: detail.isMultiSeason,
  };
}

export function feedDetailFromMock(series: SeriesItem): FeedDetail | null {
  if (!MOCK_SERIES_LIST.some(item => item.id === series.id)) return null;
  const detail = getSeriesDetail(series.id);
  return detail ? { ...detail, isMultiSeason: false } : null;
}

/** 选季按结构化 seasonIndex，缺失时才按标题回退；跳过未上架或禁播季。 */
export function nextPlayableSeason(
  entries: readonly SeasonApiEntry[],
  currentSeason: number,
  currentSeriesId?: string,
): SeasonApiEntry | null {
  return entries
    .filter(entry => {
      if (!entry.seriesId || entry.seriesId === currentSeriesId || entry.disablePlay || entry.episodeCount <= 0) {
        return false;
      }
      const season = entry.seasonIndex > 0
        ? entry.seasonIndex
        : parseSeasonLabel(entry.title)?.season ?? 0;
      return season > currentSeason;
    })
    .sort((left, right) => {
      const leftSeason = left.seasonIndex > 0 ? left.seasonIndex : parseSeasonLabel(left.title)?.season ?? Infinity;
      const rightSeason = right.seasonIndex > 0 ? right.seasonIndex : parseSeasonLabel(right.title)?.season ?? Infinity;
      return leftSeason - rightSeason;
    })[0] ?? null;
}

export function seasonItemFromApi(entry: SeasonApiEntry, channel: FeedChannel): SeriesItem {
  return {
    id: entry.seriesId,
    title: entry.title,
    cover: entry.cover,
    type: channel,
    episodesCount: entry.episodeCount,
    tags: [],
    origin: '系列列表',
  };
}

export function seasonNumberFromTitle(title: string): number {
  return parseSeasonLabel(title)?.season ?? 1;
}

/** 忽略点击、短距离移动和以横向为主的轨迹。 */
export function feedGestureDirection(deltaX: number, deltaY: number): FeedGesture | null {
  if (Math.abs(deltaY) < 56 || Math.abs(deltaY) < Math.abs(deltaX) * 1.25) return null;
  return deltaY < 0 ? 'next' : 'previous';
}

export function normalizeFeedChannel(channel: ChannelType | string | undefined): FeedChannel {
  return channel === 'comic' ? 'comic' : 'drama';
}
