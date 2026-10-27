// Client-side preferences (localStorage). The TMDB key lives on the server, not here.
import { useSyncExternalStore } from "react";

const KEY = "sp.settings.v3";
// Torrent mode is DEVICE-LOCAL: turning it on for one device must not disturb the
// others (torrent streaming uses that box's bandwidth/egress). It lives in its own
// key and is deliberately excluded from cross-device sync — see applyRemoteSettings.
const TKEY = "sp.torrentMode";
const readTMode = (): boolean => { try { return localStorage.getItem(TKEY) === "1"; } catch { return false; } };
const writeTMode = (v: boolean): void => { try { localStorage.setItem(TKEY, v ? "1" : "0"); } catch { /* quota */ } };

// DEVICE-LOCAL settings: these describe THIS screen/device (playback speed, subtitle
// look, voice boost) — a phone and a desktop want different values — so they are kept
// in a separate key and deliberately EXCLUDED from cross-device sync. Changing speed on
// your phone must not change it on your desktop.
const DKEY = "sp.deviceSettings";
const DEVICE_LOCAL_KEYS = ["subtitleSize", "subtitleColor", "subtitleBgOpacity", "voiceBoost", "subtitlePref"] as const;
const readDevice = (): Partial<ClientSettings> => { try { return JSON.parse(localStorage.getItem(DKEY) || "{}"); } catch { return {}; } };
const writeDevice = (s: ClientSettings): void => {
  const o: Record<string, unknown> = {};
  for (const k of DEVICE_LOCAL_KEYS) o[k] = s[k];
  try { localStorage.setItem(DKEY, JSON.stringify(o)); } catch { /* quota */ }
};

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
  /** Auto-advance to the next episode when the current one ends. */
  autoNext: boolean;
  /** Auto-skip anime openings/endings using AniSkip data. */
  autoSkip: boolean;
  /** Show 18+ / adult content. Default off. */
  adult: boolean;
  /**
   * Cloudflare WARP proxy usage for provider scraping (only effective if the
   * server has WARP configured). off = never; required = only providers that need
   * it (e.g. AnimePahe); fallback = retry a failed provider through WARP; all =
   * route everything through WARP.
   */
  warp: "off" | "required" | "fallback" | "all";
  /**
   * Per-content-kind provider preferences (kind = anime | movie | series | asian).
   * `order` pins providers to the top in that sequence; `hidden` removes them from
   * the sources list + autoplay for that kind. Empty = registration order, none hidden.
   */
  providerPrefs: Record<string, { order: string[]; hidden: string[] }>;
  /** Last provider played per kind — reused first on the next episode (sticky). */
  stickyProvider: Record<string, string>;
  /**
   * Torrent mode: hide the scraper providers and resolve via torrents streamed through
   * WebTorrent — the durable, never-rots source. Anime via AnimeTosho/Nyaa, movies via
   * YTS/The Pirate Bay, TV via EZTV/The Pirate Bay. DEVICE-LOCAL (never synced).
   */
  torrentMode: boolean;
  /** Subtitle appearance (applied to the player's rendered cues). */
  subtitleSize: "sm" | "md" | "lg" | "xl";
  subtitleColor: string;          // hex, e.g. "#ffffff"
  subtitleBgOpacity: number;      // 0..1 background box opacity behind cues
  /** Dialogue/voice boost level (0 = off, 1 = low, 2 = medium, 3 = high). Device-local. */
  voiceBoost: number;
  /** Remembered subtitle choice: a language name to auto-enable when present, "off" to
   *  keep subtitles disabled, or "" for no preference yet. Device-local. */
  subtitlePref: string;
  /** LWW timestamp for cross-device settings sync. */
  updatedAt: number;
}

const DEFAULTS: ClientSettings = {
  lang: "en-US",
  audioLanguages: [],
  anime: "sub",
  quality: "auto",
  autoplay: true,
  autoNext: true,
  autoSkip: true,
  adult: false,
  warp: "off",
  providerPrefs: {},
  stickyProvider: {},
  torrentMode: false,
  subtitleSize: "md",
  subtitleColor: "#ffffff",
  subtitleBgOpacity: 0.6,
  voiceBoost: 0,
  subtitlePref: "",
  updatedAt: 0,
};

function read(): ClientSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
    const merged = { ...DEFAULTS, ...parsed };
    merged.audioLanguages = Array.isArray(merged.audioLanguages) ? merged.audioLanguages : [];
    merged.providerPrefs = (merged.providerPrefs && typeof merged.providerPrefs === "object") ? merged.providerPrefs : {};
    merged.stickyProvider = (merged.stickyProvider && typeof merged.stickyProvider === "object") ? merged.stickyProvider : {};
    merged.torrentMode = readTMode();   // device-local, never from the synced blob
    Object.assign(merged, readDevice());   // device-local player prefs (subtitle look, voice boost)
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
  // A local change bumps updatedAt so it wins LWW. Use a monotonic stamp
  // (max of wall-clock and prev+1) so two edits in the same millisecond, or edits
  // on a device whose clock lags behind a peer's, still produce a strictly larger
  // value and therefore actually sync instead of being silently dropped.
  const nextTs = Math.max(Date.now(), (current.updatedAt || 0) + 1);
  current = { ...s, audioLanguages: Array.isArray(s.audioLanguages) ? s.audioLanguages : [], updatedAt: nextTs };
  writeTMode(current.torrentMode);                 // persist device-local torrent mode
  writeDevice(current);                            // persist device-local player prefs
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* quota */ }
  emit();
}

/** Merge a partial update and persist immediately. */
export function updateSettings(patch: Partial<ClientSettings>): void {
  setSettings({ ...current, ...patch });
}

/**
 * Apply a settings object received from another device (sync). Unlike setSettings
 * it PRESERVES the remote updatedAt (doesn't bump it), so it won't be re-pushed and
 * loop. The caller (store sync) is responsible for the LWW comparison.
 */
export function applyRemoteSettings(remote: ClientSettings): void {
  // Keep THIS device's torrent mode — never let a peer's value clobber it.
  // Keep THIS device's torrent mode + player prefs — never let a peer's values clobber them.
  current = { ...DEFAULTS, ...remote, torrentMode: readTMode(), ...readDevice(), audioLanguages: Array.isArray(remote.audioLanguages) ? remote.audioLanguages : [] };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* quota */ }
  emit();
}

/** Subscribe to any settings change (returns an unsubscribe fn). Used by the sync layer. */
export function onSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Keep tabs/windows in sync (and any stale reader) via the storage event.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === TKEY) { current = read(); emit(); }
  });
}

/** React hook — re-renders the caller whenever settings change. */
export function useSettings(): ClientSettings {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => current,
  );
}

// ADMIN_TOKEN typed in Settings: kept for this browser tab only (sessionStorage), never synced
// or written to localStorage. It unlocks server-wide edits (addons, indexer) and full addon URLs.
const ATKEY = "sp.adminToken";
let adminToken = (() => { try { return sessionStorage.getItem(ATKEY) || ""; } catch { return ""; } })();
const adminSubs = new Set<() => void>();
export function setAdminToken(t: string): void {
  adminToken = t;
  try { if (t) sessionStorage.setItem(ATKEY, t); else sessionStorage.removeItem(ATKEY); } catch { /* private mode */ }
  adminSubs.forEach((f) => f());
}
export function useAdminToken(): string {
  return useSyncExternalStore((f) => { adminSubs.add(f); return () => adminSubs.delete(f); }, () => adminToken);
}
