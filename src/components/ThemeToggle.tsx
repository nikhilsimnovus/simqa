'use client';

import { useCallback, useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';

export const THEME_KEY = 'simqa-theme';

/**
 * Runs before first paint (injected into <head> in layout.tsx) so the page
 * never flashes light before switching to dark. Kept as a plain string —
 * it must not depend on the React bundle having loaded.
 */
export const THEME_BOOT_SCRIPT = `
(function(){
  try {
    var s = localStorage.getItem('${THEME_KEY}');
    var t = s === 'dark' || s === 'light'
      ? s
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`.trim();

type Theme = 'light' | 'dark';

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  // Start null so SSR and the pre-hydration DOM agree; the boot script has
  // already applied the real theme to <html> by the time this mounts.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const cur = document.documentElement.getAttribute('data-theme');
    setTheme(cur === 'dark' ? 'dark' : 'light');
  }, []);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { window.localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
      return next;
    });
  }, []);

  const isDark = theme === 'dark';
  const label = isDark ? 'Switch to light theme' : 'Switch to dark theme';

  return (
    <button
      type="button"
      onClick={toggle}
      title={label}
      aria-label={label}
      className={cn(
        'shrink-0 grid place-items-center rounded-lg border border-line-strong bg-panel',
        'text-slate-500 transition-colors hover:text-primary-700 hover:border-primary-500',
        compact ? 'h-8 w-8' : 'h-[34px] w-[34px]',
      )}
    >
      {/* Render nothing until hydrated so the icon can't contradict <html>. */}
      {theme === null ? null : isDark
        ? <Sun className="h-4 w-4" aria-hidden />
        : <Moon className="h-4 w-4" aria-hidden />}
    </button>
  );
}
