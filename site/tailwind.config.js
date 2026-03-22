/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base:    '#0D1117',
        surf1:   '#161B22',
        surf2:   '#21262D',
        border:  '#30363D',
        muted:   '#484F58',
        gray:    '#8B949E',
        text:    '#E6EDF3',
        algo:    '#00C8FF',
        voi:     '#8B5CF6',
        usdc:    '#2775CA',
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'sans-serif'],
        mono: ['monospace'],
      },
    },
  },
  plugins: [],
}
