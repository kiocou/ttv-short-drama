import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';

interface CategoryBarProps {
  /**
   * 站方题材词表。约定 `categories[0]` 是「全部」——折叠行的排序逻辑依赖这一点。
   * 数量是动态的（多源合并），实测几十个是常态。
   */
  categories: string[];
  /** 当前选中的题材。 */
  value: string;
  onChange: (category: string) => void;
}

/**
 * 题材筛选条：**折叠行 + 全量溢出面板**。
 *
 * ## 为什么不是横滚
 *
 * 改造前这里是一条 `overflow-x-auto` 的横滚条，配一个「更多 N」按钮。三个问题：
 *
 *   1. `slice(0, 8)` 是**硬编码**的，和容器宽度无关——宽窗口右边空一大块，窄窗口
 *      又放不下；两侧都不合理；
 *   2. 横滚条被 `scrollbar-width: none` 抹掉了滚动条，**溢出完全不可见**——用户
 *      根本不知道右边还压着二十多个题材；
 *   3. 「更多 N」只是把 8 个放开成全部，**内容仍然塞回同一条横滚里**，点了像没反应。
 *
 * 现在：折叠行**不换行也不横滚**，放不下的直接被裁掉，右缘一道渐隐把它读成
 * "右边还有"，而"还有多少、都有什么"交给 `全部题材 N` 这个入口。溢出的存在感
 * 从隐形变成显形，全量题材也终于有了一个正经容器。
 *
 * ## 两个不显眼但关键的细节
 *
 * **① 选中项前移。** 折叠行是裁切的，如果选中的是第 25 个题材，行里一个高亮的都
 * 没有——用户看不出当前在筛什么。所以选中的题材永远被拎到「全部」后面第二位。
 * 默认态下 `value === categories[0]`，不做任何重排，不会引入无谓跳动。
 *
 * **② 用 `overflow-hidden` 裁，而不是 `display:none`。** 不渲染的题材会让所有
 * 位置计算失效；裁切是纯视觉的，DOM 与顺序都不动。
 *
 * ## 关闭时机
 *
 * 点面板外部、按 Esc、选中任意题材、或**面板外的任何元素发生滚动**都关。滚动这条
 * 是必要的：面板是绝对定位的浮层，用户一滚页面它就会和锚点脱节，挂在半空比关掉更糟。
 */
export const CategoryBar: React.FC<CategoryBarProps> = ({ categories, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const selectedRef = useRef<HTMLButtonElement | null>(null);

  /** 「全部」钉在最前，选中的紧随其后，其余保持原序。 */
  const ordered = useMemo(() => {
    if (categories.length === 0) return categories;
    if (value === categories[0] || !categories.includes(value)) return categories;
    return [categories[0], value, ...categories.filter(item => item !== categories[0] && item !== value)];
  }, [categories, value]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onScroll = (event: Event) => {
      // 面板自己滚（题材很多时它会内部滚动）不该把它关掉；注意 `e.target` 在
      // 捕获阶段就是那个真正发生滚动的元素，不是 document。
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  /** 展开时把选中项滚进面板视野：几十个题材时，否则用户得自己找哪个是亮的。 */
  useEffect(() => {
    if (!open) return;
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  const chipClass = (active: boolean) =>
    `shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs transition-all duration-150 cursor-pointer ${
      active
        ? 'fluent-convex-tab text-blue-600 font-bold'
        : 'text-slate-600 hover:bg-white/60 hover:text-slate-900'
    }`;

  return (
    <div
      ref={rootRef}
      className="relative flex min-w-0 items-center gap-1 rounded-xl border border-slate-200/70 bg-slate-100/90 p-1 shadow-inner"
    >
      <span className="shrink-0 pl-1.5 pr-0.5 text-[11px] font-semibold text-slate-400">题材</span>

      {/*
        这里**必须**是 `overflow-x: clip` 而不是 `overflow-hidden`。
        `hidden` 会同时建立滚动容器、把纵向也变成 auto，选中态 chip 的
        `fluent-convex-tab`（0.5px 位移 + 一圈投影）上下沿就被切平了 —— 选中态
        会看起来像贴纸被裁过。`clip` 不建立滚动容器，所以 `overflow-y-visible`
        能真的生效，投影照常溢出；裁切只发生在横轴，正是我们要的。
      */}
      <div className="relative min-w-0 flex-1 overflow-x-clip overflow-y-visible">
        <div className="flex items-center gap-1">
          {ordered.map(category => (
            <button
              key={category}
              type="button"
              onClick={() => pick(category)}
              className={chipClass(category === value)}
            >
              {category}
            </button>
          ))}
        </div>
        {/* 右缘渐隐：把"被裁掉一半的题材"读成"右边还有"，而不是排版事故 */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-slate-100 via-slate-100/80 to-transparent"
        />
      </div>

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(prev => !prev)}
        aria-expanded={open}
        aria-haspopup="true"
        title={open ? '收起题材面板' : '展开全部题材'}
        className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg border-l border-slate-200/70 bg-white/75 px-2.5 text-[11px] font-semibold text-slate-500 transition-colors hover:text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      >
        全部题材
        <span className="font-bold text-slate-700">{categories.length}</span>
        <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="animate-fluent-slide-down absolute left-0 right-0 top-full z-50 mt-1.5 rounded-2xl border border-white/95 bg-white/95 p-3 shadow-fluent-lg backdrop-blur-xl">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-bold text-slate-800">
              全部题材
              <span className="ml-1.5 font-normal text-slate-400">共 {categories.length} 个</span>
            </span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="收起题材面板"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* 面板按**原序**铺，不跟着折叠行重排：它是全量参考表，位置稳定比跟手重要 */}
          <div className="grid max-h-[46vh] grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1 overflow-y-auto">
            {categories.map(category => (
              <button
                key={category}
                ref={category === value ? selectedRef : undefined}
                type="button"
                onClick={() => pick(category)}
                className={`cursor-pointer rounded-lg px-2 py-1.5 text-xs transition-all duration-150 ${
                  category === value
                    ? 'fluent-convex-tab text-blue-600 font-bold'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                {category}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
