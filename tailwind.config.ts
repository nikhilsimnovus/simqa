import type { Config } from 'tailwindcss';

// ─────────────────────────────────────────────────────────────────────────
// Simnovus brand palette — petrol #00303F, orange #EC691F, mist #CAE0E7.
//
// Every colour resolves to a CSS custom property defined in globals.css
// rather than to a literal hex. That indirection is what makes the dark
// theme free: `[data-theme="dark"]` swaps the variables and all ~1,500
// existing colour classes across the app follow, with no page edits.
//
// The Tailwind scale NAMES are deliberately kept (slate / emerald / red /
// amber) even though the values are now brand colours, so the existing
// markup keeps working and reviews stay small:
//   slate   → petrol-tinted neutral (inverts in dark)
//   primary → Simnovus orange       (was Flowbite blue)
//   emerald → Simnovus teal         (the handout's "low steady" accent)
//   red     → brand-tuned danger
//   amber   → brand-tuned warning
//   blue    → mist/cyan info
// ─────────────────────────────────────────────────────────────────────────

const STOPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;

/** Build a Tailwind colour scale backed by `--c-<name>-<stop>` variables. */
function scale(name: string) {
  const out: Record<string, string> = {};
  for (const s of STOPS) out[s] = `rgb(var(--c-${name}-${s}) / <alpha-value>)`;
  return out;
}

const config: Config = {
  content: ['./src/**/*.{ts,tsx,js,jsx}'],
  // Class-based rather than media-based: the toggle in the sidebar owns the
  // theme, and the choice persists in localStorage. `dark:` variants still
  // work for the few places that need an explicit override.
  darkMode: ['class', '[data-theme="dark"]'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Poppins', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      colors: {
        slate:   scale('slate'),
        primary: { ...scale('primary'), DEFAULT: 'rgb(var(--c-primary-500) / <alpha-value>)' },
        emerald: scale('emerald'),
        success: { ...scale('emerald'), DEFAULT: 'rgb(var(--c-emerald-600) / <alpha-value>)' },
        red:     scale('red'),
        danger:  { ...scale('red'), DEFAULT: 'rgb(var(--c-red-600) / <alpha-value>)' },
        amber:   scale('amber'),
        warning: { ...scale('amber'), DEFAULT: 'rgb(var(--c-amber-500) / <alpha-value>)' },
        blue:    scale('blue'),
        // The app already reached for `orange-*` in ~50 places for "run /
        // primary action" — that intent IS the brand colour, so alias it
        // onto the same ramp instead of leaving a second, clashing orange.
        orange:  scale('primary'),
        // Likewise `sky-*` was the ad-hoc "info" hue; fold it into the
        // brand's mist/cyan so it themes with everything else.
        sky:     scale('blue'),
        // Stray hues that predate the re-skin (category chips on /ui-tests,
        // run-kind badges on /runs, the bulk-tests validate button). None of
        // them exist in the brand palette; unaliased they resolve to stock
        // Tailwind hex, which ignores [data-theme] and leaves light pastel
        // chips glowing on the dark surface. Fold each onto the nearest
        // brand ramp instead of editing every call site — the chips carry
        // text labels, so losing hue variety costs nothing.
        violet:  scale('blue'),
        indigo:  scale('blue'),
        cyan:    scale('blue'),
        teal:    scale('emerald'),
        lime:    scale('emerald'),
        yellow:  scale('amber'),
        rose:    scale('red'),
        purple:  scale('primary'),
        fuchsia: scale('primary'),
        pink:    scale('primary'),
        accent:  { ...scale('emerald'), DEFAULT: 'rgb(var(--c-emerald-500) / <alpha-value>)' },

        // Semantic surfaces. `surface` replaces the literal `bg-white` so
        // panels darken with the theme; `page` is the app background.
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        page:    'rgb(var(--c-page) / <alpha-value>)',
        panel:   'rgb(var(--c-panel2) / <alpha-value>)',
        line:    'rgb(var(--c-line) / <alpha-value>)',
        'line-strong': 'rgb(var(--c-line2) / <alpha-value>)',
        // Foreground that sits on a filled orange/red/teal surface.
        'on-accent': 'rgb(var(--c-onaccent) / <alpha-value>)',
      },
      borderRadius: {
        sm: '0.375rem',
        md: '0.5rem',
        lg: '0.625rem',
        xl: '0.75rem',    // 12px — card radius; deliberately not larger,
                          // the QA screens are dense and read better tight
      },
      boxShadow: {
        // Elevation that reads correctly on both petrol and paper.
        glow: 'var(--glow)',
        accent: '0 6px 18px -8px rgb(var(--c-primary-500) / .8)',
      },
      letterSpacing: {
        label: '.14em',   // the uppercase mono micro-labels
      },
      // Type scale pulled down one notch from Tailwind's defaults (each step
      // ~1px smaller). These are dense operational screens and the stock
      // scale ran large. Deliberately overriding fontSize only — padding and
      // control heights stay where they were tuned, and the app's arbitrary
      // px sizes (text-[10px]/[11px]) already sit in this range, so the two
      // families now line up instead of fighting.
      fontSize: {
        xs:   ['0.6875rem', { lineHeight: '1rem'     }],  // 11px (was 12)
        sm:   ['0.8125rem', { lineHeight: '1.25rem'  }],  // 13px (was 14)
        base: ['0.9375rem', { lineHeight: '1.5rem'   }],  // 15px (was 16)
        lg:   ['1.0625rem', { lineHeight: '1.5rem'   }],  // 17px (was 18)
        xl:   ['1.1875rem', { lineHeight: '1.75rem'  }],  // 19px (was 20)
        '2xl':['1.375rem',  { lineHeight: '1.875rem' }],  // 22px (was 24)
        '3xl':['1.6875rem', { lineHeight: '2.125rem' }],  // 27px (was 30)
      },
    },
  },
  plugins: [],
};
export default config;
