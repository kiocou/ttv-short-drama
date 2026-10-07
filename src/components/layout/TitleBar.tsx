import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Minus,
  Square,
  Copy,
  X,
  Search,
  Clock,
  Trash2
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { ipcService, isTauriEnvironment } from '../../services/ipc';
import type { ChannelType, SeriesItem } from '../../types/catalog';
import { getCurrentWindow } from '@tauri-apps/api/window';

// 联想固定走 'drama'，和 SearchView 的 SEARCH_CHANNEL 同一结论：站点搜索接口
// 不做频道过滤，实测回来的全是剧集，漫剧/动漫混进来只会让联想更难认。
// 不要以为这里漏了频道切换。
const SUGGEST_CHANNEL: ChannelType = 'drama';
const MAX_SUGGESTIONS = 10;
// 与 guoapp/lib/search_input.dart 的 _cache 同值：32 条够用，超限按插入序
// 淘汰最旧的一条（LRU 近似——联想框的翻查率极低，做真 LRU 没收益）。
const SUGGEST_CACHE_LIMIT = 32;
const SUGGEST_LISTBOX_ID = 'titlebar-suggest-listbox';

/**
 * 标题栏窗口控制按钮的基类：只放三颗按钮共有的尺寸 / 字形 / 焦点环，
 * **刻意不含任何 hover / active 底色**。
 *
 * hover 底色用 `slate-500/10` 而非旧的 `slate-200/50`：标题栏本身就是 `bg-white/80`
 * 叠 Mica 玻璃，旧配色会在浅色玻璃上渲染出一块偏脏的灰块；低透明度中性色才能保持
 * “浮在玻璃上”的干净感。
 *
 * 为什么底色必须拆成下面两个成品类、不能拼在 BASE 里：同一个元素上并存两个
 * `hover:bg-*` 时，谁能生效由 **Tailwind 的输出顺序**决定，与 className 里的书写
 * 顺序无关（两者特异性相同，都是 0-2-0）。实测 tailwindcss 3.4.17 的产物里
 * `.hover\:bg-red-500:hover` 排在 `.hover\:bg-slate-500\/10:hover` **之前**
 * （默认调色板 slate/gray/zinc 一族在 red 一族之后），于是关闭键的红色恒被这里的
 * 灰色盖掉——三颗按钮的悬停高亮一直是灰的，`active` 态同理。
 */
const WIN_BUTTON_BASE =
  'w-9 h-10 flex items-center justify-center text-slate-600 ' +
  'transition-colors duration-150 outline-none focus-visible:ring-1 ' +
  'focus-visible:ring-inset focus-visible:ring-blue-500/60';

/** 最小化 / 最大化的中性悬停底色。 */
const WIN_BUTTON_NEUTRAL =
  `${WIN_BUTTON_BASE} hover:bg-slate-500/10 hover:text-slate-900 active:bg-slate-500/20`;

/** 关闭键：Win11 惯例的红色悬停底色（#C42B1C 系的近似值）。 */
const WIN_BUTTON_CLOSE =
  `${WIN_BUTTON_BASE} hover:bg-red-500 hover:text-white active:bg-red-600`;

interface SearchSuggestions {
  items: SeriesItem[];
  activeIndex: number;
  /** 直接透出 setState，键盘方向键要的是 updater 形式才能避免闭包读到旧索引。 */
  setActiveIndex: React.Dispatch<React.SetStateAction<number>>;
}

/**
 * 搜索联想：300ms 防抖 + generation 作废在途请求 + 32 条缓存。
 * 移植自 guoapp/lib/search_input.dart 的 _SearchInputState。
 *
 * 防抖在这里不是性能优化而是必需：`catalog_suggest` 要冷启动一个 Python
 * worker（实测端到端 0.6-1.9s），每次击键都打一次等于每敲一个键欠一条
 * worker，还会让慢响应乱序盖掉新关键词的结果。
 */
function useSearchSuggestions(keyword: string, enabled: boolean): SearchSuggestions {
  const [items, setItems] = useState<SeriesItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const cacheRef = useRef(new Map<string, SeriesItem[]>());
  // 只增不减：在途请求回来时对不上就说明关键词或开关已经变了，结果必须丢弃。
  // 清定时器只停掉"还没发出去"的请求，已经飞到后端的那条只能靠它作废。
  const generationRef = useRef(0);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    setItems([]);
    setActiveIndex(-1);
  }, []);

  useEffect(() => {
    const query = keyword.trim();
    // 浮层收起、IME 拼词中、输入为空都走这里；cancel() 顺带作废在途请求，
    // 所以"点外部关闭"和"清空输入"都不需要调用方额外收尾。
    if (!enabled || !query) {
      cancel();
      return;
    }
    setActiveIndex(-1);
    const cached = cacheRef.current.get(query);
    if (cached) {
      setItems(cached);
      return;
    }

    const generation = ++generationRef.current;
    const timer = window.setTimeout(() => {
      void ipcService.catalog
        .searchSuggest(query, SUGGEST_CHANNEL)
        .then((list) => {
          if (generationRef.current !== generation) return;
          // 联想是补充来源，ipc 层已把异常吞成空数组。这里再静默降级成
          // "只显示历史"：弹错误提示只会把一次可忽略的抖动放大成用户可见故障。
          const seen = new Set<string>();
          const deduped = list
            .filter((item) => {
              const title = item.title?.trim();
              if (!title || seen.has(title)) return false;
              seen.add(title);
              return true;
            })
            .slice(0, MAX_SUGGESTIONS);
          if (cacheRef.current.size >= SUGGEST_CACHE_LIMIT) {
            const oldest = cacheRef.current.keys().next().value;
            if (oldest !== undefined) cacheRef.current.delete(oldest);
          }
          cacheRef.current.set(query, deduped);
          setItems(deduped);
        })
        .catch(() => {
          if (generationRef.current === generation) setItems([]);
        });
    }, 300);

    return () => {
      window.clearTimeout(timer);
      generationRef.current += 1;
    };
  }, [keyword, enabled, cancel]);

  // 键盘把选中项移出可视区时滚回来（原生 select 会做，裸列表不会）。
  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(`titlebar-suggest-${activeIndex}`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return { items, activeIndex, setActiveIndex };
}

/**
 * 候选文本高亮：命中片段染主题色加粗。
 * 联想值普遍比关键词长得多（"重生之都市战神归来" vs "战神"），不标命中段用户
 * 看不出这条为什么被召回。
 */
const HighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let match = lower.indexOf(needle);
  while (match >= 0) {
    if (match > cursor) parts.push(text.slice(cursor, match));
    parts.push(
      <span key={`${match}-${cursor}`} className="text-blue-600 font-bold">
        {text.slice(match, match + needle.length)}
      </span>
    );
    cursor = match + needle.length;
    match = lower.indexOf(needle, cursor);
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
};

export const TitleBar: React.FC = () => {
  const {
    currentView,
    searchKeyword,
    setSearchKeyword,
    rememberSearch,
    navigateTo,
    searchHistory,
    removeSearchHistory,
    clearSearchHistory,
  } = useAppStore();
  const [showHistory, setShowHistory] = useState(false);
  // IME 拼词过程中拼音还没上屏，此刻发联想请求等于对着半个词去搜索，
  // 而且每次敲一个字母都会打一次后端。isComposing 为真时整个联想链路停摆。
  const [isComposing, setIsComposing] = useState(false);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);
  const suggestions = useSearchSuggestions(searchKeyword, showHistory && !isComposing);

  // 点击外部收起历史浮层（与播放器 HUD 的弹层同一套交互约定）。
  useEffect(() => {
    if (!showHistory) return;
    const handler = (event: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(event.target as Node)) {
        setShowHistory(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showHistory]);

  /**
   * 提交搜索：直接进入结果页（回车 / 点历史条目都走这里）。
   *
   * 顶部搜索框是全应用唯一的搜索输入（结果页里还有一个输入框的旧布局已移除），
   * 搜索历史则以浮层展示在这里的下方——不再需要通过一个中间页承载历史。
   */
  const submitSearch = (keyword: string) => {
    const trimmed = keyword.trim();
    if (!trimmed) return;
    setSearchKeyword(trimmed);
    rememberSearch(trimmed);
    setShowHistory(false);
    if (currentView !== 'search') navigateTo('search');
  };

  /** 方向键在联想项之间循环移动（到底回到 0、到顶跳到末条）。 */
  const moveActiveSuggestion = (step: number) => {
    const total = suggestions.items.length;
    if (total === 0) return;
    suggestions.setActiveIndex((prev) => {
      const next = prev + step;
      if (next < 0) return total - 1;
      if (next >= total) return 0;
      return next;
    });
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

  /**
   * 窗口最大化状态：决定中间那颗按钮画哪个图标。
   *
   * **不能像旧实现那样写死一个 `<Square/>`**：那样无论窗口处于什么状态都显示
   * “最大化”，用户点完图标纹丝不动，只能猜刚才那下到底生效没有（用户反馈的
   * “全屏/最大化后图标没变”就是这个）。而最大化状态还会被系统手势改变——
   * 双击标题栏、Win+↑、拖到屏幕上沿、任务栏按钮——所以状态必须以窗口真实查询
   * 为准，不能只在点击时乐观写一次。
   */
  const [isMaximized, setIsMaximized] = useState(false);
  const windowActionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!isTauriEnvironment()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    const sync = async () => {
      try {
        const actual = await getCurrentWindow().isMaximized();
        // 卸载后不再写状态：写入已无意义。
        if (!cancelled) setIsMaximized(actual);
      } catch {
        // 查询不可用（非 Tauri 或权限缺失）时保留当前显示，不谎报状态。
      }
    };

    void sync();
    void getCurrentWindow()
      .onResized(() => {
        void sync();
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const handleWindowAction = async (action: 'minimize' | 'maximize' | 'close') => {
    // 窗口线程的状态切换是异步的。连续双击最大化会把两个 toggle 排队，
    // 第二个 toggle 读到的仍是旧状态，最终表现成按钮闪烁或尺寸回弹。
    if (windowActionRef.current) return;
    if (isTauriEnvironment()) {
      const task = (async () => {
        try {
          const appWindow = getCurrentWindow();
          if (action === 'minimize') await appWindow.minimize();
          else if (action === 'maximize') await appWindow.toggleMaximize();
          else if (action === 'close') await appWindow.close();
          // toggleMaximize 是异步落到窗口线程的，返回时状态未必已生效；
          // 再查一次真实状态（onResized 也会补一次，避免图标滞后一帧）。
          if (action === 'maximize') setIsMaximized(await appWindow.isMaximized());
        } catch (err) {
          console.warn('Tauri window action:', err);
        }
      })();
      windowActionRef.current = task;
      await task.finally(() => {
        if (windowActionRef.current === task) windowActionRef.current = null;
      });
    }
  };

  return (
    <header 
      onMouseDown={handleDragStart}
      data-launch-part="titlebar"
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

      {/* 中间全局搜索框：全应用唯一的搜索输入（仅在非播放器页显示）。
          聚焦/点击在下方弹搜索浮层（上：联想建议，下：搜索历史）；
          回车提交选中的建议（没选中就提交输入框原文），点历史条目直接进结果页。 */}
      <div className="flex-1 max-w-md mx-4" data-window-interactive>
        {currentView !== 'player' && (
          <div
            ref={searchBoxRef}
            className="relative w-full p-0.5 bg-slate-100/90 rounded-xl border border-slate-200/70 shadow-inner flex items-center"
          >
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
            <input
              type="text"
              role="combobox"
              aria-expanded={showHistory}
              aria-controls={SUGGEST_LISTBOX_ID}
              aria-autocomplete="list"
              aria-activedescendant={
                suggestions.activeIndex >= 0
                  ? `titlebar-suggest-${suggestions.activeIndex}`
                  : undefined
              }
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              onFocus={() => setShowHistory(true)}
              onClick={() => setShowHistory(true)}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onKeyDown={(event) => {
                // IME 拼词中途的回车是"上屏候选词"，不是"提交搜索"。国内输入法
                // 下拼 "jubaoxianpen" 中途按回车会直接打一次无效搜索。
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  const active = suggestions.items[suggestions.activeIndex];
                  submitSearch(active ? active.title : searchKeyword);
                } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (suggestions.items.length === 0) return;
                  event.preventDefault();
                  moveActiveSuggestion(event.key === 'ArrowDown' ? 1 : -1);
                } else if (event.key === 'Escape') {
                  setSearchKeyword('');
                  setShowHistory(false);
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
                  // 清空多半意味着"换个词再搜"：顺手把历史浮层亮出来。
                  setShowHistory(true);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5 cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
            )}

            {/* 搜索浮层：挂在搜索框正下方，点击外部自动收起。
                上半区是联想建议（空结果时整块不渲染，静默退化成"只有历史"），
                下半区是原有的搜索历史。 */}
            {showHistory && (
              <div className="absolute left-0 right-0 top-full mt-1.5 z-50 rounded-2xl bg-white/95 backdrop-blur-xl border border-black/[0.06] shadow-fluent overflow-hidden animate-fluent-slide-down">
                {suggestions.items.length > 0 && (
                  <div className="pt-2">
                    <div className="flex items-center px-4 pb-1.5">
                      <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                        <Search className="w-3 h-3 text-blue-600" />
                        搜索建议
                      </span>
                    </div>
                    <div
                      id={SUGGEST_LISTBOX_ID}
                      role="listbox"
                      aria-label="搜索建议"
                      className="max-h-72 overflow-y-auto px-2 pb-2 flex flex-col gap-0.5"
                    >
                      {suggestions.items.map((item, index) => {
                        const isActive = suggestions.activeIndex === index;
                        return (
                          <button
                            key={item.id}
                            id={`titlebar-suggest-${index}`}
                            type="button"
                            role="option"
                            aria-selected={isActive}
                            onMouseEnter={() => suggestions.setActiveIndex(index)}
                            onClick={() => submitSearch(item.title)}
                            title={item.title}
                            className={`flex items-center gap-2 px-2.5 py-2 text-xs font-medium truncate rounded-xl transition-colors cursor-pointer ${
                              isActive
                                ? 'bg-blue-50/80 text-blue-700'
                                : 'text-slate-700 hover:bg-blue-50/80 hover:text-blue-700'
                            }`}
                          >
                            <Search className="w-3 h-3 flex-shrink-0 text-slate-400" />
                            <span className="truncate">
                              <HighlightedText text={item.title} query={searchKeyword} />
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="border-t border-black/[0.05]" />
                  </div>
                )}
                <div className="flex items-center justify-between px-4 pt-3 pb-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
                    <Clock className="w-3 h-3 text-blue-600" />
                    搜索历史
                  </span>
                  {searchHistory.length > 0 && (
                    <button
                      type="button"
                      onClick={clearSearchHistory}
                      className="flex items-center gap-1 text-[11px] font-semibold text-slate-400 hover:text-rose-600 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
                      清空
                    </button>
                  )}
                </div>
                {searchHistory.length === 0 ? (
                  <p className="px-4 pb-3.5 text-[11px] text-slate-400">
                    还没有搜索记录，输入剧名后回车即可搜索
                  </p>
                ) : (
                  <div className="max-h-72 overflow-y-auto px-2 pb-2 flex flex-col gap-0.5">
                    {searchHistory.map(keyword => (
                      <div
                        key={keyword}
                        className="group flex items-center rounded-xl hover:bg-blue-50/80 transition-colors"
                      >
                        <button
                          type="button"
                          onClick={() => submitSearch(keyword)}
                          className="flex-1 text-left px-2.5 py-2 text-xs font-medium text-slate-700 group-hover:text-blue-700 truncate cursor-pointer"
                          title={keyword}
                        >
                          {keyword}
                        </button>
                        <button
                          type="button"
                          onClick={() => removeSearchHistory(keyword)}
                          className="mr-1.5 w-5 h-5 rounded-md text-slate-300 hover:text-rose-600 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                          title="移除这条记录"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 右侧：Windows 11 标题栏控制按钮。
          宽度收到 w-9（原 w-11）：三颗按钮在 40px 标题栏里各占 36px 刚好，
          既保留 Win11 的“宽阔易点区”，又不再把左边的搜索框挤得偏窄。
          图标统一 w-3 / strokeWidth 1.75——三种字形粗细一致才像一套。 */}
      <div className="flex items-center">
        {(
          [
            {
              key: 'minimize',
              label: '最小化',
              className: WIN_BUTTON_NEUTRAL,
              icon: <Minus className="w-3 h-3" strokeWidth={1.75} />,
              onClick: () => handleWindowAction('minimize'),
            },
            {
              // 图标跟着窗口真实状态走：最大化时画“还原”（双层方框），
              // 否则用户点了看不出有没有生效（曾经写死 Square 导致永远不变）。
              key: 'maximize',
              label: isMaximized ? '向下还原' : '最大化',
              className: WIN_BUTTON_NEUTRAL,
              icon: isMaximized ? (
                <Copy className="w-3 h-3 -translate-x-[1.5px]" strokeWidth={1.75} />
              ) : (
                <Square className="w-3 h-3" strokeWidth={1.75} />
              ),
              onClick: () => handleWindowAction('maximize'),
            },
            {
              key: 'close',
              label: '关闭',
              className: WIN_BUTTON_CLOSE,
              icon: <X className="w-3 h-3" strokeWidth={1.75} />,
              onClick: () => handleWindowAction('close'),
            },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            data-window-interactive
            aria-label={item.label}
            title={item.label}
            className={item.className}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              void item.onClick();
            }}
          >
            {item.icon}
          </button>
        ))}
      </div>
    </header>
  );
};
