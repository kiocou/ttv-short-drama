/**
 * m3u8 源挂载工具。
 *
 * WebView2（Chromium）原生不支持 HLS。动漫专区走本地 HLS 代理（Rust hls_proxy
 * 已把 m3u8 重写为本地分片流），但 video.src 直接指 m3u8 在 Chromium 上仍然不
 * 行——必须由 hls.js 在 MSE 上解包。这个工具负责：
 *   1. 原生支持（Safari/部分 WebView）→ 直接 src；
 *   2. 否则动态 import hls.js 挂到 video 元素上。
 *
 * 调用方只管 `attachSource(video, url)`。
 *
 * 清理有两个入口，别混用：
 *   - `detachSource(video)`   —— 连 `src` 一起清（准备换源时用）；
 *   - `releaseAttachedSource(video)` —— **只**拆 hls.js 实例，不动 `src`。
 *     离开动漫专区时必须用这个：应用只有一块常驻 `<video>`（VideoSurface），
 *     动漫挂上的 hls.js 会接管这块元素；不清掉的话，短剧/漫剧再往上面写
 *     `src` 仍被 MSE 接管，表现就是"播过动漫之后别的都播不了"。
 *     不动 `src` 是为了保住旧帧（清 `src` 会触发媒体加载算法、画面转黑）。
 */
import { redactUrl, tracePlayback, urlShape } from './playbackTrace';

interface HlsInstance {
  destroy(): void;
  loadSource(url: string): void;
  attachMedia(video: HTMLVideoElement): void;
  /** 重新开始拉流（用于分片/清单的临时失败）。 */
  startLoad(startPosition?: number): void;
  /** 重建解码器与 SourceBuffer（用于缓冲类错误）。 */
  recoverMediaError(): void;
}

const HLS_KEY = '__ttv_hls__';

/**
 * 让 hls.js **从指定位置**开始拉流，而不移动播放头。
 *
 * ## 为什么需要这个（2026-10-24）
 *
 * 用户点了进度条上"还没转好"的位置时，播放器不能把播放头推到可寻址末端
 * （那正是"点击跳到转码最后位置"这个 bug），但也不能什么都不做 ——
 * hls.js 是**按播放位置**决定拉哪一片的，播放头不动，目标位置那片永远不会被请求，
 * `seekable.end` 也就永远长不到目标值。
 *
 * 正确做法是直接命令它：`startLoad(position)` 会让加载器按新位置重建
 * `startPosition` 并从那里拉清单/分片，**完全不碰 `video.currentTime`**。
 * 转码追上之后，上层再真正落位。
 *
 * 非 hls 源（原生 `<video src>`）没有这个能力：那种情况由浏览器自己的
 * Range 请求处理，直接赋值即可，本函数是空操作。
 *
 * @returns 是否真的下达了"从该位置拉流"的命令（供调用方打点）。
 */
export function hintHlsLoadPosition(video: HTMLVideoElement, seconds: number): boolean {
  const hls = (video as unknown as Record<string, unknown>)[HLS_KEY] as HlsInstance | undefined;
  if (!hls || typeof hls.startLoad !== 'function') return false;
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  try {
    hls.startLoad(seconds);
    return true;
  } catch {
    // 实例正在销毁/尚未 attach：忽略，下一拍再试。
    return false;
  }
}

/**
 * 元素上登记的「按倍速调整缓冲目标」回调。
 *
 * 播放器只有一块常驻 `<video>`，换集不换元素。不登记回调就没法在
 * `detachSource` 时摘掉 `ratechange` 监听器，几十集下来会累积几十个。
 */
const RATE_TARGET_KEY = '__ttvRateTarget';

/**
 * 判死前允许 hls.js 自己重来的次数。
 *
 * hls.js 把分片/缓冲类错误升级成 `fatal` 时，源往往**仍然可用**：本地转码是
 * "边转边播"，某个分片还没生成、或者 SourceBuffer 追不上，几秒后自己就好了。
 * 旧实现一看到 fatal 就把错误抛给上层（上层再弹错误卡），等于把一次临时失败
 * 定死成故障。
 */
const MAX_IN_PLACE_RECOVERY = 2;

/** 网络类致命错误：重新拉一次分片/清单即可，不需要重建解码器。 */
const RECOVERABLE_NETWORK_DETAILS = new Set([
  'fragLoadError',
  'fragLoadTimeout',
  'levelLoadError',
  'levelLoadTimeout',
]);

/**
 * 缓冲类致命错误：SourceBuffer 真的坏掉了，重建 MSE 后再继续。
 *
 * ⚠️ `bufferStalledError` **不在**这里（2026-10-20 复查修正）。
 *
 * hls.js 1.7.3 里它有两个发送点（`gap-controller.ts`）：
 *   - `_reportStall`（:557）：`fatal: false`，只是提示"缓冲空了"；
 *   - `_tryNudgeBuffer`（:712）：`fatal: true`，但它的触发条件恰恰是
 *     **"缓冲里明明有足够的数据，播放头就是不往前走，nudge 了 nudgeMaxRetry 次仍不动"**。
 *
 * 也就是说这个 fatal 的语义是"**数据在、就是解不出下一帧**"——末尾末帧的现场
 * 正是如此（容器时长比末帧 PTS 长几十毫秒，播放头走不到 `duration`）。
 *
 * 对它调 `recoverMediaError()` 的后果是清空 SourceBuffer、重建 MSE，把末尾已经
 * 完整缓冲的那一段全部丢掉重下。而它同时是 `playbackTail` 里"停在可播末端"
 * 判定的证据源：缓冲被清成 0.x 秒之后，那次判定就再也读不到 `buffered.end ≈ duration`。
 * 两边互相拆台，末尾只会更晚才判出来。
 *
 * 正确归属是上层：末尾 → 当作播完信号（`usePlaybackStore` 的 `waiting` 复核与
 * 看门狗）；中段 → 由看门狗的三信号停滞计时处理，它比"重建 MSE"克制得多。
 */
const RECOVERABLE_BUFFER_DETAILS = new Set([
  'bufferAppendError',
  'bufferAppendNoProgress',
]);

/**
 * hls.js 判死时留下的可读标记（错误明细字符串）。
 *
 * 存在的唯一理由：`HTMLMediaElement.error` 是只读的，`dispatchEvent(new Event('error'))`
 * 改不动它，因此调用方无法用 `video.error` 分辨"浏览器真的解码失败"与"hls.js 判死"。
 * 详见下面 ERROR 回调里的长注释。
 */
export const HLS_FATAL_KEY = '__ttvHlsFatal';

/** 读取并清除 hls.js 的判死标记。`null` 表示没有发生过 fatal。 */
export function takeHlsFatal(video: HTMLVideoElement): string | null {
  const record = video as unknown as Record<string, unknown>;
  const value = record[HLS_FATAL_KEY];
  if (typeof value !== 'string') return null;
  delete record[HLS_FATAL_KEY];
  return value;
}

/** 源即将被换掉：清掉上一次的判死标记，避免它污染下一次判死。 */
export function clearHlsFatal(video: HTMLVideoElement): void {
  delete (video as unknown as Record<string, unknown>)[HLS_FATAL_KEY];
}

export function isHlsUrl(url: string): boolean {
  return url.includes('.m3u8') || url.includes('/stream?u=');
}

/**
 * 环境是否**真的**支持原生 HLS 播放。
 *
 * ⚠️ 这条判定曾经是 `!!video.canPlayType('application/vnd.apple.mpegurl')`，而它是错的：
 * Chromium / WebView2 对这个 MIME 返回 **`"maybe"`**（谎报），于是短剧的增强 HLS 与
 * 动漫 HLS 都被判成"原生可播"、直接挂给 `<video src>` —— 而 Chromium 根本没有 HLS
 * 解复用器。实测的后果各不相同但都很难看：动漫那边是"有声音、无画面、黑屏 15 秒"
 * （见 `animePlayback.ts` 文件头第 2 点），短剧流式源这边是**挂上后 4 毫秒就 error**
 * （`ttv-playback.log`：`起播 直挂完成 形态=VSR转码HLS 耗时=1ms` → 紧接 `流式源报错`）。
 *
 * 现在改为"只在**确实没有** MSE 时才考虑原生"：MSE 是 hls.js 的硬前提，有 MSE 就一律
 * 走 hls.js。真正原生支持 HLS 的平台（Safari / iOS WebView）也支持 MSE，但它们走
 * hls.js 会多一层开销——所以**保留**一个明确的"我是 Apple 内核"判定，那种环境才直挂。
 *
 * 判据用 `canPlayType` 的返回值**只认 `"probably"`**（Safari 返回它；Chromium 返回
 * `"maybe"`），并且必须同时不具备 MSE。这样 Chromium 再谎报也骗不过去。
 */
export function nativeHlsSupported(video: HTMLVideoElement): boolean {
  // 有 MSE 就交给 hls.js：这是应用在 WebView2 上的唯一可行通路。
  if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')) {
    return false;
  }
  // 没有 MSE（老环境 / 极少数嵌入式内核）：只能指望原生，此时只认 "probably"。
  return video.canPlayType('application/vnd.apple.mpegurl') === 'probably';
}

export async function attachSource(
  video: HTMLVideoElement,
  url: string,
  /**
   * 这一集该从第几秒开始（默认 0 = 从头）。
   *
   * ## 为什么必须由调用方显式给（2026-10-24 修「画中画换集不从 0 开始」）
   *
   * hls.js 的 `startPosition` 默认值是 **-1**，语义是"拿 `media.currentTime` 当起点"
   * —— 也就是说**换集时的起播位置取决于元素上残留的旧值**。
   *
   * 而 `detachSource` 里的 `removeAttribute('src')` 虽然按规范会把 `currentTime`
   * 归 0，但那是媒体加载算法在**任务队列里异步**执行的；紧接着的 `hls.attachMedia`
   * / `hls.loadSource` 是同步的，读到的是**还没被归零**的那个值。于是：
   *
   *   上一集播到 40s → 换集 → hls.js 以为"这一集也从 40s 开始" → 进度条不从 0
   *   走、只播剩下那一小段，本集后半段永远看不到。
   *
   * 调用方在 `attachSource` **之后**写 `video.currentTime = 0` 也来不及：hls.js 的
   * 起点在 `loadSource` 那一刻就已经定了，之后的赋值只会被它当作一次 seek。
   *
   * 所以这里把它做成显式参数，并在 `new Hls({...})` 里传下去。传 `undefined` 时
   * 保持 hls.js 的默认行为（-1），但那等于把起播点交给元素残留值 —— 播放器不该
   * 依赖这种隐式状态。
   */
  startPosition = 0,
): Promise<void> {
  /**
   * ===== 为什么这里**仍然**是"先拆后挂"，而不是复用实例 =====
   *
   * 2026-10-23 曾尝试改成复用（`existing.loadSource(url)`），理由是"切集时
   * `destroy()` + `new Hls()` 太重"。查过 hls.js 1.7.3 的源码之后放弃了：
   *
   * ```js
   * loadSource(url) {
   *   this.stopLoad();
   *   if (media && loadedSource && loadedSource !== loadingSource) {
   *     this.detachMedia();
   *     this.attachMedia(media);   // ← 它自己也会重建 MediaSource
   *   }
   * }
   * ```
   *
   * 也就是说复用**省不掉黑屏**：`detachMedia` + `attachMedia` 照样发生，
   * 而"极短一黑"正是 MediaSource 重建造成的。复用真正省下的只有
   * `destroy()` 的解绑与 `new Hls()` 的状态机初始化——这两项在实测里
   * 都是亚毫秒到几毫秒级（见下方 `耗时=` 打点），而换来的是"实例跨集复用"
   * 这种更难排查的状态耦合。
   *
   * 结论：收益不足以抵消风险。切集卡顿的真正大头是**开流解析**（已由预取修好，
   * 实测 41~56ms）与**转码未就绪**，不是这里。
   */
  detachSource(video);
  // 打点：这是整条起播链路上最关键的一处「此刻到底把什么交给了 <video>」。
  // 用户报的「一直加载」无法在开发机复现，只能靠这一行分辨当时走的是 VSR 转码
  // HLS、动漫 HLS 还是本地文件——三种形态的等待时间差一个数量级。
  const shape = urlShape(url);
  const started = performance.now();
  tracePlayback(`起播 attachSource 形态=${shape} ${redactUrl(url)}`);
  if (!isHlsUrl(url) || nativeHlsSupported(video)) {
    video.src = url;
    tracePlayback(`起播 直挂完成 形态=${shape} 耗时=${Math.round(performance.now() - started)}ms`);
    return;
  }
  try {
    const { default: Hls } = await import('hls.js');
    if (!Hls.isSupported()) {
      // 环境既不支持原生 HLS 也不支持 MSE：退回直挂（大概率失败，但不阻塞）。
      video.src = url;
      tracePlayback('起播 环境不支持 MSE，退回直挂（大概率失败）');
      return;
    }
    const hls = new Hls({
      /**
       * 起播点：**必须显式给**，不能让 hls.js 去读元素残留的 `currentTime`。
       *
       * `-1`（hls.js 默认）的语义是"用 `media.currentTime` 当起点"。播放器只有一块
       * 常驻 `<video>`、换集不换元素，而 `detachSource` 里的 `removeAttribute('src')`
       * 触发的位置归零是**异步**的（媒体加载算法在任务队列里跑）—— `loadSource`
       * 在它之前同步执行，读到的还是上一集停下的位置。结果就是换集后进度条不从 0
       * 开始、只播剩下那一小段（用户报告："进度条不会重置，回到之前的位置继续播"）。
       *
       * 传 0 就是"从这一集的开头拉流"，与"点下一集"的语义完全一致；需要续播时
       * 由调用方传真实秒数。
       */
      startPosition: Number.isFinite(startPosition) && startPosition > 0 ? startPosition : 0,
      // 本地代理分片很小（0.6-2s），默认 30 分片缓冲对动漫分片粒度太保守。
      //
      // ⚠️ 这两个值必须按**倍速**放大，不能只看媒体时长（2026-10-21）。
      //
      // hls.js 的 `maxBufferLength` 单位是**媒体时间**，它完全不感知
      // `video.playbackRate`（见 `stream-controller.ts:1579` 的取值实现）。
      // 于是同一份 45 秒缓冲：
      //   1x → 够播 45 秒真实时间，绰绰有余；
      //   3x → 只够播 15 秒，而分片还在等着转码 —— 播放头立刻追平缓冲末端。
      //
      // 实测（ttv-playback.log，2026-10-21，6674 行）：
      //   缓冲 >0.5 秒的事件共 20 次，其中 **18 次发生在 2.6x~3.0x**
      //   （1.0x 只有 1 次且仅 0.84 秒）。1.50 秒这个值反复出现是因为
      //   一个 3.2 秒的分片在 3x 下只需 1.07 秒就播完 —— 播放器每拿一片就断一次。
      //
      // 所以最大值按最高倍速（3x）设定，实际目标由运行期按当前倍速收紧
      // （见下面 `applyBufferTarget`）。本地回环拿分片的成本是亚毫秒级，
      // 多缓冲几乎没有代价；而缓冲不足的代价是用户每几秒看到一次转圈。
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      // 本地代理不走网络限速，开最大加载并发让起播更快。
      maxBufferHole: 0.5,
      // 增强转码是"边转边播"：后端可能在首个分片落地前就把 m3u8 地址交回来，
      // 此刻播放列表还不存在。hls.js 默认 `manifestLoadingMaxRetry=1`，约两秒
      // 就判死并派发 fatal → 调用方只能降级回 HEVC 原流。后端此前正是为了躲开
      // 这一点，才在 `media_enhance::start()` 里按住用户最多 15 秒等首段。
      //
      // 补齐重试之后，"等首段"这件事交回给播放器：后端可以立刻返回地址，
      // 首段由这里按 4 次清单重试 + 8 次分片重试等到。数值与动漫专区
      // （`animePlayback.ts`）保持一致，两个播放面不该有两套起播脾气。
      //
      // ⚠️ 但**只配 MaxRetry 是不够的，必须同时把退避改成线性**。
      //
      // 上面那四个 `*LoadingMaxRetry` 是 hls.js 的**已废弃**键，`mergeConfig` 会把
      // 它们映射进 `*LoadPolicy.default.errorRetry.maxNumRetry`，而**退避策略不在
      // 映射范围内** —— 它保留 policy 里的默认值，也就是指数退避
      // （`getRetryDelay`：`Math.pow(2, retryCount) * retryDelayMs`，见
      // `hls.js/src/utils/error-helper.ts`）。于是"多给几次重试"实际换来的是
      // 1s → 2s → 4s → 8s 的等待，**次数越多，白等越久**。
      //
      // 实测（ttv-playback.log，会话 103，真实红果源）：后端在首片落地前返回地址，
      // 播放器连吃四次 503，时间戳 337.445 → 338.449 → 340.452 → 344.456 → 352.461，
      // 差值精确等于 1s/2s/4s/8s，**累计 15 秒纯空等**，该次首开总耗时 22418ms
      // —— 其中三分之二是在等自己的重试定时器，而不是等 ffmpeg。
      //
      // 本地代理是 127.0.0.1 回环：一次 503 的往返成本是**亚毫秒级**，任何秒级
      // 退避在这里都毫无意义。线性 250ms 让 4 次重试的总等待从 15s 降到 1s。
      //
      // ⚠️ 但 4 次 × 250ms ≈ 1 秒对「边转边播」仍然太短（2026-10-21 实测）。
      //
      // 现场（ttv-playback.log，会话 104，26.367s 起）：
      //   26.367 / 26.623 / 26.880 / 27.133 / 27.386  连吃五次 503
      //   27.394  manifestLoadError fatal=true          ← 1.03 秒后判死
      //   27.394  整集 HLS 播放失败 → 回退整集 mp4（用户白等一次 7~10 秒下载）
      //
      // 而这次转码其实**正常在跑**（后端在同一秒还打出了「首段尚未落地，先交地址」）。
      // 也就是说：一个本可以再等 0.5 秒就好的地址，被 1 秒的重试预算判了死刑，
      // 代价是退回到整集 mp4 那条慢链路。
      //
      // 现在给到 20 次 × 250ms ≈ 5 秒：覆盖"ffmpeg 已起、首片还没 prime 出来"
      // 的常见窗口（实测 876~1521ms，个别源到 4 秒）。回环重试成本可忽略，
      // 而误判的代价是一整集重下。
      manifestLoadingMaxRetry: 20,
      // 与下面的 `playlistLoadPolicy` 对齐取 6（2026-10-20 复查修正）。
      // 原先这里写 4、policy 写 6，正好破了下面那条"必须保持一致"的规矩。
      levelLoadingMaxRetry: 6,
      // 分片重试窗口从 8 次 × 250ms（约 2.4 秒）拉到 24 次 × 300ms（约 7 秒）。
      //
      // 实测（ttv-playback.log，2026-10-19，会话 116 前后）：
      //   606.705 → 608.800  fragLoadError fatal=false × 8，间隔精确 250~300ms
      //   609.145            fragLoadError fatal=true   ← 8 次重试在 2.44 秒内耗尽
      //   609.145            流式源报错 → 上层弹「播放源连接受阻 / 后台还在转码」
      // 而那一刻 ffmpeg 只是在写后面的分片，再等一两秒就有了 —— 2.4 秒的窗口
      // 对"边转边播"来说太短。回环请求成本亚毫秒级，多给几次几乎没有代价。
      fragLoadingMaxRetry: 24,
      fragLoadingRetryDelay: 300,
      // 显式写 policy（一旦写了 policy，上面那批废弃键就不再参与映射，
      // 所以两者的 maxNumRetry 必须保持一致，否则等于悄悄改了重试次数）。
      manifestLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 10000,
          maxLoadTimeMs: 20000,
          // 与上面 `manifestLoadingMaxRetry: 20` 保持一致（见那条"必须一致"的说明）。
          timeoutRetry: { maxNumRetry: 20, retryDelayMs: 250, maxRetryDelayMs: 1500, backoff: 'linear' },
          errorRetry: { maxNumRetry: 20, retryDelayMs: 250, maxRetryDelayMs: 1500, backoff: 'linear' },
        },
      },
      playlistLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 10000,
          maxLoadTimeMs: 20000,
          timeoutRetry: { maxNumRetry: 6, retryDelayMs: 300, maxRetryDelayMs: 1500, backoff: 'linear' },
          errorRetry: { maxNumRetry: 6, retryDelayMs: 300, maxRetryDelayMs: 1500, backoff: 'linear' },
        },
      },
      fragLoadPolicy: {
        default: {
          maxTimeToFirstByteMs: 10000,
          // 单次分片请求的挂死上限：15000ms（2026-10-20 复查修正，原为 120000）。
          //
          // 源是 127.0.0.1 上的本地转码产物：一次分片请求的合法耗时是毫秒级。
          // 留 2 分钟只意味着"ffmpeg 早就不写了，播放器还在对着一条死连接空等两分钟"，
          // 而外层的每一个超时都远小于它（末尾复核 1.2s、看门狗 10s、小窗起播 8s），
          // 于是用户先看到界面卡死，两分钟后才收到一条本该立刻给出的错误。
          // 15 秒对"ffmpeg 正忙、分片稍后落地"仍然绰绰有余。
          maxLoadTimeMs: 15000,
          timeoutRetry: { maxNumRetry: 24, retryDelayMs: 300, maxRetryDelayMs: 1500, backoff: 'linear' },
          errorRetry: { maxNumRetry: 24, retryDelayMs: 300, maxRetryDelayMs: 1500, backoff: 'linear' },
        },
      },
    });
    // 这一条 hls 实例已经用掉几次"判死前自愈"（见下面 ERROR 回调）。
    let recoverAttempts = 0;
    (video as unknown as Record<string, unknown>)[HLS_KEY] = hls;
    /**
     * 播放真的推进了就回血。
     *
     * 额度必须能恢复（2026-10-20 复查修正）：原先 `recoverAttempts` 在实例整个
     * 生命周期里只增不减，于是一集 90 秒的短剧里，两次**互不相关**的瞬时故障
     * （一次清单抖动 + 一次追加无进展）就把额度耗尽，第三次直接判死——用户看到
     * 的就是"播到一半突然报错，得手动重开这一集"，正是这次修复要消灭的症状。
     *
     * 恢复判据用"分片真的进缓冲了"，而不是"时间过去了多久"：后者在长时间缓冲中
     * 会给账号白送额度，前者是播放确实健康的直接证据。
     */
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (recoverAttempts > 0) recoverAttempts = 0;
    });
    /**
     * 按当前倍速把缓冲目标调大（2026-10-21）。
     *
     * `maxBufferLength` 的单位是**媒体时间**，而长按加速把真实时间压缩了 3 倍。
     * 60 秒媒体缓冲在 1x 下够播 60 秒、在 3x 下只够 20 秒 —— 后者在"边转边播"
     * 的本地源上也足够，但如果实测仍不够，这条会把目标按倍速线性放大。
     *
     * 上限用 `maxMaxBufferLength`（120 秒媒体时间）兜住，避免 3x 长时间后
     * 缓冲堆到几百秒、把整集产物全锁在内存里。
     *
     * 为什么监听 `ratechange` 而不是每次 timeupdate 都算：倍速只在用户长按/松手
     * 时改变，是个低频事件，重算成本可以忽略。
     */
    const applyBufferTarget = () => {
      const rate = Number.isFinite(video.playbackRate) && video.playbackRate > 0
        ? video.playbackRate
        : 1;
      // 目标 = 基准 20 秒 × 倍速，钳在 [20, 120] 秒媒体时间。
      //
      // 基准取 20 而不是 45：本地回环上分片是按需拉的，缓冲太深只会让"拖动后
      // 起播"变慢（要先丢掉多余数据）；而 20 秒 × 3x = 60 秒媒体时间 ≈ 20 秒
      // 真实播放，足够覆盖一次转码抖动。
      const target = Math.min(120, Math.max(20, Math.round(20 * rate)));
      hls.config.maxBufferLength = target;
      tracePlayback(`hls.js 缓冲目标=${target}s（倍速 ${rate}x）`);
    };
    video.addEventListener('ratechange', applyBufferTarget);
    // 登记到元素上，`detachSource` 换源时一并摘掉。
    //
    // 播放器只有一块常驻 `<video>`，换集不换元素；不登记就意味着每换一集
    // 就多挂一个 ratechange 监听器，几十集之后一次长按会触发几十次重算。
    (video as unknown as Record<string, unknown>)[RATE_TARGET_KEY] = applyBufferTarget;
    applyBufferTarget();
    hls.on(Hls.Events.ERROR, (_event, data) => {
      // 打点带 type/details：manifest 拉不到、分片 404、解码失败在这条日志里
      // 是可区分的——[vsr] 转码链路的"卡在加载"多数是清单还没落地时的分片 404。
      tracePlayback(`hls.js 错误 type=${String(data.type)} details=${String(data.details)} fatal=${data.fatal === true}`);
      if (!data.fatal) return;
      /**
       * 判死之前先让 hls.js 自己重来两次。
       *
       * 关键前提：这里的源是**本地转码产物**（`127.0.0.1/rtx/...`），不是远端 CDN。
       * 分片暂时没生成、SourceBuffer 追不上进度，都属于"几秒后自己就好"的常态，
       * 而不是"这个媒体坏了"。旧实现一看到 fatal 就把 `error` 抛给上层，上层再
       * （因为流式源跳过备用/Blob）落到错误卡 —— 用户看到的就是"画面明明在播，
       * 突然弹出播放源连接受阻 / 后台还在转码"。
       *
       * 对症下药，两类分开：
       *   - 网络类（分片/清单拉不到）：`startLoad()` 从当前位置重新拉；
       *   - 缓冲类（`bufferAppend*`，MSE 真的坏了）：`recoverMediaError()` 重建解码器。
       *     （`bufferStalledError` 不在此列，理由见 `RECOVERABLE_BUFFER_DETAILS` 的注释。）
       * 各给 `MAX_IN_PLACE_RECOVERY` 次机会；用尽才向上抛，让上层去做"重挂源"
       * 那一级恢复。播放恢复正常后由 `FRAG_BUFFERED` 把额度清零。
       */
      const details = String(data.details);
      if (recoverAttempts < MAX_IN_PLACE_RECOVERY) {
        if (RECOVERABLE_NETWORK_DETAILS.has(details)) {
          recoverAttempts += 1;
          tracePlayback(`hls.js fatal 可恢复（${details}），第 ${recoverAttempts} 次自愈：重新开始拉流`);
          try {
            hls.startLoad();
            return;
          } catch {
            // 落到底下的判死路径：至少让上层知道这次没能自愈。
          }
        } else if (RECOVERABLE_BUFFER_DETAILS.has(details)) {
          recoverAttempts += 1;
          tracePlayback(`hls.js fatal 可恢复（${details}），第 ${recoverAttempts} 次自愈：重建解码器`);
          try {
            hls.recoverMediaError();
            return;
          } catch {
            // 同上。
          }
        }
      } else {
        tracePlayback(`hls.js fatal（${details}）自愈额度已用尽，交给上层重挂源`);
      }
      // ⚠️ 这里**不能只 dispatchEvent**。
      //
      // `new Event('error')` 能唤醒 `addEventListener('error', ...)` 的监听者，但它
      // **不会设置 `HTMLMediaElement.error`** —— 那是只读的 `MediaError`，只有浏览器
      // 自己的媒体加载算法才会写。于是调用方那层 `if (video.error)` 的判死守卫完全
      // 看不见这次失败，继续走到 `startPlayback`；而在一个没有任何可加载媒体的
      // `<video>` 上 `play()` 既不会 resolve 也不会 reject，只能干等有界看门狗的整拍
      // 超时（`PLAY_PENDING_TIMEOUT_MS = 8000`）。
      //
      // 实测代价：日志里 `hls.js 错误 … manifestParsingError fatal=true` 出现在
      // t=56.921s，而 `流式开播 失败` 出现在 t=64.921s —— 相差**精确 8000ms**，
      // 占那次 15.7 秒首屏的 51%。播放器早就知道失败了，前端又花 8 秒自己确认一遍。
      //
      // 所以除了补发事件，还要显式留下一个**可读的**失败标记，让调用方一眼判死。
      (video as unknown as Record<string, unknown>)[HLS_FATAL_KEY] = String(data.details);
      video.dispatchEvent(new Event('error'));
    });
    hls.attachMedia(video);
    hls.loadSource(url);
    tracePlayback(`起播 hls.js 已挂载 形态=${shape} 耗时=${Math.round(performance.now() - started)}ms`);
  } catch (err) {
    tracePlayback(`起播 hls.js 加载失败，退回直挂：${String(err)}`);
    video.src = url;
  }
}

export function detachSource(video: HTMLVideoElement): void {
  const existing = (video as unknown as Record<string, unknown>)[HLS_KEY] as HlsInstance | undefined;
  if (existing) {
    try {
      existing.destroy();
    } catch {
      // 销毁失败不影响主流程
    }
    delete (video as unknown as Record<string, unknown>)[HLS_KEY];
  }
  // 摘掉按倍速调整缓冲目标的监听器：换源即换实例，旧的那个不该再被调用。
  const rateTarget = (video as unknown as Record<string, unknown>)[RATE_TARGET_KEY];
  if (typeof rateTarget === 'function') {
    video.removeEventListener('ratechange', rateTarget as EventListener);
    delete (video as unknown as Record<string, unknown>)[RATE_TARGET_KEY];
  }
  // 换源即作废旧标记：留着会让下一次判死读到上一次的明细。
  clearHlsFatal(video);
  /**
   * 拆源时**顺手把播放位置归零**（2026-10-24）。
   *
   * `removeAttribute('src')` 按规范会让媒体加载算法把 `currentTime` 清 0，但那是
   * 在任务队列里**异步**跑的；而紧接着的 `new Hls()` + `attachMedia` + `loadSource`
   * 是同步的，读到的仍是旧值。hls.js 的 `startPosition` 默认 `-1` = "用
   * `media.currentTime` 当起点"，于是新一集从上一集停下的位置开始播。
   *
   * `attachSource` 现在显式传 `startPosition` 已经把主路径堵住了；这里再同步归零，
   * 是为了让**任何**绕过它的调用点（旧代码、将来新加的）也不会继承旧位置。
   * 赋 0 在 `readyState === HAVE_NOTHING` 时可能抛，吞掉即可——那种状态下位置天然是 0。
   */
  try {
    video.currentTime = 0;
  } catch {
    // 见上。
  }
  video.removeAttribute('src');
}

/**
 * 只拆 hls.js 实例，**不动** `video.src`。
 *
 * 用于离开动漫专区：必须解除 MSE 对这块共享 `<video>` 的接管，
 * 但又不能清 `src`（清了会触发媒体加载算法、把旧帧清成黑屏）。
 * 元素上本来就没有实例时是空操作。
 */
export function releaseAttachedSource(video: HTMLVideoElement): void {
  const existing = (video as unknown as Record<string, unknown>)[HLS_KEY] as HlsInstance | undefined;
  if (!existing) return;
  try {
    existing.destroy();
  } catch {
    // 销毁失败不影响主流程
  }
  delete (video as unknown as Record<string, unknown>)[HLS_KEY];
}
