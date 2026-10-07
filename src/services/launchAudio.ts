/**
 * 启动动画的声音 —— 全部用 Web Audio **现场合成**。
 *
 * ── 为什么不用音频文件 ──
 *
 * 这段声音整个生命周期只有一次（冷启动那 2.3 秒）。为它引入 mp3 意味着多一份要打包、
 * 要管授权、要跟着版本维护的二进制资源；而一条振荡器 + 一段滤波噪声就能把这件事做完，
 * 包体和仓库都干净。项目里也确实一个音频文件都没有。
 *
 * ── 声音设计的约定 ──
 *
 * 整体是"玻璃感 + 木琴"：正弦/三角为主，噪声一律走带通、只用来做气声和收尾的"咻"。
 * 不用任何硬起音（attack 都在 3ms 以上），因为启动音最怕"啪"的一下。
 *
 * 音高关系是**设计过的**，不是随手取的：六次撞击走 A 小调五声音阶
 * （A3 C4 D4 E4 G4 A4）上行 —— "把东西一件件收进来"的经典听感，
 * 最后一次落在 A4 上并叠成 A4/C5/E5 的挂留和弦。底噪 pad 用 A3/C4/E4/F#4
 * （A 小调加六度），与那条五声音阶同调，所以两者叠在一起不会打架。
 *
 * 这套 cue 的时刻是**和动画共用同一组常量**的（见下方 CUE），改动画时两边一起改。
 */

/* ── 与动画共用的时刻表（毫秒，基准 = 甲段起点）─────────────────────────
   对应 LaunchAnimation 里的：卡子弹入 popAt = i·0.07（周期 ORB=700ms）、
   螺旋起点 ORB_DELAY+ORB+i·LAG = 730+58i、撞击到达 1000+58i。 */
const ORB = 700;
const LAG = 58;
const POP_BASE = 30;
const SWIRL_BASE = 730;
const IMPACT_BASE = 1000;

/** A 小调五声音阶 —— 六次撞击的音高，最后一次落在主音上 */
const PENTATONIC = [220, 261.63, 293.66, 329.63, 392, 440];
/** 底噪 pad：A3 / C4 / E4 / F#4（A 小调加六度，温暖且有向上的感觉） */
const PAD_NOTES = [220, 261.63, 329.63, 369.99];

export interface LaunchSoundParts {
  /** 甲段的自然收束点（秒）。到这儿 pad 会自然开始释放。 */
  padReleaseAt: number;
}

/** 一个极短的软音头。整个模块所有音都用它起，保证不会有硬起音。 */
function blip(
  ctx: BaseAudioContext,
  dest: AudioNode,
  at: number,
  opts: {
    freq: number;
    to?: number;
    dur: number;
    gain: number;
    type?: OscillatorType;
    attack?: number;
  }
): void {
  const osc = ctx.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(opts.freq, at);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, at + opts.dur);

  const gain = ctx.createGain();
  const attack = opts.attack ?? 0.005;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(opts.gain, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + opts.dur);

  osc.connect(gain).connect(dest);
  osc.start(at);
  osc.stop(at + opts.dur + 0.03);
}

/** 滤波噪声。用来做气声（pop 的那个"哒"）和收尾的"咻"。 */
function noiseSweep(
  ctx: BaseAudioContext,
  dest: AudioNode,
  at: number,
  opts: {
    dur: number;
    gain: number;
    from: number;
    to: number;
    q?: number;
    type?: BiquadFilterType;
  }
): void {
  const frames = Math.max(1, Math.ceil(ctx.sampleRate * opts.dur));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = opts.type ?? 'bandpass';
  filter.Q.value = opts.q ?? 1.1;
  filter.frequency.setValueAtTime(opts.from, at);
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.to), at + opts.dur);

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(opts.gain, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + opts.dur);

  src.connect(filter).connect(gain).connect(dest);
  src.start(at);
  src.stop(at + opts.dur + 0.03);
}

/**
 * 排入甲段（公转 / 汇聚 / 弹簧余振）的全部声音。
 *
 * 拆成"对给定的 AudioContext + 目标节点排一组 cue"是因为要把同一套声音
 * 既排进实时 AudioContext（产品路径），也排进 OfflineAudioContext（量化验证
 * 每个 cue 的峰值与位置）。所以这里不碰任何全局状态、不 new AudioContext。
 *
 * @param t0 甲段起点的绝对时间（秒），一般传 `ctx.currentTime + 0.03`
 */
export function schedulePhaseA(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number
): LaunchSoundParts {
  const at = (ms: number) => t0 + ms / 1000;

  /* ── 底噪 pad：铺满整段，给所有短音一个"底" ── */
  const padGain = ctx.createGain();
  // 起手很轻（0.05），整段只做一次极缓的呼吸，避免和撞击抢注意力
  padGain.gain.setValueAtTime(0.0001, at(0));
  padGain.gain.exponentialRampToValueAtTime(0.05, at(600));
  padGain.gain.setValueAtTime(0.05, at(1500));
  padGain.gain.exponentialRampToValueAtTime(0.03, at(1700));

  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass';
  padFilter.frequency.setValueAtTime(700, at(0));
  padFilter.frequency.exponentialRampToValueAtTime(1500, at(1700));
  padFilter.Q.value = 0.7;

  padFilter.connect(padGain).connect(dest);
  PAD_NOTES.forEach((freq, i) => {
    // 每个音两个振荡器、相差 4 音分：轻微失谐才不"电子"
    [0, 4].forEach((cents, k) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'triangle' : 'sine';
      osc.frequency.value = freq * Math.pow(2, (k ? cents : -cents) / 1200);
      const level = ctx.createGain();
      level.gain.value = i === 0 ? 0.5 : 0.28;
      osc.connect(level).connect(padFilter);
      osc.start(at(0));
      osc.stop(at(2600));
    });
  });

  /* ── 六张卡的弹入：极轻的"哒"，音高随机微偏，避免六下听成机器 ── */
  for (let i = 0; i < 6; i += 1) {
    const t = at(POP_BASE + i * (0.07 * ORB));
    const jitter = 1 + ((i * 37) % 11 - 5) / 100; // ±5%
    blip(ctx, dest, t, { freq: 880 * jitter, to: 1320 * jitter, dur: 0.07, gain: 0.028 });
    noiseSweep(ctx, dest, t, { dur: 0.03, gain: 0.012, from: 2600, to: 4200, q: 0.9, type: 'highpass' });
  }

  /* ── 汇聚 riser：从 730ms 一路涨到末次撞击，给收束一个"吸气" ──
     刻意压得比撞击低一档：它是"背景里的吸气"，不是主角。
     测过一版 gain 0.045 —— RMS 0.031 和撞击同量级，听起来是一段"嘶"而不是吸气。 */
  noiseSweep(ctx, dest, at(SWIRL_BASE), {
    dur: (IMPACT_BASE + 5 * LAG - SWIRL_BASE) / 1000,
    gain: 0.028,
    from: 380,
    to: 2600,
    q: 1.8
  });
  blip(ctx, dest, at(SWIRL_BASE), { freq: 110, to: 220, dur: 0.56, gain: 0.02, attack: 0.15 });

  /* ── 六次撞击：五声音阶上行 + 每一下的"落地感"低频 ── */
  PENTATONIC.forEach((freq, i) => {
    const t = at(IMPACT_BASE + i * LAG);
    const strong = i === 5;
    blip(ctx, dest, t, { freq, dur: strong ? 1.1 : 0.26, gain: strong ? 0.075 : 0.055, attack: 0.004 });
    // 八度泛音：木琴的"木"就靠它
    blip(ctx, dest, t, { freq: freq * 2, dur: strong ? 0.6 : 0.14, gain: 0.02, attack: 0.003 });
    // 低频落地（只在前两下和最后一下，否则会糊）
    if (i < 2 || strong) {
      blip(ctx, dest, t, { freq: 150, to: 82, dur: 0.1, gain: strong ? 0.06 : 0.04, attack: 0.003 });
    }
  });

  /* ── 末次撞击的和弦：A4 / C5 / E5 挂留，把"收完了"钉住 ── */
  [440, 523.25, 659.25].forEach((freq, i) => {
    blip(ctx, dest, at(IMPACT_BASE + 5 * LAG + i * 12), {
      freq,
      dur: 1.15 - i * 0.1,
      gain: 0.042,
      attack: 0.008,
      type: 'sine'
    });
  });
  noiseSweep(ctx, dest, at(IMPACT_BASE + 5 * LAG), {
    dur: 0.7,
    gain: 0.018,
    from: 5200,
    to: 2600,
    q: 0.8,
    type: 'highpass'
  });

  return { padReleaseAt: (IMPACT_BASE + 5 * LAG) / 1000 };
}

/**
 * 排入乙段（揭幕）的收束音：白幕抬起时那一下"咻"。
 * 单独一个函数是因为**它在挂起路径里要晚很多才响** —— 甲段跑完可能还要等首页。
 */
export function schedulePhaseB(ctx: BaseAudioContext, dest: AudioNode, t0: number): void {
  noiseSweep(ctx, dest, t0, { dur: 0.5, gain: 0.05, from: 1800, to: 320, q: 1.0 });
}

export interface LaunchAudioController {
  /** 揭幕：补一声收束音，并把还在响的底噪拉掉 */
  reveal(): void;
  /**
   * 收尾：淡出并释放 AudioContext（不释放会一直占着音频设备）。
   * `fadeMs` 默认 600（正常收尾）；"设置读回来说用户其实关了声"这种要立刻掐掉的情况
   * 传一个短值 —— 底噪此刻才涨到零头，120ms 的淡出等于听不见。
   */
  dispose(fadeMs?: number): void;
}

/**
 * 实时路径：开一个 AudioContext 把上面两套 cue 排进去。
 *
 * **自动播放策略**：Chromium 在"没有用户手势"时会先把 AudioContext 置为 suspended。
 * 桌面端应该靠 WebView2 的 `--autoplay-policy=no-user-gesture-required` 直接放行
 * （见 `src-tauri/tauri.conf.json` 的 additionalBrowserArgs）。万一仍然被拦
 * （比如在开发期的浏览器里），这里**静默降级成无声**：
 * 启动音丢了是小事，让启动动画报错或卡住是大事。
 */
export function startLaunchAudio(enabled: boolean): LaunchAudioController | null {
  if (!enabled) return null;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }

  const master = ctx.createGain();
  master.gain.value = 0.75;
  master.connect(ctx.destination);

  let releasePad: ((fadeMs?: number) => void) | null = null;

  const schedule = () => {
    const t0 = ctx.currentTime + 0.04;
    schedulePhaseA(ctx, master, t0);

    // pad 的自然收束：不管揭幕早来晚来，这条 master 的衰减都是同一个出口
    releasePad = (fadeMs = 600) => {
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.exponentialRampToValueAtTime(0.0001, now + fadeMs / 1000);
    };
  };

  if (ctx.state === 'running') {
    schedule();
  } else {
    void ctx
      .resume()
      .then(() => {
        if (ctx.state === 'running') schedule();
        else void ctx.close().catch(() => undefined);
      })
      .catch(() => {
        void ctx.close().catch(() => undefined);
      });
  }

  let revealed = false;
  let disposed = false;
  return {
    reveal() {
      if (revealed || disposed || ctx.state !== 'running') return;
      revealed = true;
      schedulePhaseB(ctx, master, ctx.currentTime + 0.02);
      releasePad?.();
    },
    dispose(fadeMs = 600) {
      if (disposed) return;
      disposed = true;
      try {
        releasePad?.(fadeMs);
      } catch {
        /* 已释放 */
      }
      window.setTimeout(
        () => {
          void ctx.close().catch(() => undefined);
        },
        // 关得比淡出稍晚一点，别把尾巴切掉
        Math.max(200, fadeMs + 100)
      );
    }
  };
}
