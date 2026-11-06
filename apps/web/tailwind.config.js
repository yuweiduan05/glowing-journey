/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 深海蓝：冷白画布 + 墨蓝文字 + 单一强调色，靠留白与分隔线分层
        canvas: '#ffffff',
        base: '#f4f8ff',
        subtle: '#f5f8ff',
        surface: '#edf2fe',
        line: '#e1e8f5',
        ink: '#0f172a',
        muted: '#5b647a',
        faint: '#8a93a8',
        accent: {
          DEFAULT: '#4d6bfe',
          soft: 'rgba(77,107,254,0.08)',
          strong: '#3b55d9',
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
        // 生成中的输入区呼吸光环：极轻量的 accent 光晕起伏，暗示「引擎运转中」
        breathe: {
          '0%, 100%': {
            boxShadow:
              '0 1px 2px rgba(16,18,22,0.04), 0 0 0 0 rgba(37,99,235,0)',
          },
          '50%': {
            boxShadow:
              '0 1px 2px rgba(16,18,22,0.04), 0 0 0 4px rgba(37,99,235,0.05), 0 2px 14px -2px rgba(37,99,235,0.10)',
          },
        },
        // 思考指示三点：只抬升 1.5px + 透明度起伏，避免弹跳感
        wave: {
          '0%, 60%, 100%': { opacity: '.25', transform: 'translateY(0)' },
          '30%': { opacity: '1', transform: 'translateY(-1.5px)' },
        },
      },
      animation: {
        'fade-up': 'fade-up .18s ease-out both',
        'fade-in': 'fade-in .15s ease-out both',
        'slide-in': 'slide-in .2s ease-out both',
        'pulse-soft': 'pulseSoft 1.4s ease-in-out infinite',
        breathe: 'breathe 3.4s ease-in-out infinite',
        wave: 'wave 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
