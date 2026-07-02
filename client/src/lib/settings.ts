// Client-side preferences (localStorage). The TMDB key lives on the server, not here.
import { useSyncExternalStore } from "react";

const KEY = "sp.settings.v3";

export interface ClientSettings {
  /** TMDB UI language code, e.g. "en-US". */
  lang: string;
  /** Preferred AUDIO languages in priority order, e.g. ["Hindi","English"]; first = primary. */
  audioLanguages: string[];
  /** Preferred anime track. */
  anime: "sub" | "dub";
  /** Default quality filter for sources. */
  quality: "auto" | "2160" | "1080" | "720";
  /** Auto-start the top source when sources load. */
  autoplay: boolean;
  /** Show 18+ / adult content. Default off. */
  adult: boolean;
}

const DEFAULTS: ClientSettings = {
  lang: "en-US",
  audioLanguages: [],
  anime: "sub",
  quality: "auto",
  autoplay: true,
  adult: false,
};

function read(): ClientSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
    const merged = { ...DEFAULTS, ...parsed };
    merged.audioLanguages = Array.isArray(merged.audioLanguages) ? merged.audioLanguages : [];
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

// In-memory snapshot kept in sync with localStorage so React can subscribe to it.
let current: ClientSettings = read();
const listeners = new Set<() => void>();
function emit() { listeners.forEach((l) => l()); }

export function getSettings(): ClientSettings { return current; }

export function setSettings(s: ClientSettings): void {
  current = { ...s, audioLanguages: Array.isArray(s.audioLanguages) ? s.audioLanguages : [] };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* quota */ }
  emit();
}

/** Merge a partial update and persist immediately. */
export function updateSettings(patch: Partial<ClientSettings>): void {
  setSettings({ ...current, ...patch });
}

// Keep tabs/windows in sync (and any stale reader) via the storage event.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) { current = read(); emit(); }
  });
}

/** React hook — re-renders the caller whenever settings change. */
export function useSettings(): ClientSettings {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => current,
  );
}
