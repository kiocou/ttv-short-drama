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

export async function attachSource(video: HTMLVideoElement, url: string): Promise<void> {
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
      // 本地代理分片很小（0.6-2s），默认 30 分片缓冲对动漫分片粒度太保守。
      maxBufferLength: 45,
      maxMaxBufferLength: 90,
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
      manifestLoadingMaxRetry: 4,
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
          timeoutRetry: { maxNumRetry: 4, retryDelayMs: 250, maxRetryDelayMs: 1000, backoff: 'linear' },
          errorRetry: { maxNumRetry: 4, retryDelayMs: 250, maxRetryDelayMs: 1000, backoff: 'linear' },
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
  // 换源即作废旧标记：留着会让下一次判死读到上一次的明细。
  clearHlsFatal(video);
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
