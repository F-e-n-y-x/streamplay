// Client-side preferences (localStorage). The TMDB key lives on the server, not here.

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

export function getSettings(): ClientSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
    const merged = { ...DEFAULTS, ...parsed };
    // Ensure array/fields are always defined and well-formed.
    merged.audioLanguages = Array.isArray(merged.audioLanguages) ? merged.audioLanguages : [];
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function setSettings(s: ClientSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}
