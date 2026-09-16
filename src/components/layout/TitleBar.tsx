import React from 'react';
import {
  Minus,
  Square,
  X,
  Search
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { isTauriEnvironment } from '../../services/ipc';
import { getCurrentWindow } from '@tauri-apps/api/window';

export const TitleBar: React.FC = () => {
  const { currentView, searchKeyword, setSearchKeyword, rememberSearch, navigateTo } = useAppStore();

  // 搜索框是全应用的搜索入口：聚焦即进入搜索页（焦点随后交给页内输入框），
  // 回车则先记一条历史再跳转。
  //
  // 旧实现只是把关键词写进 store、由发现页就地过滤列表——用户看不到"搜索结果
  // 页"，也没有任何历史，于是误以为搜索没生效。
  const enterSearch = () => {
    if (currentView !== 'search') navigateTo('search');
  };

  const handleDragStart = async (event: React.MouseEvent<HTMLElement>) => {
    if (event.button !== 0 || !isTauriEnvironment()) return;

    const target = event.target as HTMLElement;
    if (target.closest('[data-window-interactive]')) return;

    try {
      await getCurrentWindow().startDragging();
    } catch (err) {
      console.warn('Tauri window drag:', err);
    }
  };

  const handleWindowAction = async (action: 'minimize' | 'maximize' | 'close') => {
    if (isTauriEnvironment()) {
      try {
        const appWindow = getCurrentWindow();
        if (action === 'minimize') await appWindow.minimize();
        else if (action === 'maximize') await appWindow.toggleMaximize();
        else if (action === 'close') await appWindow.close();
      } catch (err) {
        console.warn('Tauri window action:', err);
      }
    }
  };

  return (
    <header 
      onMouseDown={handleDragStart}
      className="h-10 w-full flex items-center justify-between px-3 select-none bg-white/80 backdrop-blur-xl border-b border-black/[0.04] z-50 transition-colors duration-200"
    >
      {/* 左侧应用标识 */}
      <div className="flex items-center gap-2.5 min-w-[180px]" data-window-interactive>
        <div 
          onClick={() => navigateTo('explore')}
          className="flex items-center gap-2.5 cursor-pointer group py-1 px-1.5 rounded-xl hover:bg-black/[0.03] active:scale-95 transition-all focus:outline-none"
          title="TTV 短剧 - 返回发现精选"
        >
          {/* VidCom 品牌图标（透明底 PNG，来自图标库正方形主图标） */}
          <img
            src="/app-icon.png"
            alt="VidCom"
            className="w-5 h-5 object-contain group-hover:scale-105 transition-transform duration-200 flex-shrink-0"
            draggable={false}
          />

          <div className="flex items-center gap-1.5">
            <span className="font-bold text-xs tracking-tight text-slate-800 font-sans group-hover:text-blue-600 transition-colors">
              TTV 短剧
            </span>
            <span className="text-[9px] font-bold text-blue-600 bg-blue-50/90 px-1.5 py-0.5 rounded-md border border-blue-200/60 shadow-2xs">
              Mica
            </span>
          </div>
        </div>
      </div>

      {/* 中间全局搜索框 (仅在非播放器页显示，嵌入式凹槽样式) */}
      <div className="flex-1 max-w-md mx-4" data-window-interactive>
        {currentView !== 'player' && (
          <div className="relative w-full p-0.5 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner flex items-center">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              onFocus={enterSearch}
              onClick={enterSearch}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const keyword = searchKeyword.trim();
                  if (keyword) rememberSearch(keyword);
                  enterSearch();
                } else if (event.key === 'Escape') {
                  setSearchKeyword('');
                }
              }}
              placeholder="搜索短剧、漫剧、战神逆袭、豪门甜宠..."
              className="w-full h-7 pl-8 pr-7 text-xs bg-white text-slate-800 placeholder-slate-400 rounded-lg border-none focus:outline-none shadow-xs transition-all"
            />
            {searchKeyword && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setSearchKeyword('');
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* 右侧：干净清爽的 Windows 11 控制按钮（已移除旁边的多余状态） */}
      <div className="flex items-center -mr-2">
        <button
          type="button"
          data-window-interactive
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void handleWindowAction('minimize');
          }}
          className="w-11 h-10 flex items-center justify-center text-slate-600 hover:bg-slate-200/50 transition-colors"
          title="最小化"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          data-window-interactive
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void handleWindowAction('maximize');
          }}
          className="w-11 h-10 flex items-center justify-center text-slate-600 hover:bg-slate-200/50 transition-colors"
          title="最大化"
        >
          <Square className="w-3 h-3" />
        </button>
        <button
          type="button"
          data-window-interactive
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            void handleWindowAction('close');
          }}
          className="w-11 h-10 flex items-center justify-center text-slate-600 hover:bg-red-500 hover:text-white transition-colors"
          title="关闭"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </header>
  );
};
