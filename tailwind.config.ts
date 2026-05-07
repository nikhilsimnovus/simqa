import type { Config } from 'tailwindcss';

// Color palette mirrors Simnovator's web UI: Flowbite-style blue primary,
// emerald success, cyan accent, neutral gray scale. shadcn/ui token names
// kept so component primitives drop in cleanly.
const config: Config = {
  content: ['./src/**/*.{ts,tsx,js,jsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Poppins', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      colors: {
        // Flowbite-style primary (blue 700)
        primary: {
          50:  '#EBF5FF',
          100: '#E1EFFE',
          200: '#C3DDFD',
          300: '#A4CAFE',
          400: '#76A9FA',
          500: '#3F83F8',
          600: '#1C64F2',
          700: '#1A56DB',
          800: '#1E429F',
          900: '#233876',
          DEFAULT: '#1A56DB',
        },
        success: {
          50:  '#F3FAF7',
          100: '#DEF7EC',
          400: '#31C48D',
          500: '#0E9F6E',
          600: '#057A55',
          700: '#046C4E',
          DEFAULT: '#0E9F6E',
        },
        accent: {
          400: '#22D3EE',
          500: '#16BDCA',
          600: '#0891B2',
          DEFAULT: '#16BDCA',
        },
        warning: { DEFAULT: '#F59E0B' },
        danger:  { DEFAULT: '#E02424' },
      },
      borderRadius: {
        lg: '0.625rem',
        md: '0.5rem',
        sm: '0.375rem',
      },
    },
  },
  plugins: [],
};
export default config;
