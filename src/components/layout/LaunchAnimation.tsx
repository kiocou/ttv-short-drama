import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useCatalogStore } from '../../stores/useCatalogStore';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { startLaunchAudio, type LaunchAudioController } from '../../services/launchAudio';

/**
 * 启动进入动画 · 方案 05「轨道汇聚」
 * ===========================================================================
 * 六张迷你海报绕品牌公转 1.1 圈（角速度由快到慢），然后依次被吸进中心；
 * 品牌承接六次撞击、回弹一次，再淡出让位给主界面。总长 2150ms。
 *
 * 设计稿与全部备选方案属于维护者本地材料，不在公开仓库内。
 *
 * ── 为什么动画写在 JS 里而不是 CSS ──
 *
 * 椭圆轨道要 33 段采样（关键帧之间是直线插值，采样太疏时"弦"会内凹，
 * 卡片会肉眼可见地切进导轨线里），六张卡各 33 帧、每帧还带 transform /
 * opacity / filter / z-index 四个属性 —— 写成 CSS keyframes 是两百多条规则，
 * 而且改一个参数要动四处。element.animate 配一个采样循环更短也更好调。
 *
 * ── 三条硬约束（都是项目里踩过的坑）──
 *
 * 1. **一律 `fill: 'both'` + 跑完 `cancel()`，不要用 `fill: 'forwards'`。**
 *    forwards 会把 `transform: matrix(1,0,0,1,0,0)` / `filter: brightness(1)`
 *    这类恒等值永久钉在元素上，等于给 TitleBar / NavigationRail / main 永久挂上
 *    合成层 —— 项目里已经因为这件事让 NVIDIA VSR 失效过一次。
 *    'both' 只是为了让**延迟期间**也停在 0% 帧（否则元素会先按原本的样子闪一下），
 *    收尾交给 cancel()。
 *
 * 2. **补间 `filter` 时必须把 `drop-shadow` 一起带上**（LOGO_SH）。
 *    `.ttv-launch-logo` 的 CSS 里挂着一条 drop-shadow，动画只写 blur() 的话
 *    fill 会把影子顶掉，品牌从此没有投影。同理，同一段动画的多个关键帧，
 *    filter 函数列表必须**同序同长**（blur / brightness / drop-shadow），
 *    否则 WAAPI 会退化成离散跳变，看起来是一帧闪一下。
 *
 * 3. **壳层（TitleBar / NavigationRail / main）的入场动画不能碰 `<video>` 的祖先。**
 *    播放器宿主 div 就在 main 的兄弟位置，所以这三个是安全的边界 ——
 *    再往外一层（`flex-1 relative` 那层）就已经是 video 的祖先了，不能动。
 *    它们虽然有位移，但整段位移都发生在白色动画层还盖着的时候：
 *    动画层 1720→2010 淡出，此刻 rail 的 translateX 只剩 2~3px，
 *    所以不会出现"边缘露出背景"的接缝。
 *
 * ── 与真实界面的衔接 ──
 *
 * 动画层底衬是 `.mica-backdrop` 的同一条渐变（见 launch.css），撤层那一帧不跳色。
 */

const FRAME_COUNT = 6;

/**
 * 六张卡的底色。用渐变而不是真实封面：启动这一刻远程封面还没回来，
 * 而且这里只需要"内容"的象征，不需要真的剧集数据。
 */
const FRAME_GRADIENTS = [
  'linear-gradient(160deg,#6366f1,#a855f7)',
  'linear-gradient(160deg,#0ea5e9,#22d3ee)',
  'linear-gradient(160deg,#f43f5e,#fb923c)',
  'linear-gradient(160deg,#10b981,#84cc16)',
  'linear-gradient(160deg,#8b5cf6,#ec4899)',
  'linear-gradient(160deg,#f59e0b,#ef4444)'
];

/** 品牌投影。凡是补间 filter 的地方都要把它拼上去，见文件头第 2 条。 */
const LOGO_SH = ' drop-shadow(0 10px 26px rgba(109,71,230,.34))';

/* ── 几何：卡片 80×112 / 轨道 600×392（卡轨比 0.27）── */
const RX = 300;
const RY = 196;
const TURNS = 1.1;
/**
 * 椭圆采样段数。
 * 72 而不是 32：轨道半径上叠了一层"呼吸"（见 buildTimeline 里的 breathe），
 * 它在一圈里跑 2 个周期 —— 采样太疏时这个正弦会被采成折线，读起来是抖动而不是呼吸。
 */
const SAMPLE = 72;

/* ── 时序（都是基准毫秒）── */
const ORB = 700;
const ORB_DELAY = 30;
const SPIRAL = 270;
const LAG = 58;
/** 品牌弹簧轨的起点与时长。末次撞击落在它的 50% 处（= 最大挤压）。 */
const GRAV_DELAY = 920;
/** 弹簧轨总长。前半段是六次撞击累积的"越来越猛"，后半段是衰减余振。 */
const GRAV_DUR = 740;

/** 甲段（公转 / 汇聚 / 弹簧余振）的终点。最长的一条是光晕（1700ms）。 */
const PHASE_A_END = 1700;
/** 乙段（让位给主界面）的跨度。最长的一条是 content（110+490）。 */
const PHASE_B_SPAN = 600;
/**
 * 甲段跑完后，为了等首页目录最多再挂起多久。
 *
 * 首页目录是在 `CatalogProvider` 挂载时开始拉的，和甲段同时起跑；真实网络下
 * 不保证能在甲段跑完前回来。等到了就直接揭幕，等不到就挂起，最多再等这么久。
 * **超时也必须揭幕**：骨架屏是诚实的，"卡在启动画面上"不是。
 */
const MAX_HOLD = 1500;
/** 点击跳过时的淡出时长 */
const SKIP_FADE = 170;

/** 公转的角速度衰减：由快到慢，读起来像"能量沉降"。 */
const easeAngle = (u: number) => 1 - Math.pow(1 - u, 1.75);

/**
 * 品牌承接撞击的**弹簧轨**（挤压 / 拉伸 / 余振）。
 *
 * 为什么不是"六次独立脉冲"：同一元素上多段 animate 会互相覆盖（后创建的替换先创建的），
 * 六个脉冲写出来是乱跳。为什么也不是"均匀放大一点点"：那正是上一版被吐槽
 * "单调、没有回弹"的原因 —— 均匀 scale 只是变大，不产生任何受力感。
 *
 * 真正让眼睛读出"回弹"的是**挤压拉伸 + 过冲 + 衰减余振**三件套，
 * 而且必须让 Y（纵向）和 X（横向）**反向**（体积守恒的错觉）。
 * 这条轨的振幅是刻意设计的：前四次撞击越来越猛（0.040 → 0.052 → 0.105），
 * 末次撞击打出 10.5% 的挤压，之后 4 次余振按 0.082 → 0.054 → 0.038 → 0.019 衰减，
 * 同时带一点旋转摆动（±2° → 0），让"晃动"和"弹"叠在一起。
 */
const IMPACT_SPRING: Keyframe[] = [
  { offset: 0, transform: 'scale(1, 1) rotate(0deg)' },
  // 前段：六次撞击累积，一次比一次猛
  { offset: 0.11, transform: 'scale(1.048, 0.960) rotate(-0.7deg)' },
  { offset: 0.21, transform: 'scale(0.980, 1.016) rotate(0.5deg)' },
  { offset: 0.32, transform: 'scale(1.076, 0.948) rotate(-0.9deg)' },
  { offset: 0.42, transform: 'scale(0.968, 1.024) rotate(0.6deg)' },
  // 末次撞击：最大挤压
  { offset: 0.50, transform: 'scale(1.135, 0.895) rotate(-1.4deg)' },
  // 后段：衰减余振（这是"回弹"读出来的地方）
  { offset: 0.575, transform: 'scale(0.918, 1.082) rotate(1.9deg)' },
  { offset: 0.650, transform: 'scale(1.078, 0.946) rotate(-1.4deg)' },
  { offset: 0.720, transform: 'scale(0.950, 1.038) rotate(1.0deg)' },
  { offset: 0.790, transform: 'scale(1.042, 0.972) rotate(-0.7deg)' },
  { offset: 0.855, transform: 'scale(0.975, 1.019) rotate(0.45deg)' },
  { offset: 0.915, transform: 'scale(1.020, 0.986) rotate(-0.25deg)' },
  { offset: 0.965, transform: 'scale(0.992, 1.006) rotate(0.1deg)' },
  { offset: 1, transform: 'scale(1, 1) rotate(0deg)' }
];

/**
 * 甲段：公转 → 错峰汇聚 → 品牌弹簧余振 → 导轨收束 → 三圈冲击波。
 * 跑完（1700ms）所有东西都静止在"品牌 + 光晕"上，这正好是一个可以挂起等待的姿态。
 */
function buildPhaseA(root: HTMLElement): Animation[] {
  const out: Animation[] = [];
  const pick = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector);

  /** 统一入口：一律 fill:'both'（延迟期间停在 0% 帧 = 起始不可见），收尾靠 cancel()。 */
  const anim = (
    el: Element | null,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions
  ) => {
    if (!el) return;
    out.push(el.animate(keyframes, { ...options, fill: 'both' }));
  };

  const frames = Array.from(root.querySelectorAll<HTMLElement>('.ttv-launch-frame'));
  const guide = pick('.ttv-launch-guide');
  const glow = pick('.ttv-launch-glow');
  const logoWrap = pick('.ttv-launch-logo-wrap');
  const logo = pick('.ttv-launch-logo');
  const rings = Array.from(root.querySelectorAll<HTMLElement>('.ttv-launch-ring'));
  const hint = pick('.ttv-launch-hint');

  const EASE = 'cubic-bezier(.16,1,.3,1)';

  /* ─────────────────────────────────────────────────────────────
     光晕：脉冲式涨落，末次撞击时最亮。
     不是"慢慢变亮"——它和品牌弹簧同一节拍在跳，撞击才有"打到了"的感觉。
     ───────────────────────────────────────────────────────────── */
  anim(
    glow,
    [
      { offset: 0, opacity: 0, transform: 'scale(.50)' },
      { offset: 0.32, opacity: 0.48, transform: 'scale(.80)' },
      { offset: 0.44, opacity: 0.72, transform: 'scale(1.00)' },
      { offset: 0.53, opacity: 1, transform: 'scale(1.18)' },
      { offset: 0.6, opacity: 0.7, transform: 'scale(1.06)' },
      { offset: 0.7, opacity: 0.92, transform: 'scale(1.20)' },
      { offset: 0.82, opacity: 0.5, transform: 'scale(1.24)' },
      { offset: 1, opacity: 0.24, transform: 'scale(1.28)' }
    ],
    { duration: 1700, delay: 0, easing: 'ease-in-out' }
  );

  /* ─────────────────────────────────────────────────────────────
     椭圆导轨：亮出 → 公转期间自己脉动 → 收束进品牌。
     三段合并成一条轨，总长 1540ms，各段的起点换算成 offset。
     收束前那一下"向外蓄力"是刻意加的：有预备动作的收缩才有力。
     ───────────────────────────────────────────────────────────── */
  const GUIDE_DUR = 1540;
  const gAt = (ms: number) => Number((ms / GUIDE_DUR).toFixed(4));
  anim(
    guide,
    [
      { offset: 0, opacity: 0, transform: 'scale(.90)', easing: EASE },
      { offset: gAt(240), opacity: 0.55, transform: 'scale(1)', easing: 'ease-in-out' },
      { offset: gAt(460), opacity: 0.88, transform: 'scale(1.014)' },
      { offset: gAt(680), opacity: 0.44, transform: 'scale(.996)' },
      { offset: gAt(900), opacity: 0.86, transform: 'scale(1.012)' },
      { offset: gAt(1240), opacity: 0.64, transform: 'scale(1.008)', easing: 'cubic-bezier(.25,.8,.3,1)' },
      { offset: gAt(1330), opacity: 0.98, transform: 'scale(1.085)', easing: 'cubic-bezier(.7,0,.5,1)' },
      { offset: 1, opacity: 0, transform: 'scale(.10)' }
    ],
    { duration: GUIDE_DUR, delay: 0, easing: 'linear' }
  );

  /* ─────────────────────────────────────────────────────────────
     品牌：结晶出场 + 末次撞击时"充能"。
     两段的 filter 函数列表必须**同序同长**（blur / brightness / drop-shadow），
     否则中间会退化成离散跳变；而且必须把 CSS 里那条 drop-shadow 一起带上，
     只写 blur() 会被 fill 永久顶掉，品牌从此投不出影子。
     ───────────────────────────────────────────────────────────── */
  const LOGO_DUR = 1630;
  const lAt = (ms: number) => Number((ms / LOGO_DUR).toFixed(4));
  const logoFilter = (blurPx: number, brightness: number, y: number, drop: number, alpha: number) =>
    `blur(${blurPx}px) brightness(${brightness}) drop-shadow(0 ${y}px ${drop}px rgba(109,71,230,${alpha}))`;
  anim(
    logo,
    [
      { offset: 0, opacity: 0, transform: 'scale(.84)', filter: logoFilter(9, 1, 10, 26, 0.34), easing: EASE },
      { offset: lAt(560), opacity: 1, transform: 'scale(1)', filter: logoFilter(0, 1, 10, 26, 0.34) },
      { offset: lAt(1130), opacity: 1, transform: 'scale(1)', filter: logoFilter(0, 1, 10, 26, 0.34) },
      { offset: lAt(1310), opacity: 1, transform: 'scale(1)', filter: logoFilter(0, 1.18, 24, 58, 0.74), easing: 'ease-in-out' },
      { offset: 1, opacity: 1, transform: 'scale(1)', filter: logoFilter(0, 1, 10, 26, 0.34) }
    ],
    { duration: LOGO_DUR, delay: 0, easing: 'linear' }
  );

  /* ─────────────────────────────────────────────────────────────
     六张卡：**一条轨**跑完"弹入 → 公转 → 螺旋吸入 → 越过中心回弹"。
     见文件头/AGENTS.md：同元素多段 animate 会互相覆盖，必须合并成一条。
     ───────────────────────────────────────────────────────────── */
  const SWIRL_EASE = 'cubic-bezier(.55,-.04,.8,.4)';

  frames.forEach((frame, index) => {
    const a0 = (index / FRAME_COUNT) * Math.PI * 2 - Math.PI / 2;
    const popAt = index * 0.07; // 依次弹入，间隔刻意拉开才看得出是"一张张来"
    const swingDir = index % 2 ? 1 : -1;
    const track: Keyframe[] = [];

    /*
      错峰不能再靠 delay 了。
      合并成一条轨之后，delay 会连"公转相位"一起推后 —— 六张卡的 60° 间隔就散了。
      所以改成把错峰做进 **offset 空间**：每张卡的总时长各不相同
      （ORB + index·LAG + SPIRAL），但都从同一时刻起跑，于是
        · 公转段所有人同时结束（相位差恒定 60°）
        · 公转结束后原地待命，等自己的窗口到了再螺旋吸入
    */
    const total = ORB + index * LAG + SPIRAL;
    const orbitShare = ORB / total;
    const swirlStart = (ORB + index * LAG) / total;

    const place = (u: number) => {
      const angle = a0 + TURNS * Math.PI * 2 * easeAngle(u);
      // depth: 0 = 最远（上半圈，在品牌后面）  1 = 最近（下半圈，在品牌前面）
      const depth = (Math.sin(angle) + 1) / 2;
      const breathe = 1 + 0.05 * Math.sin(u * Math.PI * 4 + index * 1.15);
      const x = Math.cos(angle) * RX * breathe;
      const y = Math.sin(angle) * RY * breathe;
      const e = (u - popAt) / 0.1;
      const pop =
        e <= 0 ? 0 : e < 0.6 ? 0.3 + 0.83 * (e / 0.6) : e < 1 ? 1.13 - 0.13 * ((e - 0.6) / 0.4) : 1;
      const sway = 4.5 * swingDir * Math.sin(u * Math.PI * 5 + index * 2.1);
      return {
        x,
        y,
        scale: (0.66 + 0.43 * depth) * pop,
        opacity: Math.max(0, Math.min(1, e / 0.35)) * (0.62 + 0.38 * depth),
        depth,
        sway
      };
    };
    const frameAt = (p: ReturnType<typeof place>, z: number): Keyframe => ({
      transform:
        `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) ` +
        `scale(${p.scale.toFixed(3)}) rotate(${p.sway.toFixed(2)}deg)`,
      opacity: Number(p.opacity.toFixed(3)),
      filter: `blur(${((1 - p.depth) * 1.05).toFixed(2)}px)`,
      // 翻面点选在 y = 0，那正好是卡片离品牌最远（x = ±RX）的瞬间，
      // 所以这次离散跳变发生在卡片完全不压品牌的时候，看不出来。
      zIndex: z
    });

    // ── 公转段：采样，逐帧 linear ──
    for (let step = 0; step < SAMPLE; step += 1) {
      const u = step / SAMPLE;
      const p = place(u);
      track.push({
        offset: Number(((step / SAMPLE) * orbitShare).toFixed(5)),
        ...frameAt(p, p.depth >= 0.5 ? 3 : 1),
        easing: 'linear'
      });
    }

    // ── 公转终点 = 螺旋起点。接缝必须用同一个 place(1)，否则会跳一下 ──
    const end = place(1);
    const endFrame = frameAt(end, end.depth >= 0.5 ? 3 : 1);
    track.push({
      offset: Number(orbitShare.toFixed(5)),
      ...endFrame,
      easing: index > 0 ? 'linear' : SWIRL_EASE
    });
    if (index > 0) {
      track.push({ offset: Number(swirlStart.toFixed(5)), ...endFrame, easing: SWIRL_EASE });
    }

    // ── 螺旋段：拉伸 → 挤压 → 越过中心回弹 → 归零 ──
    const swirl: Array<[number, number, number]> = [
      [0.28, 1.2, 15],
      [0.58, 0.7, 26],
      [0.82, 0.42, 10],
      [1, 0.45, 0]
    ];
    swirl.forEach(([t, scaleK, rotK]) => {
      const travel =
        t <= 0.28
          ? (t / 0.28) * 0.45
          : t <= 0.58
            ? 0.45 + ((t - 0.28) / 0.3) * 0.39
            : t <= 0.82
              ? 0.84 + ((t - 0.58) / 0.24) * 0.25
              : 1.09 - ((t - 0.82) / 0.18) * 0.09;
      const x = end.x * (1 - travel);
      const y = end.y * (1 - travel);
      track.push({
        offset: Number((swirlStart + t * (1 - swirlStart)).toFixed(5)),
        transform:
          `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) ` +
          `scale(${(end.scale * scaleK).toFixed(3)}) rotate(${(rotK * swingDir).toFixed(1)}deg)`,
        opacity: t >= 1 ? 0 : t >= 0.82 ? 0.85 : 1,
        filter: `blur(${t >= 1 ? 2.2 : t >= 0.58 ? 1.6 : t >= 0.28 ? 0.6 : 0}px)`,
        zIndex: 3,
        easing: 'linear'
      });
    });

    anim(frame, track, { duration: total, delay: ORB_DELAY, easing: 'linear' });
  });

  /* ── 品牌承接撞击：挤压 / 拉伸 / 衰减余振，见 IMPACT_SPRING 的注释 ── */
  anim(logoWrap, IMPACT_SPRING, { duration: GRAV_DUR, delay: GRAV_DELAY, easing: 'linear' });

  /* ── 三圈冲击波：分别打在第一次、第三次、末次撞击上，一圈比一圈大 ──
     只打末次一圈的话，前五次撞击全是"哑的"，那正是单调感的来源。 */
  const waves: Array<[number, number, number, number]> = [
    [120, 960, 2.6, 0.55],
    [150, 1086, 3.0, 0.6],
    [190, 1250, 3.8, 0.75]
  ];
  waves.forEach(([size, delay, grow, peak], index) => {
    const el = rings[index];
    if (!el) return;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.borderColor = 'rgba(109,71,230,.52)';
    anim(
      el,
      [
        { offset: 0, transform: 'scale(.5)', opacity: 0 },
        { offset: 0.22, transform: 'scale(.9)', opacity: peak },
        { offset: 1, transform: `scale(${grow})`, opacity: 0 }
      ],
      { duration: 380 + index * 30, delay, easing: 'cubic-bezier(.2,.8,.3,1)' }
    );
  });

  /* ── 底部提示：这个动画有 2 秒多，不给出口不礼貌 ── */
  anim(
    hint,
    [
      { opacity: 0 },
      { opacity: 0.45 }
    ],
    { duration: 400, delay: 900, easing: 'ease-out' }
  );

  return out;
}

/**
 * 乙段：让位给主界面。
 *
 * **单独成一段是因为它要等**：首页目录在 `CatalogProvider` 挂载时就开始拉了，
 * 和甲段同时起跑，但真实网络下不一定能在甲段跑完前回来。等到了就直接揭幕，
 * 等不到就挂起（见组件里的 holdUntilReady），最多等 MAX_HOLD，超时也照常揭幕 ——
 * 骨架屏是诚实的，卡死在启动画面上不是。
 */
function buildPhaseB(root: HTMLElement): {
  overlay: Animation[];
  shell: Animation[];
  rootFade: Animation;
} {
  const overlay: Animation[] = [];
  const shell: Animation[] = [];
  const EASE = 'cubic-bezier(.16,1,.3,1)';

  /* 动画层淡出。时刻必须排在弹簧余振收完之后（甲段 1700ms），
     否则品牌还弹着、白幕已经开始退。 */
  const rootFade = root.animate(
    [
      { opacity: 1 },
      { opacity: 0 }
    ],
    { duration: 290, delay: 200, easing: 'ease-in', fill: 'both' }
  );

  /* 壳层入场。相机位之外的三个安全目标，见文件头。
     刻意比白幕早 90ms 起：等白幕透明时它们已经基本就位，不会露出"边缘漏底"的接缝。 */
  const shellAnim = (
    part: 'titlebar' | 'rail' | 'content',
    keyframes: Keyframe[],
    duration: number,
    delay: number
  ) => {
    const el = document.querySelector(`[data-launch-part="${part}"]`);
    if (!el) return;
    shell.push(el.animate(keyframes, { duration, delay, easing: EASE, fill: 'both' }));
  };
  shellAnim(
    'titlebar',
    [
      { opacity: 0, transform: 'translateY(-8px)' },
      { opacity: 1, transform: 'translateY(0)' }
    ],
    440,
    110
  );
  // 导航栏本身带一条内联 translateZ(0)，首尾帧都写上它，cancel 时才不会跳。
  shellAnim(
    'rail',
    [
      { opacity: 0, transform: 'translateX(-14px) translateZ(0)' },
      { opacity: 1, transform: 'translateX(0) translateZ(0)' }
    ],
    450,
    150
  );
  shellAnim(
    'content',
    [
      { opacity: 0, transform: 'scale(.972)' },
      { opacity: 1, transform: 'scale(1)' }
    ],
    490,
    110
  );

  return { overlay, shell, rootFade };
}

/**
 * 挂起时用的"还在忙"循环：光晕慢慢呼吸 + 提示文字跟着闪。
 * 挂起看起来和卡死一模一样，所以必须有东西在动。
 */
function startIdle(root: HTMLElement): Animation[] {
  const out: Animation[] = [];
  const glow = root.querySelector<HTMLElement>('.ttv-launch-glow');
  const hint = root.querySelector<HTMLElement>('.ttv-launch-hint');
  if (glow) {
    out.push(
      glow.animate(
        [
          { opacity: 0.24, transform: 'scale(1.28)' },
          { opacity: 0.46, transform: 'scale(1.34)' },
          { opacity: 0.24, transform: 'scale(1.28)' }
        ],
        { duration: 1500, iterations: Infinity, easing: 'ease-in-out' }
      )
    );
  }
  if (hint) {
    out.push(
      hint.animate([{ opacity: 0.45 }, { opacity: 0.72 }, { opacity: 0.45 }], {
        duration: 1600,
        iterations: Infinity,
        easing: 'ease-in-out'
      })
    );
  }
  return out;
}

export const LaunchAnimation: React.FC = () => {
  /**
   * 首页目录的就绪信号。`CatalogProvider` 在**挂载那一刻**就开始拉目录了，
   * 和启动动画同时起跑 —— 这里不做"催它去加载"，只做"等它回来"。
   * 用 ref 承接而不是放进 effect 依赖：那会让整条时间线重启。
   */
  const { isLoading: catalogLoading } = useCatalogStore();

  /**
   * 启动音开关。设置还没读回来时 `settings` 就是 `DEFAULT_SETTINGS`（开），
   * 而旧设置记录里没有这个字段 —— 所以判定用 `!== false` 而不是直接取布尔值：
   * `undefined` 必须当"开"，否则老用户升级后会莫名其妙没声音。
   */
  const { settings } = useSettingsStore();
  const soundOn = settings.launchSound !== false;

  const [phase, setPhase] = useState<'running' | 'done'>('running');
  /** 甲段跑完了但首页还没回来：挂起中。用来把提示文字换掉、并启动"还在忙"循环。 */
  const [holding, setHolding] = useState(false);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const phaseARef = useRef<Animation[]>([]);
  const phaseBRef = useRef<Animation[]>([]);
  const shellRef = useRef<Animation[]>([]);
  const idleRef = useRef<Animation[]>([]);
  const rootFadeRef = useRef<Animation | null>(null);
  /**
   * 启动音。甲段一起跑，揭幕时补一声收束音，收尾统一释放。
   *
   * 它**不参与** `cancelAll` 的动画批处理：动画 cancel 是"立刻回到终态"，
   * 而声音需要的是淡出，硬停会"啪"一下。所以单独走 `dispose()`。
   */
  const audioRef = useRef<LaunchAudioController | null>(null);
  /**
   * 时间线自己的定时器。cancelAll 会清掉它们 —— 这是对的：
   * 时间线一旦作废，它的收尾闹钟也不该再响。
   */
  const timersRef = useRef<number[]>([]);
  /**
   * 跳过路径的收尾定时器，**必须和时间线的定时器分开存**。
   *
   * 踩过的坑：一开始这两个共用一个数组，结果 React StrictMode 的
   * 「effect → cleanup → effect」会把跳过时刚挂上的收尾闹钟一起清掉 ——
   * 用户点了跳过、壳层也回了终态，动画层却一直挂在那儿等自己的总时长，
   * 点击还被它挡着，看起来像"点跳过没反应"。
   */
  const exitTimerRef = useRef<number | null>(null);
  /** 已经跳过：效果再跑一次时直接收工，不要再起一套动画。 */
  const skippedRef = useRef(false);
  const finishedRef = useRef(false);
  /** 首页目录已经不是 loading 了。 */
  const readyRef = useRef(false);
  /** 甲段（公转 / 汇聚 / 弹簧）跑完了。 */
  const phaseADoneRef = useRef(false);
  const phaseBStartedRef = useRef(false);
  /** 等首页内容的最迟时刻（时间戳）。超时也照常揭幕 —— 骨架屏是诚实的，卡死不是。 */
  const holdDeadlineRef = useRef(0);

  /** 取消所有动画：cancel 后元素回到自身计算样式，也就是"主界面完全就位"的终态。 */
  const cancelAll = useCallback(() => {
    const all = [
      ...phaseARef.current,
      ...phaseBRef.current,
      ...shellRef.current,
      ...idleRef.current,
      rootFadeRef.current
    ];
    all.forEach((animation) => {
      if (!animation) return;
      try {
        animation.cancel();
      } catch {
        /* 已经 cancel 过的动画再取消会抛，忽略 */
      }
    });
    phaseARef.current = [];
    phaseBRef.current = [];
    shellRef.current = [];
    idleRef.current = [];
    rootFadeRef.current = null;
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  }, []);

  const finish = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    cancelAll();
    // 声音单独收：淡出后释放 AudioContext（不释放会一直占着音频设备，
    // 在 Windows 的"音量合成器"里会挂一个常驻条目）。
    audioRef.current?.dispose();
    audioRef.current = null;
    setPhase('done');
  }, [cancelAll]);

  /**
   * 揭幕。三个前提：甲段跑完、首页就绪、或者已经等到最后期限。
   * 幂等 —— 就绪信号和超时兜底会同时来。
   */
  const reveal = useCallback(() => {
    if (phaseBStartedRef.current || finishedRef.current || skippedRef.current) return;
    if (!phaseADoneRef.current) return;
    if (!readyRef.current && Date.now() < holdDeadlineRef.current) return;
    const root = rootRef.current;
    if (!root) return;

    phaseBStartedRef.current = true;
    // 挂起用的"还在忙"循环到此为止：光晕要回到自己的终值，好让白幕干净地退掉
    idleRef.current.forEach((animation) => {
      try {
        animation.cancel();
      } catch {
        /* 已取消 */
      }
    });
    idleRef.current = [];
    setHolding(false);

    // 揭幕音与"白幕抬起"同一刻。挂起路径下它会晚很多才响 —— 这正是分两段的原因。
    audioRef.current?.reveal();

    const built = buildPhaseB(root);
    phaseBRef.current = built.overlay;
    shellRef.current = built.shell;
    rootFadeRef.current = built.rootFade;
    timersRef.current.push(window.setTimeout(finish, PHASE_B_SPAN + 60));
  }, [finish]);

  useEffect(() => {
    if (phase !== 'running') return;
    const root = rootRef.current;
    if (!root) return;

    // 用户在第一帧就点了跳过：不要再起动画，直接收工。
    if (skippedRef.current) {
      setPhase('done');
      return;
    }

    // 系统开了"减少动态效果"就整个跳过：不要留 0 秒动画（会留下 fill 状态）。
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPhase('done');
      return;
    }

    // 轨道整体按窗口缩放：1080×720 的最小窗口取 0.85，1440×920 及以上放到 1.18。
    // 上限不封在一倍是因为默认窗口 1440×920 比设计基准 1180×720 大得多，
    // 不放大整组轨道会显得又小又空。
    const fit = Math.min(window.innerWidth / 1280, window.innerHeight / 860);
    root.style.setProperty('--launch-k', Math.max(0.85, Math.min(1.18, fit)).toFixed(3));

    phaseARef.current = buildPhaseA(root);
    holdDeadlineRef.current = Date.now() + PHASE_A_END + MAX_HOLD;

    /*
      启动音与甲段同一刻起跑 —— 它用的是和动画同一组时刻常量，
      错开哪怕几十毫秒，"撞击"就会从"打中了"变成"慢半拍"。
      ⚠️ `soundOn` **刻意不进依赖**：设置是异步读回来的，进了依赖就会在它落地那一刻
      重启整条时间线。这里按"读到的值"起跑，读错了由下面那个 effect 兜（见那里）。
    */
    audioRef.current = startLaunchAudio(soundOn);

    // 甲段跑完：首页已经就绪就立刻揭幕，否则挂起等它（最多再等 MAX_HOLD）
    timersRef.current.push(
      window.setTimeout(() => {
        phaseADoneRef.current = true;
        if (!readyRef.current) {
          setHolding(true);
          idleRef.current = startIdle(root);
        }
        reveal();
      }, PHASE_A_END)
    );
    // 兜底：到点无论首页准备好没有都揭幕
    timersRef.current.push(window.setTimeout(reveal, PHASE_A_END + MAX_HOLD + 10));

    return cancelAll;
  }, [phase, finish, reveal, cancelAll]);

  // 首页目录就绪 → 只要甲段已经跑完就立刻揭幕
  useEffect(() => {
    if (catalogLoading) return;
    readyRef.current = true;
    reveal();
  }, [catalogLoading, reveal]);

  /*
    设置是异步读回来的，而启动动画在设置之前就起跑了（子组件的 effect 先于祖先组件执行）
    —— 所以"用户其实关了声"这个事实，通常要晚几十毫秒才知道。知道了立刻掐：
    底噪的起音是 600ms 的缓坡，此刻 master 才涨到零头，120ms 的淡出等于没出声。
    这是个**有意的、约 100ms 的窗口**，代价远小于让所有人都在动效上慢半拍。
  */
  useEffect(() => {
    if (settings.launchSound !== false) return;
    audioRef.current?.dispose(120);
    audioRef.current = null;
  }, [settings.launchSound]);

  // 真正的卸载才摘跳过闹钟，StrictMode 的假卸载摘不到它。
  useEffect(
    () => () => {
      if (exitTimerRef.current !== null) window.clearTimeout(exitTimerRef.current);
    },
    []
  );

  const skip = useCallback(() => {
    if (phase !== 'running' || finishedRef.current) return;
    skippedRef.current = true;
    // 挂起期间跳过：把"还在忙"循环也停掉
    idleRef.current.forEach((animation) => {
      try {
        animation.cancel();
      } catch {
        /* 已取消 */
      }
    });
    idleRef.current = [];
    const root = rootRef.current;
    if (root) {
      root.style.pointerEvents = 'none';
      // 先把壳层取消掉：它们立刻回到终态，而这一帧还被动画层盖着。
      // 反过来的话用户会看见底层"跳"一下。
      shellRef.current.forEach((animation) => {
        try {
          animation.cancel();
        } catch {
          /* 已取消 */
        }
      });
      shellRef.current = [];
      // 动画层自己淡出。起点取**当前真实不透明度**，所以无论在第几毫秒跳过都不会闪回。
      // 新的动画排在列表末尾，会盖过旧的 opacity 值，不需要先 cancel。
      rootFadeRef.current?.cancel();
      rootFadeRef.current = null;
      const from = Number(window.getComputedStyle(root).opacity);
      const fade = root.animate(
        [{ opacity: Number.isFinite(from) ? from : 1 }, { opacity: 0 }],
        { duration: SKIP_FADE, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'forwards' }
      );
      // 双保险：动画 finish 是主路径，定时器兜底（后台标签页里 rAF 会停）。
      fade.finished.then(() => finish()).catch(() => undefined);
      exitTimerRef.current = window.setTimeout(finish, SKIP_FADE + 160);
    } else {
      finish();
    }
  }, [phase, finish]);

  useEffect(() => {
    if (phase !== 'running') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        skip();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [phase, skip]);

  if (phase === 'done') return null;

  return (
    <div
      ref={rootRef}
      className="ttv-launch"
      aria-hidden="true"
      onPointerDown={(event) => {
        // 只认左键：右键在项目里是全局被禁用的，不该顺手把启动动画关掉。
        if (event.button !== 0) return;
        skip();
      }}
    >
      <div className="ttv-launch-orbit">
        <div className="ttv-launch-glow" />
        <div className="ttv-launch-guide" />
        {FRAME_GRADIENTS.slice(0, FRAME_COUNT).map((gradient, index) => (
          <span
            key={gradient}
            className="ttv-launch-frame"
            style={{ background: gradient }}
            data-frame={index}
          >
            <span className="ttv-launch-frame-title" />
            <span className="ttv-launch-frame-meta" />
          </span>
        ))}
        <span className="ttv-launch-logo-wrap">
          <img className="ttv-launch-logo" src="/app-icon.png" alt="" draggable={false} />
        </span>
        {/* 三圈冲击波：分别打在第一次、第三次、末次撞击上，尺寸由时间线里写内联 */}
        <span className="ttv-launch-ring" />
        <span className="ttv-launch-ring" />
        <span className="ttv-launch-ring" />
      </div>
      <span className="ttv-launch-hint">
        {holding ? '正在准备首页内容…（点击跳过）' : '点击跳过'}
      </span>
    </div>
  );
};

export default LaunchAnimation;
