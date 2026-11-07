import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, SlidersHorizontal, X } from 'lucide-react';

interface CategoryBarProps {
  /**
   * 站方题材词表。约定 `categories[0]` 是「全部」——chips 的选中态与面板高亮
   * 都依赖这一点。数量是动态的（多源合并），实测几十个是常态。
   */
  categories: string[];
  /** 当前选中的题材。 */
  value: string;
  onChange: (category: string) => void;
  /**
   * 受众（体裁）筛选：`全部 / 男频 / 女频`。
   *
   * 不传 `onAudienceChange` 时面板里不出现体裁段（动漫专区没有这个口径）。
   */
  audience?: string;
  onAudienceChange?: (audience: string) => void;
  /**
   * 打开进阶筛选弹窗（角色 / 年代 / 性别 / 完结状态）。
   *
   * 不传就不渲染面板里那行入口——动漫 / 神秘小窝没有对应的 App 筛选面板。
   */
  onAdvanced?: () => void;
  /**
   * 宿主的纵向滚动容器。
   *
   * 只用来判定「这条已经吸顶了没有」（吸顶后底色加深、投影出来）。不给也能用，
   * 只是整条一直保持未吸顶的淡底。
   */
  scrollRootRef?: React.RefObject<HTMLElement | null>;
}

const AUDIENCE_OPTIONS = ['全部', '男频', '女频'];

/**
 * 常驻题材条 —— 首页唯一的一条筛选控件（2026-11-07 第二轮）。
 *
 * ## 为什么从「一颗药丸」改回「常驻 chips」（上一版是怎么错的）
 *
 * 更早的一版把四个入口并排一行（体裁段 / 题材下拉 / 更多筛选 / 一排被裁切的
 * chips），用户说"太乱了，只保留一个"，于是收成了一颗药丸：题材藏进点开的面板。
 * 那一版解决的是"入口太多"，但顺手把**最高频的动作**（换题材看另一批剧）也藏了
 * 起来——换一个题材要先点开、再在一张几十项的网格里找、再点，页面还会跳回顶部。
 * 平均每次换题材三个动作，而这是本页最常做的事。
 *
 * 这一版分开两件事：
 *
 *   - **题材 = 高频、平铺**：横向 chips 直接铺在页面上，一步到位；
 *   - **筛选 = 低频、收进面板**：体裁与进阶条件点右侧那颗按钮才展开。
 *
 * 上一版的教训（"摆了四套系统"）仍然成立，所以这一版**没有再并排**：体裁段
 * 留在面板里（它是低频的，且与题材是共存维度）、题材下拉彻底消失（chips 就是
 * 它）、进阶筛选也留在面板里。页面上只有「一条 chips」+「一颗按钮」两样东西。
 *
 * ## 为什么要吸顶
 *
 * 首页往下是货架 + 目录网格，深度能到十几屏。筛选条如果随页面滚走，用户在底部
 * 换了三屏内容之后就再也够不到它，只能先滚回页首——那正是"要不要换题材"这个
 * 念头最常出现的位置。所以整条 `sticky top-0`：滚到哪儿都能直接换。
 *
 * 吸顶时底色从 `white/45` 提到 `white/92` 并补一层投影，未吸顶时几乎透明——
 * 条在页首时是"页首的一部分"，吸顶后才成为"浮在内容上的工具条"。这个切换由
 * 宿主滚动容器的 scroll 事件驱动（`scrollRootRef`），rAF 节流到每帧最多一次测量。
 *
 * ## 溢出：磁吸 + 箭头，而不是滚轮劫持
 *
 * 题材几十个，一屏放不下。这里**不劫持滚轮**（桌面端把竖向滚轮偷去做横向滚动，
 * 用户会以为页面滚不动了——项目里已经有过"滚动不动/错位"这类投诉）。改为：
 *
 *   - 轨道是 `scroll-snap-type: x mandatory`、每枚词条 `snap-start`：滚动停下时
 *     浏览器把落点吸附到最近的词条边界，**左缘永远是一枚完整的词条**，不会再
 *     有半个字挂在屏幕边上。之所以不用 JS 做磁吸：试过"两侧边缘都完整"的
 *     求解器，穷举后发现词条宽度参差时两侧同时完整的安全点稀疏且相距可达
 *     180px+——把落点拉走半个屏比残字更糟；而 CSS snap 只承诺一侧，恰好是
 *     被切得最显眼的那一侧（滚过去的内容在左缘被切，视觉上最刺眼）；
 *   - 右缘的"下一枚"由 12px 渐隐托出来（见 JSX 里的渐隐注释）：残端读作
 *     "正在进来"，而不是"被切掉一半"；
 *   - 两侧出现箭头（只在对应方向还有内容时出现），点一下翻 70% 屏宽，
 *     落点同样被 snap 修正；
 *   - 选中项变化时自动滚到把它作为左缘第一枚的位置（吸附语义下的合法
 *     停止点，换频道、从面板里选都算）；
 *   - 轨道本身照常支持触控板横滑 / Shift+滚轮。
 *
 * ## 关闭时机（面板）
 *
 * 点面板外部、按 Esc、选中题材、或面板外的任何元素发生滚动都关。滚动这条
 * 仍然必要：面板是绝对定位的浮层，虽然条本身吸顶不脱节，但用户滚页面时
 * 面板会一直挡着内容。
 */
export const CategoryBar: React.FC<CategoryBarProps> = ({
  categories,
  value,
  onChange,
  audience,
  onAudienceChange,
  onAdvanced,
  scrollRootRef,
}) => {
  const showAudience = typeof onAudienceChange === 'function';

  const [open, setOpen] = useState(false);
  /** 条是否已经吸顶（只影响底色与投影）。 */
  const [pinned, setPinned] = useState(false);
  /** 轨道左右两侧是否还有被藏起来的内容。 */
  const [edge, setEdge] = useState({ left: false, right: false });

  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  /** 面板里那一格里被选中的题材（展开时滚进视野用）。 */
  const selectedPanelRef = useRef<HTMLButtonElement | null>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /**
   * 按钮上的已选摘要：体裁、题材里凡是非默认的都带出来，顺序与面板一致。
   * 颗数就是筛选按钮上的角标——一颗药丸上写不下「筛选 · 男频 · 穿越 · …」，
   * 数字角标在窄窗口也不会把按钮撑开。
   */
  const activeSummary = [
    ...(audience && audience !== '全部' ? [audience] : []),
    ...(categories.length > 0 && value !== categories[0] ? [value] : []),
  ];

  /* ---------------- 轨道溢出检测 ---------------- */

  const syncEdge = useCallback(() => {
    const track = trackRef.current;
    if (!track) return;
    const max = track.scrollWidth - track.clientWidth;
    const left = track.scrollLeft > 2;
    const right = max > 2 && track.scrollLeft < max - 2;
    // 值没变就返回同一个对象：scroll 事件每帧都来，不能让无变化的测量穿透到渲染。
    setEdge(prev => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    syncEdge();
    track.addEventListener('scroll', syncEdge, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncEdge);
    observer?.observe(track);
    return () => {
      track.removeEventListener('scroll', syncEdge);
      observer?.disconnect();
    };
    // `categories.length` 进依赖：题材增减会改变内容宽度，但轨道自身尺寸不变，
    // ResizeObserver 看不到这种情况，只能靠这一个依赖补一次测量。
  }, [syncEdge, categories.length]);

  const scrollTrack = (direction: -1 | 1) => {
    const track = trackRef.current;
    if (!track) return;
    track.scrollBy({ left: direction * Math.max(160, track.clientWidth * 0.7), behavior: 'smooth' });
  };

  /* ---------------- 选中项自动居中 ---------------- */

  useEffect(() => {
    // 首帧轨道的 clientWidth 可能还是 0（切频道后重挂），等一帧再算。
    const raf = requestAnimationFrame(() => {
      const track = trackRef.current;
      const chip = track?.querySelector<HTMLButtonElement>('[data-active="true"]');
      if (!track || !chip) return;
      const max = Math.max(0, track.scrollWidth - track.clientWidth);
      // 吸附语义下轨道的合法停止点只有"某枚词条贴左缘"——居中目标会在滚动
      // 结束时被 mandatory snap 拉走，所以直接把选中项作为左缘第一枚滚过去。
      const next = Math.min(max, chip.offsetLeft);
      // 已经在目标附近就别再动了：每次渲染都滚一下会让条自己抖。
      if (Math.abs(next - track.scrollLeft) < 4) return;
      track.scrollTo({ left: next, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(raf);
  }, [value, categories.length]);

  /* ---------------- 吸顶检测 ---------------- */

  useEffect(() => {
    const root = scrollRootRef?.current;
    if (!root) return;
    let ticking = false;

    const measure = () => {
      ticking = false;
      const bar = rootRef.current;
      if (!bar) return;
      const delta = bar.getBoundingClientRect().top - root.getBoundingClientRect().top;
      setPinned(delta <= 1.5);
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(measure);
    };

    measure();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => root.removeEventListener('scroll', onScroll);
  }, [scrollRootRef]);

  /* ---------------- 面板的开合 ---------------- */

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
      // 轨道自己横滑（chips 超出屏宽时）不该把面板关掉；`e.target` 在捕获阶段
      // 就是那个真正发生滚动的元素，不是 document。
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
    selectedPanelRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);

  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };

  /** chips 之间用左右方向键挪焦点（只挪焦点，不切换——切换会换掉整份目录）。 */
  const handleChipKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const key = event.key;
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return;
    event.preventDefault();
    const target =
      key === 'Home'
        ? 0
        : key === 'End'
          ? categories.length - 1
          : Math.min(categories.length - 1, Math.max(0, index + (key === 'ArrowRight' ? 1 : -1)));
    chipRefs.current[target]?.focus();
  };

  const chipClass = (active: boolean) =>
    `shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs transition-colors duration-150 ${
      active
        ? 'fluent-convex-tab text-blue-600 font-bold'
        : // hover 底色取 slate-200：托盘（slate-100）上变深、白色面板上浮现，
          // 同一个类在两种底上都摸得到。
          'text-slate-600 hover:bg-slate-200/70 hover:text-slate-900'
    }`;

  return (
    /*
      `-mx-5 px-5` 抵消宿主的 `p-5`：整条铺满内容区（吸顶时左右不留缝），
      但里面的 chips 仍然对齐在宿主原本的内容左边线上。换宿主时这两个数字要跟着改。

      `-top-5` 是同一笔账的垂直版本。吸顶的参照是滚动容器的 **padding box**，
      而宿主给了 `p-5`——只写 `top-0` 的话条会停在距窗口顶 20px 的地方，
      那 20px 里滚动的内容会从条上边漏出来一条缝（实测）。上提一个 padding
      的高度，条就真正贴着内容区顶边了。
    */
    <div
      ref={rootRef}
      className={`sticky -top-5 z-30 -mx-5 flex min-w-0 items-center gap-2 border-b px-5 py-2 backdrop-blur-xl transition-[background-color,border-color,box-shadow] duration-200 ${
        pinned
          ? 'border-slate-200/80 bg-white/95 shadow-[0_10px_24px_-16px_rgba(15,23,42,0.28)]'
          : 'border-transparent bg-white/72'
      }`}
    >
      {/*
        题材托盘：与页首的频道 tab、三档入口是**同一套凹槽语言**（`bg-slate-100`
        + `shadow-inner` + 里面的凸起白片）。这一点不是审美偏好——上一版被投诉
        "摆成四套系统"的根因就是四样控件各长各样。现在页面上所有可点选项都读成
        "同一个托盘里的不同分段"，只有内容不同。
      */}
      <div className="relative flex min-w-0 flex-1 items-center gap-0.5 rounded-xl border border-slate-200/80 bg-slate-100 p-1 shadow-inner">
        {/*
          渐隐提示：把被视口边缘切住的词条残端淡掉。snap 之后左缘永远是完整
          贴边的一枚（字头距边缘 10px 内边距，12px 的渐变只蒙到它 17% 的透明度，
          读不出被遮），右缘的"下一枚"则从渐隐里浮现——是"正在进来"，而不是
          "被切掉一半"。26px = 托盘内边距 4 + 箭头 20 + 间隙 2，正好压在轨道
          视口边缘上（遮罩不能放进轨道内部：absolute 会跟着内容一起滚走）。
        */}
        {edge.left && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 left-[26px] z-10 w-3 bg-gradient-to-r from-slate-100 to-transparent" />
        )}
        {edge.left && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => scrollTrack(-1)}
            title="向前翻题材"
            className="flex h-6 w-5 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/80 hover:text-slate-700"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
        )}

        {/*
          `min-w-0` + `flex-1` 保证轨道自己可以被压窄（否则 chips 会把右侧的
          筛选按钮顶出屏幕）。滚动条由 `.ttv-no-scrollbar` 收掉——32px 高的托盘里
          压一条灰线会直接破坏那条水平基线，何况两侧箭头已经说明了"还有"。
          `snap-x snap-mandatory` + 每枚词条的 `snap-start` 就是边缘磁吸本体，
          为什么只吸一侧见组件头部的「溢出」段。
        */}
        <div
          ref={trackRef}
          role="group"
          aria-label="题材筛选"
          className="ttv-no-scrollbar snap-x snap-mandatory relative flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {categories.map((category, index) => {
            const active = category === value;
            return (
              <button
                key={category}
                ref={el => {
                  chipRefs.current[index] = el;
                }}
                type="button"
                data-active={active || undefined}
                aria-pressed={active}
                onClick={() => onChange(category)}
                onKeyDown={event => handleChipKeyDown(event, index)}
                title={category}
                className={`${chipClass(active)} snap-start`}
              >
                {category}
              </button>
            );
          })}
        </div>

        {/* 轨道右端：同上 */}
        {edge.right && (
          <span aria-hidden="true" className="pointer-events-none absolute inset-y-1 right-[26px] z-10 w-3 bg-gradient-to-l from-slate-100 to-transparent" />
        )}
        {edge.right && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => scrollTrack(1)}
            title="向后翻题材"
            className="flex h-6 w-5 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/80 hover:text-slate-700"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/*
        右侧筛选入口。摘要（「筛选 · 男频 · 穿越」）在窄窗口会把按钮一路撑宽，
        所以这里只留数字角标，完整摘要放 `title`；展开后体裁段与题材网格里
        本来就标着当前选了什么。
      */}
      <div className="relative shrink-0">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen(prev => !prev)}
          aria-expanded={open}
          aria-haspopup="true"
          title={
            activeSummary.length > 0
              ? `当前筛选：${activeSummary.join(' · ')}`
              : '打开筛选面板'
          }
          className={`inline-flex h-8 cursor-pointer items-center gap-1 rounded-xl border px-2.5 text-xs font-semibold shadow-inner transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${
            activeSummary.length > 0 || open
              ? 'border-blue-200/80 bg-blue-50/90 text-blue-600'
              : 'border-slate-200/70 bg-slate-100/90 text-slate-600 hover:text-slate-900'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>筛选</span>
          {activeSummary.length > 0 && (
            <span className="ml-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-blue-600 px-1 text-[10px] font-bold leading-none text-white tabular-nums">
              {activeSummary.length}
            </span>
          )}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </button>

        {open && (
          <div className="animate-fluent-slide-down absolute right-0 top-full z-50 mt-2 w-[560px] max-w-[calc(100vw-96px)] rounded-2xl border border-white/95 bg-white p-3 shadow-fluent-lg">
            {/* 体裁段：与题材是共存的两个维度，点它不收面板 */}
            {showAudience && (
              <div className="mb-2 flex items-center gap-2">
                <span className="shrink-0 text-[11px] font-semibold text-slate-400">体裁</span>
                <div className="flex items-center gap-1">
                  {AUDIENCE_OPTIONS.map(item => (
                    <button
                      key={item}
                      type="button"
                      onClick={() => onAudienceChange?.(item)}
                      className={chipClass((audience ?? '全部') === item)}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="text-xs font-bold text-slate-800">
                题材
                <span className="ml-1.5 font-normal text-slate-400">共 {categories.length} 个</span>
              </span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="收起筛选面板"
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {/* 面板按**原序**铺全量题材：它是参考表，位置稳定比跟手重要；
                chips 条一屏只放得下十来个，这张网格才是"到底有多少个题材"的答案。 */}
            <div className="grid max-h-[42vh] grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1 overflow-y-auto">
              {categories.map(category => (
                <button
                  key={category}
                  ref={category === value ? selectedPanelRef : undefined}
                  type="button"
                  onClick={() => pick(category)}
                  className={`cursor-pointer rounded-lg px-2 py-1.5 text-xs transition-colors duration-150 ${
                    category === value
                      ? 'fluent-convex-tab text-blue-600 font-bold'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>

            {/* 进阶筛选：App 原生弹窗（角色/年代/完结状态等，独立接口、独立分页），
                收成面板里的最后一行——它和体裁/题材不共享状态，是"再上一层"的入口。 */}
            {onAdvanced && (
              <>
                <div className="mb-2 mt-2.5 h-px bg-slate-200/60" />
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onAdvanced();
                  }}
                  title="按角色、年代、完结状态等进阶条件筛选"
                  className="flex w-full cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 text-left text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
                >
                  <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                  <span className="shrink-0">更多筛选</span>
                  <span className="truncate text-[11px] font-normal text-slate-400">
                    角色 · 年代 · 完结状态等进阶条件
                  </span>
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
