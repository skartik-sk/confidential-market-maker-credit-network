"use client";

import { useEffect, useState } from "react";

/**
 * Dark-mode toggle. The initial class (from localStorage "mute-theme" or the
 * OS preference) is applied before paint by the inline script in layout.tsx;
 * this button only flips the class from there on. Theme is read in a
 * useEffect (never during render) so SSR output is stable — no hydration
 * mismatch.
 */

const STORAGE_KEY = "mute-theme";

export function ThemeToggle() {
  // null = not mounted yet (matches the SSR render)
  const [dark, setDark] = useState<boolean | null>(null);

  useEffect(() => {
    setDark(document.documentElement.classList.contains("dark"));
  }, []);

  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem(STORAGE_KEY, next ? "dark" : "light");
    } catch {
      /* private mode — theme just won't persist */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Toggle dark mode"
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="w-7 h-7 flex items-center justify-center rounded-lg border border-line text-muted hover:text-ink hover:border-line-2 transition-colors text-[13px] leading-none select-none shrink-0"
    >
      {/* ◐ = light (click for dark) · ◑ = dark (click for light) */}
      {dark ? "◑" : "◐"}
    </button>
  );
}
