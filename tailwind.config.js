/** @type {import('tailwindcss').Config} */

/*
  调色板变量化。

  每个色阶编译成 `rgb(var(--c-<族>-<阶>, <Tailwind 默认值>) / <alpha-value>)`：
    - 第二个参数是回退值，浅色主题不定义任何变量，产物与变量化之前完全同色；
    - 暗色主题（src/styles/dark.css）只重定义这批变量一次，全站 200+ 处颜色类
      （含 hover:、ring-、shadow-、from-/via-/to- 变体）一起跟随，不必给每个
      className 补 dark: 变体——那种改法既容易漏，也会让以后新增的类默认掉回浅色。

  white / black 刻意**不**变量化：它们同时承担"浅色面板底"（bg-white/80）与
  "深色区玻璃高光 / 遮罩"（播放器的 bg-white/15、text-white/*、from-black/65）
  两种相反语义，反转任一种都会毁掉另一种。这两类在 dark.css 里按类名单独覆盖。
*/
const hexToRgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
};

/** 只列项目里真正用到的色阶：多一个就多一个要维护的暗色映射。 */
const PALETTE = {
  slate: {
    50: '#f8fafc', 100: '#f1f5f9', 200: '#e2e8f0', 300: '#cbd5e1', 400: '#94a3b8',
    500: '#64748b', 600: '#475569', 700: '#334155', 800: '#1e293b', 900: '#0f172a',
  },
  blue: {
    50: '#eff6ff', 100: '#dbeafe', 200: '#bfdbfe', 300: '#93c5fd',
    400: '#60a5fa', 500: '#3b82f6', 600: '#2563eb', 700: '#1d4ed8',
  },
  violet: {
    50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd',
    400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9',
  },
  rose: {
    50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3',
    400: '#fb7185', 500: '#f43f5e', 600: '#e11d48', 700: '#be123c',
  },
  amber: {
    50: '#fffbeb', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24',
    500: '#f59e0b', 600: '#d97706', 700: '#b45309',
  },
  emerald: {
    50: '#ecfdf5', 200: '#a7f3d0', 300: '#6ee7b7',
    400: '#34d399', 500: '#10b981', 600: '#059669', 700: '#047857',
  },
  purple: { 50: '#faf5ff', 200: '#e9d5ff', 500: '#a855f7', 700: '#7e22ce' },
  red: { 400: '#f87171', 500: '#ef4444', 600: '#dc2626' },
  sky: { 300: '#7dd3fc', 400: '#38bdf8' },
  indigo: { 500: '#6366f1' },
  orange: { 500: '#f97316' },
};

const themedPalette = Object.fromEntries(
  Object.entries(PALETTE).map(([family, steps]) => [
    family,
    Object.fromEntries(
      Object.entries(steps).map(([step, hex]) => [
        step,
        `rgb(var(--c-${family}-${step}, ${hexToRgb(hex)}) / <alpha-value>)`,
      ]),
    ),
  ]),
);

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ...themedPalette,
        mica: {
          light: '#f8fafc',
          card: 'rgba(255, 255, 255, 0.85)',
          border: 'rgba(255, 255, 255, 0.75)',
          text: '#0f172a',
          subtext: '#475569',
          accent: '#0067c0',
          accentHover: '#005fb8',
        }
      },
      fontFamily: {
        fluent: ['"Segoe UI Variable Display"', '"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'],
      },
      boxShadow: {
        'fluent-sm': '0 2px 4px rgba(0, 0, 0, 0.04)',
        'fluent': '0 8px 24px -4px rgba(0, 0, 0, 0.05), 0 2px 6px -1px rgba(0, 0, 0, 0.02)',
        'fluent-lg': '0 16px 36px -6px rgba(0, 0, 0, 0.08), 0 4px 12px -2px rgba(0, 0, 0, 0.03)',
        'fluent-hud': '0 20px 48px -8px rgba(0, 0, 0, 0.14), 0 0 1px 1px rgba(255, 255, 255, 0.8)',
      },
      animation: {
        'fade-in': 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-up': 'slideUp 0.35s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'slide-right': 'slideRight 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'pulse-subtle': 'pulseSubtle 2s infinite ease-in-out',
        // 与 fluent-card-in 同一条结论：入场动画不碰 opacity。
        //
        // 这条动画挂在 8 个常驻视图层上（App.tsx 每个视图一行，视图只被 display
        // 切换、从不卸载），所以比卡片那条更关键：
        //   - opacity 一旦进关键帧，forwards 会把恒等值 opacity:1 永久钉在那 8 层上，
        //     等于 8 个常驻合成层。项目已因同类残留让 NVIDIA VSR 失效过一次
        //     （见 AGENTS.md 不变量 26 与启动动画必须 cancel 的规矩）。
        //   - 更糟的是隐藏层：元素在 display:none 的祖先里创建时动画会卡在 0% 帧，
        //     而 0% 的 opacity:0 会被当真 —— 切到该视图先是一片透明，
        //     只能等悬停/重绘才现形（卡片那条长注释记的就是这个坑）。
        // 去掉 opacity 后入场仍有 8px 位移与 0.22s 缓动，观感几乎不变。
        'fluent-page-in': 'fluentPageIn 0.22s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'fluent-hero-poster': 'fluentHeroPoster 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        // **入场动画刻意不碰 opacity，也不要给卡片加 animation-delay。**
        //
        // 根因（实测，不是推断）：卡片的宿主视图是**常驻 DOM + hidden** 的（App.tsx 的视图
        // 切换只改 display），而元素在 `display: none` 的祖先里创建时，Chromium 的动画会
        // **永远卡在 `0%` 帧**：`getAnimations()` 返回空、`play-state` 却是 running，且
        // `0%` 里的 `opacity` 被当真、`transform` 却不计算（实测同一元素 opacity=0 而
        // transform=none）。结果就是那些卡片**永久空白**，直到鼠标扫过触发重绘/重新合成
        // 才现形——用户报的“卡片是空白的，悬停才刷新出来”就是它。
        //
        // 先把 `animation-fill-mode` 从 `both` 改成默认的 `none` 试过，**无效**：fill-mode
        // 只管“延迟期间”与“结束后”，而这里是“运行中停在第一帧”。真正解决问题的是
        // **不让入场动画碰 opacity**——即使动画卡在 0%，卡片也只是位移 14px、缩小 3%，
        // **始终可见**。视觉上入场仍有滑动与缩放，只是不再淡入。
        //
        // 另两个副作用（都是好的）：动画结束后不再锁定 transform，`hover:-translate-y-1.5`
        // 这类悬停位移恢复生效；同时因为无 fill-mode，调用处不能再加 `animation-delay`
        // （延迟期间元素可见，动画一开始会“闪一下”）。
        'fluent-card-in': 'fluentCardIn 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
        'fluent-scale-in': 'fluentScaleIn 0.28s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        'fluent-pop': 'fluentPop 0.22s cubic-bezier(0.34, 1.56, 0.64, 1) forwards',
        'fluent-slide-down': 'fluentSlideDown 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards',
        // 侧栏导航图标被选中那一下的弹跳。**只动 transform，不碰 opacity**：
        // 与上面几条同源——view 层是常驻 DOM，占位/透明类关键帧会留下永久残留。
        'nav-icon-pop': 'navIconPop 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        slideRight: {
          '0%': { opacity: '0', transform: 'translateX(24px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        pulseSubtle: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        // 只做位移，没有 opacity：理由见上方 fluent-page-in 的注释。
        fluentPageIn: {
          '0%': { transform: 'translateY(8px)' },
          '100%': { transform: 'translateY(0)' },
        },
        fluentHeroPoster: {
          '0%': { opacity: '0', transform: 'scale(0.92) translateY(12px)' },
          '100%': { opacity: '1', transform: 'scale(1) translateY(0)' },
        },
        // 只做位移与缩放，**不要加 opacity**：见上方 fluent-card-in 的注释，
        // 在 display:none 的常驻视图里创建的卡片会把 0% 帧永久钉住。
        fluentCardIn: {
          '0%': { transform: 'translateY(14px) scale(0.97)' },
          '100%': { transform: 'translateY(0) scale(1)' },
        },
        fluentScaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        fluentPop: {
          '0%': { opacity: '0', transform: 'scale(0.75)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        fluentSlideDown: {
          '0%': { opacity: '0', transform: 'translateY(-10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        navIconPop: {
          '0%': { transform: 'scale(0.72) rotate(-12deg)' },
          '55%': { transform: 'scale(1.18) rotate(4deg)' },
          '100%': { transform: 'scale(1) rotate(0deg)' },
        },
      }
    },
  },
  plugins: [],
}
