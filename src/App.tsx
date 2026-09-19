import React, { useEffect } from 'react';
import { AppProvider, useAppStore } from './stores/useAppStore';
import { CatalogProvider } from './stores/useCatalogStore';
import { PlaybackProvider, usePlaybackStore } from './stores/usePlaybackStore';
import { AnimePlayerProvider, useAnimePlayer } from './stores/useAnimePlayerStore';
import { HistoryProvider } from './stores/useHistoryStore';
import { FavoritesProvider } from './stores/useFavoritesStore';
import { SettingsProvider } from './stores/useSettingsStore';
import { leaveFullscreen } from './services/windowFx';

import { TitleBar } from './components/layout/TitleBar';
import { NavigationRail } from './components/layout/NavigationRail';
import { ToastContainer } from './components/layout/ToastContainer';

import { ExploreView } from './components/views/ExploreView';
import { AnimeView } from './components/views/AnimeView';
import { DetailView } from './components/views/DetailView';
import { HistoryView } from './components/views/HistoryView';
import { FavoritesView } from './components/views/FavoritesView';
import { SettingsView } from './components/views/SettingsView';
import { SearchView } from './components/views/SearchView';
import { VideoSurface } from './components/player/VideoSurface';
import { AnimeVideoSurface } from './components/player/AnimeVideoSurface';

const AppContent: React.FC = () => {
  const { currentView, selectedSeriesId, isFullscreen, setIsFullscreen } = useAppStore();
  const { stopPlayback } = usePlaybackStore();
  const { isOpen: isAnimePlayerOpen } = useAnimePlayer();

  const isPlayer = currentView === 'player';

  // This is a focused desktop player rather than a browser surface. Prevent the
  // WebView's generic context menu so right-click never exposes browser actions.
  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('contextmenu', preventContextMenu);
    return () => document.removeEventListener('contextmenu', preventContextMenu);
  }, []);

  // 播放器宿主常驻 DOM，离开时仅被 display:none 隐藏，video 不会自动停。
  // 不显式停止就会出现"回到主界面但声音还在播"（含后台连播倒计时自动开播）。
  useEffect(() => {
    if (!isPlayer) stopPlayback();
  }, [isPlayer, stopPlayback]);

  // 非播放视图下必须退出全屏。
  // 否则用户在全屏播放时返回详情页/发现页，窗口仍停在全屏，整个程序看起来
  // 被"卡"在全屏状态（实测现象：返回详情页后程序仍全屏，底部还留一条黑边——
  // 那是被隐藏的播放器容器）。
  // 走 windowFx.leaveFullscreen：它同时负责还原"进全屏前是否最大化"，
  // 避免退出后窗口比用户预期更小。
  useEffect(() => {
    if (isPlayer || !isFullscreen) return;
    let cancelled = false;
    void (async () => {
      await leaveFullscreen();
      if (!cancelled) setIsFullscreen(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isPlayer, isFullscreen, setIsFullscreen]);

  return (
    <div
      className="w-full h-full flex flex-col mica-backdrop select-none overflow-hidden"
      onContextMenu={(event) => event.preventDefault()}
    >
      {/*
        全屏时隐藏标题栏，让播放器真正占满整个窗口。
        原生窗口全屏已经让窗口铺满屏幕，此时唯一还挡着画面的就是这条 40px
        标题栏——不隐藏它，用户就会觉得"全屏了但视频没放大"。
      */}
      {!isFullscreen && <TitleBar />}

      {/* 主工作区：持久化常驻渲染，杜绝切换时的卸载闪屏与白屏 */}
      <div className="flex-1 w-full flex overflow-hidden relative">
        {/* 播放器宿主：常驻 DOM，确保 videoRef 永远就绪，带平滑缩放入场动效 */}
        {/*
          短剧/漫剧播放器。动漫播放期间一并隐藏：动漫走的是另一块 `<video>`
          （AnimeVideoSurface），两块媒体元素同时活跃会出现"两个声音"、
          MSE 互相抢占等难以排查的状态。
        */}
        <div
          className={`w-full h-full absolute inset-0 z-30 ${
            isPlayer && !isAnimePlayerOpen
              ? 'block animate-fluent-scale-in pointer-events-auto'
              : 'hidden pointer-events-none -z-10'
          }`}
        >
          <VideoSurface />
        </div>

        {/*
          动漫专区专用播放器：**按需挂载**。
          动漫源的挂载方式在 hls.js(MSE) 与原生 src 之间来回切，元素上容易留下
          残留状态；用"退出即销毁"代替"复用常驻元素并小心清理"，少一类事故。
        */}
        {isAnimePlayerOpen && (
          <div className="w-full h-full absolute inset-0 z-40">
            <AnimeVideoSurface />
          </div>
        )}

        {/* 导航栏与内容画板：常驻 DOM，视图切换平滑带动画 */}
        <div
          className={`flex-1 w-full h-full flex overflow-hidden ${
            isPlayer ? 'hidden' : 'flex'
          }`}
        >
          <NavigationRail />
          <main 
            style={{ contain: 'layout paint' }}
            className="flex-1 min-w-0 h-full overflow-hidden relative bg-white/40"
          >
            <div
              key={currentView === 'explore' ? 'view-explore' : undefined}
              className={`h-full w-full ${currentView === 'explore' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <ExploreView />
            </div>
            <div
              key={currentView === 'anime' ? 'view-anime' : undefined}
              className={`h-full w-full ${currentView === 'anime' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <AnimeView />
            </div>
            <div
              key={currentView === 'detail' ? `view-detail-${selectedSeriesId}` : undefined}
              className={`h-full w-full ${currentView === 'detail' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <DetailView />
            </div>
            <div
              key={currentView === 'history' ? 'view-history' : undefined}
              className={`h-full w-full ${currentView === 'history' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <HistoryView />
            </div>
            <div
              key={currentView === 'favorites' ? 'view-favorites' : undefined}
              className={`h-full w-full ${currentView === 'favorites' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <FavoritesView />
            </div>
            <div
              key={currentView === 'settings' ? 'view-settings' : undefined}
              className={`h-full w-full ${currentView === 'settings' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <SettingsView />
            </div>
            <div
              key={currentView === 'search' ? 'view-search' : undefined}
              className={`h-full w-full ${currentView === 'search' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <SearchView />
            </div>
          </main>
        </div>
      </div>

      {/* 全局 Toast 通知容器 */}
      <ToastContainer />
    </div>
  );
};

export const App: React.FC = () => {
  return (
    <AppProvider>
      <SettingsProvider>
        <CatalogProvider>
          <PlaybackProvider>
            <HistoryProvider>
              <FavoritesProvider>
                <AnimePlayerProvider>
                  <AppContent />
                </AnimePlayerProvider>
              </FavoritesProvider>
            </HistoryProvider>
          </PlaybackProvider>
        </CatalogProvider>
      </SettingsProvider>
    </AppProvider>
  );
};

export default App;
