import React, { useEffect } from 'react';
import { AppProvider, useAppStore } from './stores/useAppStore';
import { CatalogProvider } from './stores/useCatalogStore';
import { PlaybackProvider, usePlaybackStore } from './stores/usePlaybackStore';
import { EnhancementProvider } from './stores/useEnhancementStore';
import { HistoryProvider } from './stores/useHistoryStore';
import { SettingsProvider } from './stores/useSettingsStore';

import { TitleBar } from './components/layout/TitleBar';
import { NavigationRail } from './components/layout/NavigationRail';
import { ToastContainer } from './components/layout/ToastContainer';

import { ExploreView } from './components/views/ExploreView';
import { DetailView } from './components/views/DetailView';
import { HistoryView } from './components/views/HistoryView';
import { SettingsView } from './components/views/SettingsView';
import { VideoSurface } from './components/player/VideoSurface';

const AppContent: React.FC = () => {
  const { currentView, selectedSeriesId, isFullscreen, setIsFullscreen } = useAppStore();
  const { stopPlayback } = usePlaybackStore();

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
  useEffect(() => {
    if (isPlayer || !isFullscreen) return;
    let cancelled = false;
    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        if (await win.isFullscreen()) await win.setFullscreen(false);
      } catch {
        // 非 Tauri 环境下无需处理。
      } finally {
        if (!cancelled) setIsFullscreen(false);
      }
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
        <div
          className={`w-full h-full absolute inset-0 z-30 ${
            isPlayer
              ? 'block animate-fluent-scale-in pointer-events-auto'
              : 'hidden pointer-events-none -z-10'
          }`}
        >
          <VideoSurface />
        </div>

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
              key={currentView === 'settings' ? 'view-settings' : undefined}
              className={`h-full w-full ${currentView === 'settings' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <SettingsView />
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
            <EnhancementProvider>
              <HistoryProvider>
                <AppContent />
              </HistoryProvider>
            </EnhancementProvider>
          </PlaybackProvider>
        </CatalogProvider>
      </SettingsProvider>
    </AppProvider>
  );
};

export default App;
