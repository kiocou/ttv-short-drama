import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  DANMAKU_LIFETIME_MS,
  DANMAKU_SPEED_LIFETIME_MS,
  DANMAKU_WINDOW_MS,
  DanmakuFlight,
  DanmakuLoader,
  planDanmaku,
} from '../../services/danmaku';
import { applyEmotes } from '../../services/danmakuEmoji';
import { ipcService } from '../../services/ipc';
import { tracePlayback } from '../../services/playbackTrace';

/**
 * 弹幕渲染层。
 *
 * ## 为什么不用 React 每帧重渲染
 *
 * 24 条弹幕 × 60fps = 每秒 1440 次状态更新，React 的重渲染与 diff 会把主线程
 * 占满，画面本身就开始掉帧。这里的做法是：**只有「这一页有哪些弹幕」是状态**，
 * 每一帧的位置直接写 DOM 的 `transform`（走合成器，不触发布局）。
 *
 * ## 为什么位置由 `video.currentTime` 算，而不是用 CSS 动画
 *
 * CSS 动画一旦启动就和媒体时钟脱钩：暂停时弹幕继续飞、拖动进度条时位置对不上、
 * 倍速播放时速度不跟随。用 `currentTime` 逐帧计算，这三种情况自动正确 ——
 * 暂停即静止、拖动即跳变到正确位置、倍速即同速。
 *
 * ## 轨道与密度
 *
 * 全部交给 `planDanmaku`（移植自真果鉴），本组件只负责把结果摆到屏幕上。
 * 轨道数不再写死：由「显示区域」设置（层高占比）与行高推导。
 *
 * ## 观感设置（2026-11-07 弹幕设置面板）
 *
 * 显示区域 / 不透明度 / 字号 / 速度 / 字体 / 粗体 / 描边全部来自 `DanmakuSettings`，
 * 由 `VideoSurface` / `AnimeVideoSurface` 从设置仓传入。速度档映射见
 * `DANMAKU_SPEED_LIFETIME_MS`；轨道判定与逐帧定位用**同一个**时长，慢/快档才不会
 * 「轨道算的是一套、飞行速度又是一套」。
 */

interface DanmakuOverlayProps {
  /**
   * 指向当前 `<video>` 的 ref。
   *
   * 收 ref 而不是元素本身：`VideoSurface` 首次渲染时元素还不存在，传元素值会
   * 让组件永远拿到 `null`（后续渲染不再变化，闭包里也读不到新值）。ref 对象
   * 本身是稳定的，逐帧读 `.current` 就能拿到实时元素。
   */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  seriesId: string;
  episodeId: string;
  enabled: boolean;
  /** 弹幕观感设置（显示区域/不透明度/字号/速度/字体/粗体/描边）。 */
  appearance: DanmakuSettings;
}

/** `UserSettings` 里弹幕观感字段的子集——渲染层只需要这一把。 */
export interface DanmakuSettings {
  danmakuArea: number;
  danmakuOpacity: number;
  danmakuFontScale: number;
  danmakuSpeed: number;
  danmakuFont: string;
  danmakuColor: string;
  danmakuBold: boolean;
  danmakuStroke: 'heavy' | 'outline' | 'shadow';
}

/** 基准字号（= 字号缩放 100% 时的值）。 */
const BASE_FONT_SIZE = 20;
const TOP_PADDING = 10;

/** 速度档（0 慢 / 1 适中 / 2 快）→ 飞行时长。越界回落适中。 */
function lifetimeOf(speed: number): number {
  return DANMAKU_SPEED_LIFETIME_MS[speed] ?? DANMAKU_LIFETIME_MS;
}

/** 描边类型 → 文本阴影。heavy 是引入设置前的原始观感。 */
function strokeShadow(stroke: DanmakuSettings['danmakuStroke']): string {
  switch (stroke) {
    case 'outline':
      // 细描边：四向 1px 纯黑（经典「描边」观感）。
      return '-1px 0 0 #000, 1px 0 0 #000, 0 -1px 0 #000, 0 1px 0 #000';
    case 'shadow':
      // 45° 投影：右下实影 + 柔和扩散。
      return '2px 2px 0 rgba(0,0,0,.72), 4px 4px 8px rgba(0,0,0,.5)';
    default:
      // 重墨：四向粗黑边 + 底部投影（原实现）。
      return '-1px -1px 0 rgba(0,0,0,.85), 1px -1px 0 rgba(0,0,0,.85), -1px 1px 0 rgba(0,0,0,.85), 1px 1px 0 rgba(0,0,0,.85), 0 2px 4px rgba(0,0,0,.6)';
  }
}

/** 用 canvas 量文本宽度：不进 DOM、不触发回流，比 span.offsetWidth 快一个量级。 */
function createMeasurer(fontSize: number, bold: boolean, font: string): (text: string) => number {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    // 极端环境（无 2d 上下文）退化成按字符数估算：宁可略宽也不能返回 0，
    // 否则所有弹幕宽度都是 0，轨道判定会全部挤在第一条轨道上。
    return (text: string) => text.length * fontSize * 0.6;
  }
  ctx.font = `${bold ? 'bold ' : ''}${fontSize}px "${font}", "Microsoft YaHei", -apple-system, sans-serif`;
  return (text: string) => ctx.measureText(text).width;
}

export const DanmakuOverlay: React.FC<DanmakuOverlayProps> = ({
  videoRef,
  seriesId,
  episodeId,
  enabled,
  appearance,
}) => {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const nodesRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const flightsRef = useRef<DanmakuFlight[]>([]);
  const widthRef = useRef(0);
  const [flights, setFlights] = useState<DanmakuFlight[]>([]);
  const [layerWidth, setLayerWidth] = useState(0);
  const [layerHeight, setLayerHeight] = useState(0);

  const fontSize = Math.round(BASE_FONT_SIZE * (appearance.danmakuFontScale / 100));
  const rowHeight = Math.max(24, Math.round(fontSize * 1.5));
  const lifetimeMs = lifetimeOf(appearance.danmakuSpeed);
  const measure = useMemo(
    () => createMeasurer(fontSize, appearance.danmakuBold, appearance.danmakuFont),
    [fontSize, appearance.danmakuBold, appearance.danmakuFont],
  );

  /**
   * 轨道数 = 实际层高 ÷ 行高。「显示区域」给的是层高占比（层高本身用百分比
   * 写进样式，随播放器尺寸缩放），量出来的像素高再换算成轨道，1–12 条夹紧。
   */
  const rows = Math.min(12, Math.max(1, Math.floor((layerHeight - TOP_PADDING) / rowHeight) || 1));

  // 加载器随「剧 + 集」重建：换集就该换一份缓存，否则上一集的弹幕会混进来。
  // 取数包装里顺带把平台表情码换成 emoji（量宽在替换之后，宽度天然正确）。
  const loaderRef = useRef<DanmakuLoader | null>(null);
  useEffect(() => {
    if (!enabled || !seriesId || !episodeId) {
      loaderRef.current?.dispose();
      loaderRef.current = null;
      return;
    }
    const loader = new DanmakuLoader(seriesId, episodeId, (sid, vid, startMs, durationMs) =>
      ipcService.playback.danmaku(sid, vid, startMs, durationMs).then(page => ({
        ...page,
        items: page.items.map(item => ({ ...item, text: applyEmotes(item.text) })),
      })),
    );
    loaderRef.current = loader;
    tracePlayback(`弹幕已启用 剧=${seriesId} 集=${episodeId}`);
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [enabled, seriesId, episodeId]);

  // 容器宽度/高度：宽度是轨道判定公式里的 `width`，高度决定轨道数，
  // 任一变化都必须重新规划。
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return undefined;
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect;
      const width = rect?.width ?? 0;
      const height = rect?.height ?? 0;
      setLayerWidth(current => (Math.abs(current - width) < 1 ? current : width));
      setLayerHeight(current => (Math.abs(current - height) < 1 ? current : height));
    });
    observer.observe(layer);
    return () => observer.disconnect();
  }, [enabled]);

  useEffect(() => {
    widthRef.current = layerWidth;
  }, [layerWidth]);

  // 主循环：拉页 + 逐帧定位，合成一个 rAF 节流（250ms 检查一次拉页，逐帧只算位置）。
  // 行高与飞行时长进了依赖：设置面板改字号/速度要立刻按新参数飞行。
  useEffect(() => {
    if (!enabled) {
      setFlights([]);
      flightsRef.current = [];
      return undefined;
    }
    let raf = 0;
    let lastEnsure = 0;
    let lastPageKey = '';

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const element = videoRef.current;
      if (!element) return;
      const loader = loaderRef.current;
      if (!loader) return;

      const positionMs = (element.currentTime || 0) * 1000;
      // 时长兜底（2026-11-07 稳定性）：个别 HLS 流在缓冲瞬间 duration 会读到
      // NaN/Infinity，旧实现就此拒绝拉页（durationMs=0），表现为弹幕莫名消失
      // 一段时间。拿「当前位置 + 一个窗口」顶上，保证 ensure 的门永远开着。
      const durationMs = (Number.isFinite(element.duration) && element.duration > 0
        ? element.duration
        : (element.currentTime || 0) + DANMAKU_WINDOW_MS / 1000) * 1000;
      const now = performance.now();

      // 1) 每 250ms 检查一次是否需要拉新页（拖着进度条快进时也能跟上）。
      if (now - lastEnsure > 250 && durationMs > 0) {
        lastEnsure = now;
        loader.ensure(positionMs, durationMs);
        const page = loader.pageFor(positionMs);
        const pageKey = page ? `${page.startMs}` : '';
        if (page && pageKey !== lastPageKey) {
          lastPageKey = pageKey;
          const planned = planDanmaku(page.items, {
            width: widthRef.current,
            rows,
            measure,
            lifetimeMs,
          });
          /*
           * 换页不清屏，带着**仍在飞行中**的旧弹幕一起显示（2026-11-07 稳定性）。
           *
           * 旧实现直接用新页的列表整体替换 —— 旧页里飞了一半的弹幕在 30s 边界
           * 上瞬间蒸发，正是「弹幕有时候会突然消失」的另一半来源。这里不替换：
           * 弹幕的定位只依赖 `positionMs - timeMs`（见下面第 2 步），每一条都
           * 按自己的时钟飞完然后自然隐藏，新旧两代在同一屏上无缝衔接；按 id
           * 去重防止两页重叠窗口里同一条弹幕出现两次。
           *
           * 代价：新旧两代各自独立排轨，边界后 8s 内理论上可能同轨道相叠 ——
           * 概率低、时间短，比"飞着飞着消失"好得多。
           */
          const alive = flightsRef.current.filter(f => {
            const elapsed = positionMs - f.item.timeMs;
            return (
              elapsed >= 0 &&
              elapsed < lifetimeMs &&
              !planned.some(p => p.item.id === f.item.id)
            );
          });
          const merged = [...alive, ...planned];
          flightsRef.current = merged;
          setFlights(merged);
        } else if (!page && lastPageKey) {
          /*
           * 页间隙（预取没赶上 / 请求失败冷却中）：**不清屏**。
           *
           * 旧实现在这里清空列表制造"突然消失"；而飞行中的弹幕各自按
           * `positionMs - timeMs` 定位，时机永远是正确的——让它们自然飞完，
           * 新页到达后上面的合并分支会把两代接起来。清屏没有收益，只有闪断。
           */
          lastPageKey = '';
        }
      }

      // 2) 逐帧定位：只改 transform/opacity，不产生 React 更新。
      const width = widthRef.current;
      if (width <= 0) return;
      for (const flight of flightsRef.current) {
        const node = nodesRef.current.get(flight.item.id);
        if (!node) continue;
        const elapsed = positionMs - flight.item.timeMs;
        if (elapsed < 0 || elapsed > lifetimeMs) {
          if (node.style.opacity !== '0') node.style.opacity = '0';
          continue;
        }
        const progress = elapsed / lifetimeMs;
        const x = width - (width + flight.width) * progress;
        node.style.transform = `translate3d(${x.toFixed(1)}px, ${
          TOP_PADDING + flight.lane * rowHeight
        }px, 0)`;
        if (node.style.opacity !== '1') node.style.opacity = '1';
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled, videoRef, rows, measure, lifetimeMs, rowHeight]);

  // 清掉已不在列表里的节点引用。
  useEffect(() => {
    const alive = new Set(flights.map(flight => flight.item.id));
    for (const id of [...nodesRef.current.keys()]) {
      if (!alive.has(id)) nodesRef.current.delete(id);
    }
  }, [flights]);

  if (!enabled) return null;

  return (
    <div
      ref={layerRef}
      className="absolute inset-x-0 top-0 pointer-events-none overflow-hidden"
      style={{
        // 显示区域 = 占播放器高度的百分比；透明度挂在整层，字号/字体/描边
        // 由每条弹幕继承。层高变化由 ResizeObserver 换算成轨道数。
        height: `${Math.min(100, Math.max(25, appearance.danmakuArea))}%`,
        opacity: Math.min(1, Math.max(0.1, appearance.danmakuOpacity / 100)),
        fontFamily: `"${appearance.danmakuFont}", "Microsoft YaHei", -apple-system, sans-serif`,
        fontWeight: appearance.danmakuBold ? 700 : 400,
        zIndex: 25,
      }}
      aria-hidden
    >
      {flights.map(flight => (
        <div
          key={flight.item.id}
          ref={node => {
            if (node) nodesRef.current.set(flight.item.id, node);
            else nodesRef.current.delete(flight.item.id);
          }}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            whiteSpace: 'nowrap',
            fontSize,
            lineHeight: `${rowHeight}px`,
            // 文字颜色来自设置（色板/取色器）。必须显式声明：继承父层的颜色
            // 不可靠，深色主题下会被带成深灰、视频上直接看不清。
            color: appearance.danmakuColor,
            textShadow: strokeShadow(appearance.danmakuStroke),
            opacity: 0,
            willChange: 'transform',
          }}
        >
          {flight.text}
        </div>
      ))}
    </div>
  );
};

export default DanmakuOverlay;
