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
        'fluent-card-in': 'fluentCardIn 0.35s cubic-bezier(0.16, 1, 0.3, 1) both',
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
        fluentCardIn: {
          '0%': { opacity: '0', transform: 'translateY(14px) scale(0.97)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
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
