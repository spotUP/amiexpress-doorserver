/**
 * One dark palette, defined once. Every colour in the UI is a token from
 * here; nothing hardcodes a hex value.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0b0d10',
        surface: '#14181d',
        raised: '#1b2027',
        line: '#272e37',
        ink: '#e6e9ee',
        muted: '#9aa4b2',
        accent: '#5ac8fa',
        'accent-dim': '#2a6f8a',
        ok: '#4ade80',
        warn: '#fbbf24',
        danger: '#f87171',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
        // For text the Amiga drew: DIZ art, .guide documents, tooltypes.
        amiga: ['TopazPlus', 'Topaz', 'ui-monospace', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
