/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 浅色单层令牌：靠留白与分隔线分层，不靠阴影堆叠
        canvas: '#ffffff',
        subtle: '#fafafa',
        surface: '#f4f4f5',
        line: '#e8e8ec',
        ink: '#1d1e20',
        muted: '#6b6b73',
        faint: '#9a9aa2',
        accent: {
          DEFAULT: '#2563eb',
          soft: 'rgba(37,99,235,0.08)',
          strong: '#1d4ed8',
        },
      },
      fontFamily: {
        sans: ['"PingFang SC"', '"Microsoft YaHei"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Consolas', 'monospace'],
      },
      borderRadius: {
        xl2: '14px',
      },
      boxShadow: {
        sheet: '-8px 0 40px -12px rgba(16, 18, 22, 0.18)',
        composer: '0 1px 2px rgba(16, 18, 22, 0.04)',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'slide-in': {
          '0%': { opacity: '0', transform: 'translateX(16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        pulseSoft: {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '.35' },
        },
      },
      animation: {
        'fade-up': 'fade-up .18s ease-out both',
        'fade-in': 'fade-in .15s ease-out both',
        'slide-in': 'slide-in .2s ease-out both',
        'pulse-soft': 'pulseSoft 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
