import { tracePlayback } from './playbackTrace';

/**
 * 弹幕：窗口调度、缓存与轨道规划。
 *
 * ## 来源
 *
 * 算法移植自「真果鉴」的 Flutter 实现（`lib/danmaku_models.dart`、
 * `lib/danmaku_overlay.dart` 的 `planDanmaku`）。那边经过实机验证，这里只改
 * 运行宿主（Flutter → Web），判据与常量一个都不改：改了就会出现「同一集在两边
 * 观感不同」这种最难排查的问题。
 *
 * ## 三个常量为什么是这三个值
 *
 * - `WINDOW_MS = 30s`：一页弹幕覆盖 30 秒。短剧单集 40~90 秒，一页基本能覆盖
 *   大半集；窗口再大，拖动进度条时要等整页返回才有弹幕。
 * - `LIFETIME_MS = 8s`：一条弹幕从右飘到左用 8 秒。这是轨道判定公式里的分母，
 *   也是「同一轨道前一条是否已经让开」的唯一时间基准。
 * - 同屏上限 24 条 / 最多 4 条轨道：超出就不显示（`planDanmaku` 直接跳过），
 *   而不是叠着渲染 —— 叠起来会糊成一片，比不显示更糟。
 */

/** 单页覆盖的时间窗（毫秒）。必须与 Rust 侧 `DANMAKU_WINDOW_MS` 一致。 */
export const DANMAKU_WINDOW_MS = 30_000;

/** 一条弹幕从右到左的飞行时长（毫秒）。**适中档**的值，也是轨道判定公式的原始分母。 */
export const DANMAKU_LIFETIME_MS = 8_000;

/**
 * 速度档 → 飞行时长。慢/适中/快三档（2026-11-07 弹幕设置面板）：
 * 适中就是移植自真果鉴的 8s 原值，慢/快向两侧拉——值越大飘得越慢。
 */
export const DANMAKU_SPEED_LIFETIME_MS = [12_000, 8_000, 5_000] as const;

/** 同一时刻最多显示多少条（超过的直接丢弃）。 */
const MAX_ONSCREEN = 24;

/**
 * 最多几条轨道。原来写死 4（密度与可读性的折中），2026-11-07 起「显示区域」
 * 交给了用户：层高随区域滑条变化，轨道数按实际层高 ÷ 行高推导，这里只做
 * **上限护栏**。同屏 24 条的密度上限不变，轨道多了也不会糊成一片。
 */
const MAX_LANES = 12;

/** 轨道内前后两条之间的最小水平间隙（像素）。 */
const LANE_GAP_PX = 24;

/** 单条文本上限（字符）。超出截断并补省略号。 */
const TEXT_LIMIT = 100;

/** 命中缓存的有效期：弹幕列表变化极慢，5 分钟内不重复请求。 */
const PAGE_TTL_MS = 5 * 60_000;

/**
 * 距窗口终点多近时预取下一页。
 *
 * 2026-11-07 稳定性修复的主闸：旧实现只拉「当前位置所在页」，位置跨过 30s
 * 边界的那一刻才发请求 —— 网络往返的几百毫秒里无页可显示，屏幕先清空再恢复，
 * 这就是用户报告的「弹幕有时候会突然消失」。提前 8s 备好下一页（3 倍加速下
 * 也有 ~2.7s 的真实时间余量），边界穿越变成纯缓存命中。
 */
const PREFETCH_LEAD_MS = 8_000;

/**
 * 失败后的重试冷却，按同窗连续失败次数递增：3s → 8s → 15s。
 *
 * 旧实现一刀切 15s：一次网络抖动就让当前窗口空白 15 秒——对「弹幕消失」的
 * 感知来说跟坏了没区别。现在瞬时抖动 3 秒就补上；真正的设备风控（连续失败）
 * 仍会指数式退到 15s，不会打爆接口。
 */
const RETRY_COOLDOWNS_MS = [3_000, 8_000, 15_000] as const;

/** 同时缓存多少页（按离当前播放位置的距离淘汰）。 */
const PAGE_CACHE_LIMIT = 6;

export interface DanmakuItem {
  id: string;
  text: string;
  timeMs: number;
}

export interface DanmakuPage {
  episodeId: string;
  startMs: number;
  nextMs: number;
  total: number;
  items: DanmakuItem[];
}

export interface DanmakuFlight {
  item: DanmakuItem;
  text: string;
  lane: number;
  width: number;
}

/**
 * 按时间点把弹幕分配到轨道上。
 *
 * 三条判据（缺一条都会看到重叠或追尾）：
 *
 * 1. 该轨道还空着；
 * 2. 距上一条已超过 `LIFETIME_MS`（上一条早已飞出屏幕）；
 * 3. 上一条**已经整体进入屏幕**，且这一条**不会在屏幕上追上它**。
 *
 * 第 3 条是两段不等式，对应「前车尾部离开右边缘」与「后车头部到前车尾部的距离
 * 始终不小于 `LANE_GAP_PX`」。两条同时成立才能放同一轨道 —— 只检查其中一条，
 * 长弹幕跟短弹幕会撞在一起。
 *
 * `measure` 由调用方提供（DOM 里通常是 canvas `measureText`），因为文本宽度只有
 * 渲染环境知道，算法本身不该依赖 DOM。
 */
export function planDanmaku(
  items: DanmakuItem[],
  options: {
    width: number;
    rows: number;
    measure: (text: string) => number;
    /** 一条弹幕的飞行时长。缺省 = 适中档（8s 原值）。 */
    lifetimeMs?: number;
  },
): DanmakuFlight[] {
  const { width, rows, measure } = options;
  const lifetimeMs = options.lifetimeMs ?? DANMAKU_LIFETIME_MS;
  if (!Number.isFinite(width) || width <= 0 || rows < 1 || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    return [];
  }

  const lanes: (DanmakuFlight | null)[] = new Array(
    Math.min(Math.max(rows, 1), MAX_LANES),
  ).fill(null);
  const sorted = [...items].sort((a, b) => a.timeMs - b.timeMs);
  const seen = new Set<string>();
  const flights: DanmakuFlight[] = [];

  for (const item of sorted) {
    if (!item.id || !item.text.trim() || item.timeMs < 0 || seen.has(item.id)) continue;
    seen.add(item.id);

    // 同屏密度上限：统计最近 8 秒内已经排进去的条数。
    let recent = 0;
    for (let i = flights.length - 1; i >= 0; i -= 1) {
      if (item.timeMs - flights[i].item.timeMs < lifetimeMs) recent += 1;
      else break;
    }
    if (recent >= MAX_ONSCREEN) continue;

    const chars = [...item.text];
    const text = chars.length > TEXT_LIMIT
      ? `${chars.slice(0, TEXT_LIMIT).join('')}…`
      : item.text;
    const size = Math.ceil(measure(text)) + 8;

    const lane = lanes.findIndex(previous => {
      if (!previous) return true;
      const gap = item.timeMs - previous.item.timeMs;
      if (gap >= lifetimeMs) return true;
      const previousTailClear =
        ((width + previous.width) * gap) / lifetimeMs - previous.width >= LANE_GAP_PX;
      const noCatchUp =
        width - ((width + size) * (lifetimeMs - gap)) / lifetimeMs >= LANE_GAP_PX;
      return previousTailClear && noCatchUp;
    });

    if (lane < 0) continue;
    const flight: DanmakuFlight = { item, text, lane, width: size };
    lanes[lane] = flight;
    flights.push(flight);
  }

  return flights;
}

interface CacheEntry {
  page: DanmakuPage;
  at: number;
}

/**
 * 弹幕分页加载器：负责「当前播放位置需要哪一页」以及缓存/冷却。
 *
 * 不持有 DOM、不持有 video 元素 —— 调用方把 `position` 喂进来即可，这样
 * 播放器、小窗（将来）可以各用一份实例而共享同一套判据。
 */
export class DanmakuLoader {
  private pages = new Map<number, CacheEntry>();
  private pending = new Map<number, Promise<void>>();
  private cooldownUntil = new Map<number, number>();
  /** 同窗连续失败次数：驱动递增冷却（成功一次即清零）。 */
  private failures = new Map<number, number>();

  constructor(
    private readonly seriesId: string,
    private readonly episodeId: string,
    private readonly fetchPage: (
      seriesId: string,
      vid: string,
      startMs: number,
      durationMs: number,
    ) => Promise<DanmakuPage>,
  ) {}

  /** 覆盖 `positionMs` 的页（命中缓存才算）。 */
  pageFor(positionMs: number): DanmakuPage | null {
    for (const entry of this.pages.values()) {
      if (positionMs >= entry.page.startMs && positionMs < entry.page.nextMs) {
        return entry.page;
      }
    }
    return null;
  }

  /**
   * 确保 `positionMs` 所在的那一页已在加载或已就绪；临近窗口终点时**预取下一页**。
   *
   * 窗口起点按 30 秒对齐，这样拖动进度条回来时能命中同一页，而不是因为
   * 「从 12.3 秒开始」和「从 12.4 秒开始」算成两页、把缓存打散。
   */
  ensure(positionMs: number, durationMs: number): void {
    if (!Number.isFinite(positionMs) || positionMs < 0) return;
    if (!Number.isFinite(durationMs) || durationMs <= 0) return;
    const start = Math.floor(positionMs / DANMAKU_WINDOW_MS) * DANMAKU_WINDOW_MS;
    this.requestWindow(start, positionMs, durationMs);

    // 预取：位置进入本窗口的最后 8 秒就把下一页备好（见 PREFETCH_LEAD_MS 注释）。
    // 已是最后一页（nextStart ≥ 集长）时不发——服务端会返回空页，纯浪费。
    const nextStart = start + DANMAKU_WINDOW_MS;
    if (
      positionMs >= start + DANMAKU_WINDOW_MS - PREFETCH_LEAD_MS &&
      nextStart < durationMs
    ) {
      this.requestWindow(nextStart, positionMs, durationMs);
    }
  }

  /** 拉一页（带缓存命中 / 在途单飞 / 递增冷却三道闸）。 */
  private requestWindow(start: number, positionMs: number, durationMs: number): void {
    if (this.pageFor(start) || this.pending.has(start)) return;

    const cooldown = this.cooldownUntil.get(start);
    if (cooldown && Date.now() < cooldown) return;

    const task = this.fetchPage(this.seriesId, this.episodeId, start, durationMs)
      .then(page => {
        this.pages.set(start, { page, at: Date.now() });
        this.cooldownUntil.delete(start);
        this.failures.delete(start);
        this.prune(positionMs);
        // 打点：弹幕"看不到"时要能立刻区分「没取到」和「取到了没画」。
        // 没有这一行，失败被下面的 catch 静默吞掉，界面上只剩"一条都没有"。
        tracePlayback(
          `弹幕页就绪 起点=${start}ms 条数=${page.items.length} 窗口=${page.startMs}-${page.nextMs}`,
        );
      })
      .catch((error: unknown) => {
        const attempts = this.failures.get(start) ?? 0;
        this.failures.set(start, attempts + 1);
        const cooldown = RETRY_COOLDOWNS_MS[Math.min(attempts, RETRY_COOLDOWNS_MS.length - 1)];
        this.cooldownUntil.set(start, Date.now() + cooldown);
        tracePlayback(
          `弹幕页失败 起点=${start}ms 第${attempts + 1}次 冷却${cooldown / 1000}s 原因=${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.pending.delete(start);
      });

    this.pending.set(start, task);
  }

  /** 只保留离当前位置最近的几页，避免长剧把内存撑大。 */
  private prune(positionMs: number): void {
    const now = Date.now();
    for (const [start, entry] of [...this.pages]) {
      if (now - entry.at > PAGE_TTL_MS) this.pages.delete(start);
    }
    if (this.pages.size <= PAGE_CACHE_LIMIT) return;
    const sorted = [...this.pages.entries()].sort(
      (a, b) => Math.abs(a[0] - positionMs) - Math.abs(b[0] - positionMs),
    );
    for (const [start] of sorted.slice(PAGE_CACHE_LIMIT)) {
      this.pages.delete(start);
    }
  }

  dispose(): void {
    this.pages.clear();
    this.pending.clear();
    this.cooldownUntil.clear();
    this.failures.clear();
  }
}
