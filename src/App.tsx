import React, { useEffect } from 'react';
import { AppProvider, useAppStore } from './stores/useAppStore';
import { CatalogProvider } from './stores/useCatalogStore';
import { PlaybackProvider, usePlaybackActions } from './stores/usePlaybackStore';
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
import { ShelfMoreView } from './components/views/ShelfMoreView';
import { VideoSurface } from './components/player/VideoSurface';
import { AnimeVideoSurface } from './components/player/AnimeVideoSurface';
import { PipReturnBridge } from './components/player/PipReturnBridge';
import { UpdatePrompt } from './components/common/UpdatePrompt';
import { LaunchAnimation } from './components/layout/LaunchAnimation';

const AppContent: React.FC = () => {
  const { currentView, selectedSeriesId, isFullscreen, setIsFullscreen } = useAppStore();
  /**
   * 只订阅 stopPlayback，**不要** usePlaybackStore()。
   *
   * PlaybackContext 的 value 是内联对象（见 usePlaybackStore 的 Provider），
   * 而 store 里的 position 每次 timeupdate 都变（约 4 次/秒）。订阅整个
   * context 就意味着 AppContent 每秒重渲染 4 次 —— 它是**所有视图的父节点**，
   * 于是发现页的上百张卡片、历史、收藏、设置页每一帧都在跟着 reconcile。
   * 用户感知就是「切页面 / 进出播放器都发涩」。
   * store 早就为此提供了 usePlaybackSelector（只读单个字段），此前一处都没用上。
   */
  const { stopPlayback } = usePlaybackActions();
  const { isOpen: isAnimePlayerOpen } = useAnimePlayer();

  const isPlayer = currentView === 'player';

  /**
   * 「详情页」这一个视图层的重挂载闸门。
   *
   * ## 为什么不给每个视图层挂 key（这曾是切页卡顿的直接来源）
   *
   * 旧实现给每一层写的是 `key={currentView === 'x' ? 'view-x' : undefined}`。
   * 只有**当前激活**的那层拿到字符串 key，其余 7 层都是 `undefined`。React 的
   * key 一旦变化就销毁重建：从 A 切到 B 时，B 层 `undefined → 'view-b'` 要重挂，
   * A 层 `'view-a' → undefined` **同样**要重挂 —— 一次点击换来整棵视图树的
   * 卸掉再建（含卡片列表、封面 IntersectionObserver、分页游标），主线程被占满，
   * 用户看到的就是"切换页面卡一下"。而且这跟"视图常驻 DOM"的初衷正好相反：
   * 每一层的 useEffect（拉数据、订阅）都被反复重跑。
   *
   * 真正需要重挂的只有一种情况：**换了一部剧**。详情页带着上一个剧的
   * `detail` / `selectedSeriesId` 时切到另一部，必须重新挂载才能拿到干净状态
   * （旧实现靠 `view-detail-${selectedSeriesId}` 达到这个效果，这是**唯一**
   * 值得保留的部分）。换频道、换搜索词、进「更多」页都已有各自的复位逻辑，
   * 不需要靠 key 重建。
   *
   * 这个 key 绝不能写在最外层主工作区上：那里住着播放器宿主，重挂会让 store 里
   * 只绑定一次的媒体事件监听器与 `<video>` 元素脱钩（详见主工作区那段注释的
   * 实机现象）。它只挂在详情页那一层。
   *
   * 同理，它也**不能跟视图走**。旧写法是
   * `currentView === 'detail' ? (selectedSeriesId ?? '') : ''`：detail 时
   * key=剧 id、player 时 key=''，于是「详情页 → 播放器」这一次跳转必然换 key，
   * 播放器宿主跟着被卸载重建。改成只跟**剧**走，进出播放器就不再重挂。
   */
  const workspaceKey = selectedSeriesId ?? '';

  // This is a focused desktop player rather than a browser surface. Prevent the
  // WebView's generic context menu so right-click never exposes browser actions.
  useEffect(() => {
    const preventContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('contextmenu', preventContextMenu);
    return () => document.removeEventListener('contextmenu', preventContextMenu);
  }, []);

  // 播放器宿主常驻 DOM，离开时仅被 display:none 隐藏，video 不会自动停。
  // 不显式停止就会出现"回到主界面但声音还在播"（含后台连播倒计时自动开播）。
  //
  // ⚠️ `isAnimePlayerOpen` 必须列进来，且判定是「或」而不是只看视图。
  // 从短剧播放器直接进动漫播放时（详情页/发现页/历史页三条入口都是这个走法），
  // `currentView` 全程停在 `'player'`，`isPlayer` 自始至终是 true —— 旧写法的
  // `if (!isPlayer)` 因此**一次都不会触发**，短剧那条链路（卡死看门狗、连播倒计时、
  // 预解池、在途 resolveNative）全部跨这次「离开」继续存活：倒计时到点会把一部
  // 用户根本看不见的短剧强行开播并出声。动漫侧的 haltCurrent 停的是它自己那块
  // video，不会碰短剧这块。这是不变量 1「同一时刻只有一路在播」的实质缺口。
  useEffect(() => {
    if (!isPlayer || isAnimePlayerOpen) stopPlayback();
  }, [isPlayer, isAnimePlayerOpen, stopPlayback]);

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

      {/* 主工作区：持久化常驻渲染，杜绝切换时的卸载闪屏与白屏。

          **这一层刻意不给 key**：它内部住着播放器宿主（`<VideoSurface/>` 里的
          那块 `<video>`）与动漫宿主。store 的媒体事件监听器只在首次挂载时绑定
          一次（见 usePlaybackStore 的「监听器只绑定一次，永不重绑」），捕获的是
          **那一刻**的 video 元素；一旦 React 因为 key 变化把这块 `<video>` 卸载
          重建，新元素在播、监听器却还挂在被丢弃的旧元素上，
          `setPosition` / `setDuration` 再也不会被调用 —— 表现就是画面明明在走，
          进度条却永远停在 00:00 / 00:00 而且拖不动（用户实机报告的现象）。
          同一原因还会让连播失效（`ended` 绑在旧元素）与「下载中」遮罩不消失
          （`playing` 上的 clearResolveOverlay 绑在旧元素）。

          换剧要重挂的是**视图树**，不是播放器宿主，所以 key 挂到了下面包着
          NavigationRail + main 的那一层。 */}
      <div className="flex-1 w-full flex overflow-hidden relative">
        {/* 播放器宿主常驻 DOM。不要给包含 video 的祖先加 opacity/transform 入场动画：
            fluentScaleIn 的 forwards 会在结束后保留合成状态；实测即使 HUD 已去模糊，
            仍无法触发 NVIDIA VSR。与动漫宿主一样直接显示，控制器自身的动效不受影响。 */}
        {/*
          短剧/漫剧播放器。动漫播放期间一并隐藏：动漫走的是另一块 `<video>`
          （AnimeVideoSurface），两块媒体元素同时活跃会出现"两个声音"、
          MSE 互相抢占等难以排查的状态。
        */}
        <div
          className={`w-full h-full absolute inset-0 z-30 ${
            isPlayer && !isAnimePlayerOpen
              ? 'block pointer-events-auto'
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

        {/* 导航栏与内容画板：常驻 DOM，视图切换平滑带动画。
            这一层同样**不给 key**：导航栏不该跟着任何视图切换重挂。 */}
        <div
          className={`flex-1 w-full h-full flex overflow-hidden ${
            isPlayer ? 'hidden' : 'flex'
          }`}
        >
          <NavigationRail />
          <main 
            style={{ contain: 'layout paint' }}
            data-launch-part="content"
            className="flex-1 min-w-0 h-full overflow-hidden relative bg-white/40"
          >
            <div
              className={`h-full w-full ${currentView === 'explore' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <ExploreView />
            </div>
            <div
              className={`h-full w-full ${currentView === 'anime' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <AnimeView />
            </div>
            {/*
              详情页是唯一需要 key 的视图层，原因只有一个：**换了一部剧**时必须
              重挂，否则会拿着上一部的 `detail` 显示新剧的标题/集数。旧实现把这
              个 key 写在最外层工作区上，代价是「详情页 → 播放器」这一次跳转也
              跟着换 key —— 那会把**播放器宿主**（`<VideoSurface/>` 里的
              `<video>`）一起卸载重建，而 store 的媒体事件监听器只绑定一次、
              仍挂在被丢弃的旧元素上，于是画面在走、进度条却永远 00:00 / 00:00
              且拖不动（原因详见上面主工作区那段注释）。
              把 key 收进这一层：换剧才重挂，切视图、进出播放器都不重挂。
            */}
            <div
              key={workspaceKey}
              className={`h-full w-full ${currentView === 'detail' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <DetailView />
            </div>
            <div
              className={`h-full w-full ${currentView === 'history' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <HistoryView />
            </div>
            <div
              className={`h-full w-full ${currentView === 'favorites' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <FavoritesView />
            </div>
            <div
              className={`h-full w-full ${currentView === 'settings' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <SettingsView />
            </div>
            <div
              className={`h-full w-full ${currentView === 'search' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <SearchView />
            </div>
            {/*
              首页货架的「更多」页。它自己挂一份独立的 CatalogProvider（见
              ShelfMoreView 的头注释），排序由进入的分区钉死，不走发现页那份。
              **这里刻意不给 key**：旧实现带了 `key={currentView === 'shelf' ? …}`，
              等于每次切走再进来都整页重挂。它自己已经在 `shelfView` 变化时复位
              状态（见 ShelfMoreView 的取数与游标说明），不需要靠 key 重建，
              而重建的代价是重新挂一份 CatalogProvider + 重拉首屏。
            */}
            <div
              className={`h-full w-full ${currentView === 'shelf' ? 'block animate-fluent-page-in' : 'hidden'}`}
            >
              <ShelfMoreView />
            </div>
          </main>
        </div>
      </div>

      {/* 全局 Toast 通知容器 */}

      {/* 画中画小窗回流：小窗关闭时接回播放/落历史（不渲染任何界面） */}
      <PipReturnBridge />
      <ToastContainer />
      {/* 启动时的更新提示：常驻最上层，且自己管「检查 / 下载 / 安装」全过程。
          放在这里而不是各个视图里，是为了让用户在任意页面都能收到它。 */}
      <UpdatePrompt />

      {/*
        启动进入动画（方案 05「轨道汇聚」）。放在最后 = 盖在 TitleBar 与 UpdatePrompt 之上。
        它自己管生命周期：动画跑完（或点击跳过）后 unmount，不留任何常驻 DOM 与内联样式。
        **不要**把它改成常驻 + display:none —— 那样会在"隐藏祖先里创建动画"，
        命中项目里已经记录过的坑（动画永久卡在 0% 帧）。
      */}
      <LaunchAnimation />
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
