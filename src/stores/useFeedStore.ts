import { useCallback, useEffect, useRef, useState } from 'react';
import { errorText, ipcService, isTauriEnvironment } from '../services/ipc';
import {
  dedupeFeedItems,
  detailChannelForFeed,
  discoverChannelForFeed,
  feedDetailFromHongguo,
  feedDetailFromMock,
  latestHistoryForFeed,
  mockFeedItems,
  nextPlayableSeason,
  pickResumeEpisode,
  seasonItemFromApi,
  seasonNumberFromTitle,
  type FeedDetail,
} from '../services/feedSource';
import type { SeasonApiEntry, SeriesItem } from '../types/catalog';
import type { WatchHistoryItem } from '../types/history';
import type { FavoriteMark } from '../types/favorite';
import { useAppStore, type FeedChannel } from './useAppStore';
import { useFavoriteActions, useFavoriteMark } from './useFavoritesStore';
import { useHistoryStore } from './useHistoryStore';
import { usePlaybackActions } from './usePlaybackStore';

interface FeedState {
  channel: FeedChannel;
  items: SeriesItem[];
  currentIndex: number;
  currentItem: SeriesItem | null;
  detail: FeedDetail | null;
  episodeIndex: number;
  isLoading: boolean;
  isOpening: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  isCompleted: boolean;
  favoriteMark: FavoriteMark | undefined;
  error: string | null;
  selectChannel: (channel: FeedChannel) => void;
  previousEpisode: () => void;
  nextEpisode: () => void;
  switchSeries: () => void;
  retry: () => void;
  close: () => void;
  toggleFavorite: () => void;
  advanceAfterFinished: (sessionId: number) => void;
}

function historySeriesItem(record: WatchHistoryItem, channel: FeedChannel): SeriesItem {
  return {
    id: record.seriesId,
    title: record.title,
    cover: record.seriesCover,
    type: channel,
    episodesCount: record.totalEpisodes,
    tags: [],
    origin: '观看历史',
  };
}

export function useFeedStore(): FeedState {
  const { currentView, feedChannel, openFeed, navigateTo } = useAppStore();
  const { loadHistory } = useHistoryStore();
  const { currentSeries, currentEpisode, openEpisode } = usePlaybackActions();
  const setMark = useFavoriteActions();

  const [items, setItems] = useState<SeriesItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [currentItem, setCurrentItem] = useState<SeriesItem | null>(null);
  const [detail, setDetail] = useState<FeedDetail | null>(null);
  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const favoriteMark = useFavoriteMark(currentItem?.id ?? '');

  const itemsRef = useRef(items);
  const currentIndexRef = useRef(currentIndex);
  const currentItemRef = useRef(currentItem);
  const detailRef = useRef(detail);
  const episodeIndexRef = useRef(episodeIndex);
  const favoriteMarkRef = useRef(favoriteMark);
  const openEpisodeRef = useRef(openEpisode);
  const channelRef = useRef(feedChannel);
  const cursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(false);
  const loadingMoreRef = useRef(false);
  const loadingRef = useRef(false);
  const openingRef = useRef(false);
  const generationRef = useRef(0);
  const historyBySeriesRef = useRef(new Map<string, WatchHistoryItem>());
  const currentSeasonRef = useRef(1);
  const finishedSessionRef = useRef<number | null>(null);

  itemsRef.current = items;
  currentIndexRef.current = currentIndex;
  currentItemRef.current = currentItem;
  detailRef.current = detail;
  episodeIndexRef.current = episodeIndex;
  favoriteMarkRef.current = favoriteMark;
  openEpisodeRef.current = openEpisode;
  channelRef.current = feedChannel;
  hasMoreRef.current = hasMore;

  const setLoading = (value: boolean) => {
    loadingRef.current = value;
    setIsLoading(value);
  };

  const setCurrent = (item: SeriesItem, index: number, nextDetail: FeedDetail | null, season: number) => {
    currentIndexRef.current = index;
    currentItemRef.current = item;
    detailRef.current = nextDetail;
    currentSeasonRef.current = season;
    setCurrentIndex(index);
    setCurrentItem(item);
    setDetail(nextDetail);
  };

  const loadDetail = useCallback(async (item: SeriesItem, channel: FeedChannel): Promise<FeedDetail> => {
    const result = isTauriEnvironment()
      ? feedDetailFromHongguo(await ipcService.hongguo.seriesDetail(item.id, detailChannelForFeed(channel)))
      : feedDetailFromMock(item);
    if (!result) throw new Error('没有找到这部短剧的播放详情。');
    if (result.type !== channel) throw new Error('推荐内容与当前频道不一致。');
    if (result.episodes.length === 0) throw new Error('这部短剧暂时没有可播放的集数。');
    return result;
  }, []);

  const startEpisode = useCallback((item: SeriesItem, nextDetail: FeedDetail, index: number, position: number) => {
    const episode = nextDetail.episodes[index];
    if (!episode) throw new Error('找不到要播放的这一集。');
    const requestId = generationRef.current;
    episodeIndexRef.current = index;
    setEpisodeIndex(index);
    setIsCompleted(false);
    openingRef.current = true;
    setIsOpening(true);
    void openEpisodeRef.current(item.id, episode.id, position, undefined, nextDetail)
      .catch((playError: unknown) => {
        if (requestId === generationRef.current) setError(errorText(playError, '无法开始播放'));
      })
      .finally(() => {
        if (requestId !== generationRef.current) return;
        openingRef.current = false;
        setIsOpening(false);
      });
  }, []);

  const openSeriesAt = useCallback(async (
    index: number,
    record: WatchHistoryItem | undefined,
    requestId: number,
    allowFinishedResume = false,
  ) => {
    const item = itemsRef.current[index];
    if (!item || requestId !== generationRef.current) return;
    setCurrent(item, index, null, seasonNumberFromTitle(item.title));
    setLoading(true);
    setError(null);
    setIsCompleted(false);

    try {
      let nextItem = item;
      let nextDetail = await loadDetail(item, channelRef.current);
      if (requestId !== generationRef.current) return;

      const usableRecord = record && (!record.isFinished || allowFinishedResume) ? record : undefined;
      let resume = pickResumeEpisode(nextDetail.episodes, usableRecord);
      if (resume.finished) {
        const seasons = await ipcService.catalog.seriesSeasons(item.id);
        if (requestId !== generationRef.current) return;
        const nextSeason = nextPlayableSeason(seasons, currentSeasonRef.current, item.id);
        if (nextSeason) {
          nextItem = seasonItemFromApi(nextSeason, channelRef.current);
          currentSeasonRef.current = nextSeason.seasonIndex > 0
            ? nextSeason.seasonIndex
            : seasonNumberFromTitle(nextItem.title);
          setCurrent(nextItem, index, null, currentSeasonRef.current);
          nextDetail = await loadDetail(nextItem, channelRef.current);
          if (requestId !== generationRef.current) return;
          resume = { index: 0, position: 0, finished: false };
        } else {
          setCurrent(item, index, nextDetail, currentSeasonRef.current);
          setLoading(false);
          setIsCompleted(true);
          return;
        }
      }

      setCurrent(nextItem, index, nextDetail, currentSeasonRef.current);
      setLoading(false);
      startEpisode(nextItem, nextDetail, resume.index, resume.position);
    } catch (loadError) {
      if (requestId !== generationRef.current) return;
      setLoading(false);
      setError(errorText(loadError, '推荐内容加载失败'));
    }
  }, [loadDetail, startEpisode]);

  const fetchPage = useCallback(async (cursor?: string | null) => {
    const channel = channelRef.current;
    if (!isTauriEnvironment()) {
      return { items: cursor ? [] : mockFeedItems(channel), hasMore: false, cursor: null };
    }
    const page = await ipcService.hongguo.discover(discoverChannelForFeed(channel), cursor ?? null);
    return {
      items: dedupeFeedItems(page.items ?? [], channel),
      hasMore: Boolean(page.hasMore),
      cursor: page.cursor,
    };
  }, []);

  const appendNextPage = useCallback(async (requestId: number): Promise<SeriesItem[]> => {
    const previousCursor = cursorRef.current;
    if (!hasMoreRef.current || !previousCursor || loadingMoreRef.current) return [];
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const page = await fetchPage(previousCursor);
      if (requestId !== generationRef.current) return [];
      const existingIds = new Set(itemsRef.current.map(item => item.id));
      const merged = dedupeFeedItems([...itemsRef.current, ...page.items], channelRef.current);
      const added = merged.filter(item => !existingIds.has(item.id));
      cursorRef.current = page.cursor;
      hasMoreRef.current = Boolean(page.hasMore && page.cursor && page.cursor !== previousCursor);
      setHasMore(hasMoreRef.current);
      itemsRef.current = merged;
      setItems(merged);
      return added;
    } catch (loadError) {
      if (requestId === generationRef.current) setError(errorText(loadError, '更多推荐加载失败'));
      return [];
    } finally {
      loadingMoreRef.current = false;
      if (requestId === generationRef.current) setIsLoadingMore(false);
    }
  }, [fetchPage]);

  const loadInitial = useCallback(async () => {
    const requestId = ++generationRef.current;
    loadingMoreRef.current = false;
    loadingRef.current = true;
    openingRef.current = false;
    cursorRef.current = null;
    hasMoreRef.current = false;
    historyBySeriesRef.current = new Map();
    itemsRef.current = [];
    setItems([]);
    currentIndexRef.current = 0;
    currentItemRef.current = null;
    detailRef.current = null;
    currentSeasonRef.current = 1;
    setCurrentIndex(0);
    setCurrentItem(null);
    setDetail(null);
    setLoading(true);
    setIsOpening(false);
    setIsLoadingMore(false);
    setHasMore(false);
    setIsCompleted(false);
    setError(null);

    try {
      const historyPromise = loadHistory();
      const [page, records] = await Promise.all([fetchPage(), historyPromise]);
      if (requestId !== generationRef.current) return;
      historyBySeriesRef.current = new Map(records.map(record => [record.seriesId, record]));
      const record = latestHistoryForFeed(records, channelRef.current);
      const recommendations = dedupeFeedItems(page.items, channelRef.current);
      const resumeItem = record ? historySeriesItem(record, channelRef.current) : null;
      const queued = resumeItem
        ? dedupeFeedItems([resumeItem, ...recommendations], channelRef.current)
        : recommendations;
      itemsRef.current = queued;
      setItems(queued);
      cursorRef.current = page.cursor;
      hasMoreRef.current = Boolean(page.hasMore && page.cursor);
      setHasMore(hasMoreRef.current);

      if (queued.length === 0) {
        setLoading(false);
        setError('当前频道暂时没有可播放的推荐。');
        return;
      }
      await openSeriesAt(0, record, requestId, Boolean(record));
    } catch (loadError) {
      if (requestId !== generationRef.current) return;
      setLoading(false);
      setError(errorText(loadError, '推荐内容加载失败'));
    }
  }, [fetchPage, loadHistory, openSeriesAt]);

  useEffect(() => {
    if (currentView !== 'feed') {
      generationRef.current += 1;
      loadingRef.current = false;
      openingRef.current = false;
      return;
    }
    void loadInitial();
    return () => {
      generationRef.current += 1;
    };
  }, [currentView, feedChannel, loadInitial]);

  useEffect(() => {
    if (currentView !== 'feed' || !currentItem || !detail || currentSeries?.id !== currentItem.id || !currentEpisode) return;
    const index = detail.episodes.findIndex(episode => episode.id === currentEpisode.id);
    if (index >= 0 && index !== episodeIndexRef.current) {
      episodeIndexRef.current = index;
      setEpisodeIndex(index);
    }
  }, [currentView, currentSeries, currentEpisode, currentItem, detail]);

  const switchSeries = useCallback(async () => {
    if (loadingRef.current || openingRef.current) return;
    const requestId = generationRef.current;
    let nextIndex = currentIndexRef.current + 1;
    if (nextIndex >= itemsRef.current.length && hasMoreRef.current) {
      await appendNextPage(requestId);
      nextIndex = currentIndexRef.current + 1;
    }
    const nextItem = itemsRef.current[nextIndex];
    if (!nextItem) {
      setIsCompleted(true);
      setError(hasMoreRef.current ? '没有新的推荐，请稍后重试。' : '当前推荐已浏览完。');
      return;
    }
    const history = historyBySeriesRef.current.get(nextItem.id);
    await openSeriesAt(nextIndex, history?.isFinished ? undefined : history, requestId);
  }, [appendNextPage, openSeriesAt]);

  const continueAfterSeason = useCallback(async (item: SeriesItem, requestId: number) => {
    setLoading(true);
    setError(null);
    detailRef.current = null;
    setDetail(null);
    try {
      const entries: SeasonApiEntry[] = await ipcService.catalog.seriesSeasons(item.id);
      if (requestId !== generationRef.current) return;
      const nextSeason = nextPlayableSeason(entries, currentSeasonRef.current, item.id);
      if (!nextSeason) {
        setLoading(false);
        setIsCompleted(true);
        return;
      }
      const nextItem = seasonItemFromApi(nextSeason, channelRef.current);
      const season = nextSeason.seasonIndex > 0 ? nextSeason.seasonIndex : seasonNumberFromTitle(nextItem.title);
      const nextDetail = await loadDetail(nextItem, channelRef.current);
      if (requestId !== generationRef.current) return;
      setCurrent(nextItem, currentIndexRef.current, nextDetail, season);
      setLoading(false);
      startEpisode(nextItem, nextDetail, 0, 0);
    } catch (loadError) {
      if (requestId !== generationRef.current) return;
      setLoading(false);
      setError(errorText(loadError, '下一季加载失败'));
    }
  }, [loadDetail, startEpisode]);

  const previousEpisode = useCallback(() => {
    if (loadingRef.current || openingRef.current) return;
    const nextIndex = episodeIndexRef.current - 1;
    const item = currentItemRef.current;
    const nextDetail = detailRef.current;
    if (!item || !nextDetail || nextIndex < 0) return;
    startEpisode(item, nextDetail, nextIndex, 0);
  }, [startEpisode]);

  const nextEpisode = useCallback(() => {
    if (loadingRef.current || openingRef.current) return;
    const item = currentItemRef.current;
    const nextDetail = detailRef.current;
    if (!item || !nextDetail) return;
    const nextIndex = episodeIndexRef.current + 1;
    if (nextIndex < nextDetail.episodes.length) {
      startEpisode(item, nextDetail, nextIndex, 0);
      return;
    }
    void continueAfterSeason(item, generationRef.current);
  }, [continueAfterSeason, startEpisode]);

  const advanceAfterFinished = useCallback((sessionId: number) => {
    if (currentView !== 'feed' || finishedSessionRef.current === sessionId) return;
    finishedSessionRef.current = sessionId;
    const item = currentItemRef.current;
    if (item) void continueAfterSeason(item, generationRef.current);
  }, [currentView, continueAfterSeason]);

  const retry = useCallback(() => {
    const item = currentItemRef.current;
    if (!item || currentIndexRef.current < 0) {
      void loadInitial();
      return;
    }
    if (isCompleted) {
      void openSeriesAt(currentIndexRef.current, undefined, generationRef.current);
      return;
    }
    const history = historyBySeriesRef.current.get(item.id);
    void openSeriesAt(currentIndexRef.current, history?.isFinished ? undefined : history, generationRef.current);
  }, [isCompleted, loadInitial, openSeriesAt]);

  const close = useCallback(() => navigateTo('explore'), [navigateTo]);
  const selectChannel = useCallback((channel: FeedChannel) => openFeed(channel), [openFeed]);
  const toggleFavorite = useCallback(() => {
    const item = currentItemRef.current;
    if (!item) return;
    void setMark(item.id, item.title, item.cover, favoriteMarkRef.current ? null : 'want', item.type)
      .catch((saveError: unknown) => setError(errorText(saveError, '追剧状态保存失败')));
  }, [setMark]);

  return {
    channel: feedChannel,
    items,
    currentIndex,
    currentItem,
    detail,
    episodeIndex,
    isLoading,
    isOpening,
    isLoadingMore,
    hasMore,
    isCompleted,
    favoriteMark,
    error,
    selectChannel,
    previousEpisode,
    nextEpisode,
    switchSeries,
    retry,
    close,
    toggleFavorite,
    advanceAfterFinished,
  };
}
