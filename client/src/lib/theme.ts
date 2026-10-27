// Theme — flips data-theme on <html>, persists, and keeps the browser chrome
// (theme-color) in step. The pre-paint script in index.html sets the initial value.
// Dark is the default for everyone; light and "match device" are opt-in (Settings › Appearance).
import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
export type ThemePref = Theme | "system";
const COLOR: Record<Theme, string> = { dark: "#0a0a0c", light: "#f5f5f3" };
const listeners = new Set<() => void>();
const lightMq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;

export function getThemePref(): ThemePref {
  try { const t = localStorage.getItem("sp.theme"); return t === "light" || t === "system" ? t : "dark"; } catch { return "dark"; }
}

function apply() {
  const p = getThemePref();
  const t: Theme = p === "system" ? (lightMq?.matches ? "light" : "dark") : p;
  document.documentElement.setAttribute("data-theme", t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", COLOR[t]);
  listeners.forEach((l) => l());
}

export function setThemePref(p: ThemePref): void {
  try { localStorage.setItem("sp.theme", p); } catch { /* private mode */ }
  apply();
}

// "Match device" follows the OS live; also covers a stale pre-paint guess.
lightMq?.addEventListener("change", () => { if (getThemePref() === "system") apply(); });
if (typeof document !== "undefined" && getThemePref() === "system") apply();

/** React hook: the stored preference (dark | light | system), re-renders on change. */
export function useThemePref(): ThemePref {
  return useSyncExternalStore((fn) => { listeners.add(fn); return () => listeners.delete(fn); }, getThemePref);
}
