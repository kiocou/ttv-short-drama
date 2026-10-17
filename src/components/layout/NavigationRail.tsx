import React from 'react';
import {
  Flame,
  Clapperboard,
  Bookmark,
  History,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useAppStore, AppView } from '../../stores/useAppStore';

interface NavItem {
  id: AppView;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

export const NavigationRail: React.FC = () => {
  const { currentView, navigateTo, isNavCollapsed, toggleNavCollapsed } = useAppStore();

  const navItems: NavItem[] = [
    // 图标按"这一项到底是什么"选，而不是按近义词选：
    // Flame = 发现页顶部的热播/推荐（ExploreView 自己也用它标热播榜）；
    // Clapperboard = 动漫专区（与该页页头同一个图标）；
    // Bookmark = 追剧收藏（Heart 是"喜欢"，对应的是详情页的点赞语义，不是追更）；
    // History / Settings 本来就准确，不动。
    { id: 'explore', label: '短剧发现', icon: Flame },
    { id: 'anime', label: '动漫专区', icon: Clapperboard },
    { id: 'favorites', label: '我的追剧', icon: Bookmark },
    { id: 'history', label: '观看历史', icon: History },
    { id: 'settings', label: '系统设置', icon: Settings },
  ];

  /*
    高亮底按索引滑动：`h-10` 按钮 + `gap-1`（4px）= 44px 一步。
    当前视图不在导航里（播放器 / 详情页 / 搜索 / 更多页）时藏起来，
    免得停在上一项上假装那一项还是选中的。
  */
  const activeIndex = navItems.findIndex(item => item.id === currentView);

  /*
    浮动面板：四边 16px 外边距 + 圆角 20 + 低透明度柔和投影。

    高度刻意不写 h-full：父层是 flex 行，去掉它之后 margin 会把面板自动收进那
    32px 里，写死 h-full 反而会溢出窗口底边。

    也刻意不用 backdrop-blur：MicaCard 的注释里记着"79 个 backdrop-filter 元素
    → p95 164.8ms"的实测教训，而侧栏是常驻的大面积元素；半透明白叠在
    mica-backdrop 渐变上已经足够表达"浮起来"。
  */
  return (
    <aside
      style={{ transform: 'translateZ(0)' }}
      data-launch-part="rail"
      className={`relative m-4 flex flex-col justify-between py-3 px-2.5 select-none rounded-[20px] bg-white/75 border border-white/80 shadow-fluent-lg z-40 overflow-hidden transition-[width] duration-150 ease-out ${
        isNavCollapsed ? 'w-16' : 'w-56'
      }`}
    >
      {/* 顶部主导航区域 */}
      <div className="flex flex-col gap-1.5 w-full">
        {/* 分组微标题 (纯 GPU 透明渐变，不触发 DOM 销毁重排) */}
        <div className="h-6 px-3 flex items-center overflow-hidden">
          <div className="w-32 flex-shrink-0">
            <span
              className={`block text-[11px] font-bold text-slate-400 uppercase tracking-wider select-none whitespace-nowrap transition-opacity duration-150 ${
                isNavCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'
              }`}
            >
              媒体中心
            </span>
          </div>
        </div>

        {/* 导航按钮组：固定 40px 图标区与固定 128px 文本区，彻底避免文本折行重排与抖动 */}
        <div className="relative w-full flex flex-col gap-1">
          {/* 滑动高亮：切换视图时从旧项滑到新项，比"瞬间换底色"能看清发生了什么。
              绝对定位 + pointer-events-none，压在按钮下面（按钮自带 relative，DOM 在后即在上）。 */}
          <div
            aria-hidden
            className={`pointer-events-none absolute left-0 right-0 h-10 rounded-xl bg-blue-600 shadow-md shadow-blue-500/25 transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              activeIndex < 0 ? 'opacity-0' : 'opacity-100'
            }`}
            style={{ transform: `translateY(${Math.max(activeIndex, 0) * 44}px)` }}
          />
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;

            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                title={isNavCollapsed ? item.label : undefined}
                className={`group relative flex items-center h-10 w-full rounded-xl transition-colors duration-150 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 active:scale-[0.98] overflow-hidden ${
                  isActive
                    ? 'text-white font-bold'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-black/[0.04] font-medium'
                }`}
              >
                {/* 固定 40px 图标区：折叠与展开水平绝对同轴，0 像素偏移 */}
                <div className="w-10 h-10 flex-shrink-0 flex items-center justify-center">
                  {/* key 随选中态变化 = 选中那一刻重挂一次，弹出动画才会重放。
                      动画只动 transform，不碰 opacity（见 tailwind.config.js 的约定）。 */}
                  <Icon
                    key={isActive ? 'on' : 'off'}
                    className={`w-5 h-5 transition-transform duration-150 group-hover:scale-105 ${
                      isActive
                        ? 'text-white animate-nav-icon-pop'
                        : 'text-slate-500 group-hover:text-slate-800'
                    }`}
                  />
                </div>

                {/* 文字标签：固定宽度，纯 opacity 渐变，零重排 */}
                <div className="w-32 flex-shrink-0 overflow-hidden text-left">
                  <span
                    className={`block text-xs tracking-wide whitespace-nowrap transition-opacity duration-150 ${
                      isNavCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'
                    }`}
                  >
                    {item.label}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 底部功能区 */}
      <div className="flex flex-col gap-2 pt-2 border-t border-slate-200/60 w-full">
        {/* 侧边栏展开/收起切换按钮 (图标平滑切换 + 文字淡入淡出) */}
        <button
          type="button"
          onClick={toggleNavCollapsed}
          title={isNavCollapsed ? '展开导航栏' : '收起导航栏'}
          className="group relative flex items-center h-10 w-full rounded-xl font-medium text-xs text-slate-600 hover:text-slate-900 hover:bg-black/[0.04] transition-colors duration-150 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 active:scale-[0.98] overflow-hidden"
        >
          <div className="w-10 h-10 flex-shrink-0 relative flex items-center justify-center text-slate-500 group-hover:text-slate-800 transition-[color,transform] duration-150 group-hover:scale-110">
            <PanelLeftOpen
              className={`w-4.5 h-4.5 absolute transition-opacity duration-150 ${
                isNavCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            />
            <PanelLeftClose
              className={`w-4.5 h-4.5 absolute transition-opacity duration-150 ${
                !isNavCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'
              }`}
            />
          </div>

          <div className="w-32 flex-shrink-0 overflow-hidden text-left">
            <span
              className={`block font-semibold text-xs whitespace-nowrap transition-opacity duration-150 ${
                isNavCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'
              }`}
            >
              收起侧栏
            </span>
          </div>
        </button>
      </div>
    </aside>
  );
};
