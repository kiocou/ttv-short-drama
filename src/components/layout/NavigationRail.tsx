import React from 'react';
import { 
  Compass, 
  History, 
  Settings, 
  PanelLeftClose, 
  PanelLeftOpen, 
  Film
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
    { id: 'explore', label: '短剧发现', icon: Compass },
    { id: 'history', label: '观看历史', icon: History },
    { id: 'settings', label: '系统设置', icon: Settings },
  ];

  return (
    <aside
      style={{ transform: 'translateZ(0)' }}
      className={`relative h-full flex flex-col justify-between py-3 px-2.5 select-none bg-[#fbfcfd] border-r border-slate-200/75 z-40 overflow-hidden transition-[width] duration-150 ease-out ${
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
        <div className="w-full flex flex-col gap-1">
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
                    ? 'bg-blue-600 text-white font-bold shadow-md shadow-blue-500/25'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-black/[0.04] font-medium'
                }`}
              >
                {/* 固定 40px 图标区：折叠与展开水平绝对同轴，0 像素偏移 */}
                <div className="w-10 h-10 flex-shrink-0 flex items-center justify-center">
                  <Icon
                    className={`w-5 h-5 transition-transform duration-150 group-hover:scale-105 ${
                      isActive ? 'text-white' : 'text-slate-500 group-hover:text-slate-800'
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
        {/* 底部信息胶囊 (折叠态与展开态平滑交叉淡入淡出，高度恒定 40px) */}
        <div className="relative h-10 w-full flex items-center overflow-hidden">
          {/* 折叠态单图标 */}
          <div
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-150 ${
              isNavCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
            title="Windows Mica · 120 FPS AI 插帧"
          >
            <div className="w-10 h-10 rounded-xl bg-slate-100/90 border border-slate-200/70 shadow-2xs flex items-center justify-center text-blue-600 cursor-default">
              <Film className="w-4 h-4" />
            </div>
          </div>

          {/* 展开态完整卡片 */}
          <div
            className={`absolute inset-0 px-3 py-1.5 rounded-xl bg-white/90 border border-slate-200/70 shadow-2xs flex items-center gap-2.5 transition-opacity duration-150 ${
              !isNavCollapsed ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            <div className="w-7 h-7 rounded-lg bg-blue-50 text-blue-600 border border-blue-200/50 flex items-center justify-center flex-shrink-0">
              <Film className="w-3.5 h-3.5" />
            </div>
            <div className="text-[10px] leading-tight truncate flex-1">
              <div className="flex items-center gap-1.5 font-bold text-slate-700">
                <span>Windows Mica</span>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-xs" />
              </div>
              <p className="text-slate-400 font-medium truncate mt-0.5">120 FPS AI 插帧</p>
            </div>
          </div>
        </div>

        {/* 侧边栏展开/收起切换按钮 (图标平滑切换 + 文字淡入淡出) */}
        <button
          type="button"
          onClick={toggleNavCollapsed}
          title={isNavCollapsed ? '展开导航栏' : '收起导航栏'}
          className="group relative flex items-center h-10 w-full rounded-xl font-medium text-xs text-slate-600 hover:text-slate-900 hover:bg-black/[0.04] transition-colors duration-150 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 active:scale-[0.98] overflow-hidden"
        >
          <div className="w-10 h-10 flex-shrink-0 relative flex items-center justify-center text-slate-500 group-hover:text-slate-800 transition-colors">
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
