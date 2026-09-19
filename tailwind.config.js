/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
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
        fluentPageIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
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
      }
    },
  },
  plugins: [],
}
