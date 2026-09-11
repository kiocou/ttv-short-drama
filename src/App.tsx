import React from 'react';
import { AppProvider, useAppStore } from './stores/useAppStore';
import { CatalogProvider } from './stores/useCatalogStore';
import { PlaybackProvider } from './stores/usePlaybackStore';
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
  const { currentView, selectedSeriesId } = useAppStore();

  const isPlayer = currentView === 'player';

  return (
    <div className="w-full h-full flex flex-col mica-backdrop select-none overflow-hidden">
      {/* 统一 Mica 标题栏 */}
      <TitleBar />

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
