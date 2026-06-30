import { getSettings } from "./settings";
import type {
  Card,
  Episode,
  HomeRow,
  ProviderHealth,
  ProviderInfo,
  TitleDetail,
} from "./types";

// Thin fetch client for the StreamPlay backend (proxied at /api in dev).

async function get<T>(path: string): Promise<T> {
  const s = getSettings();
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`/api${path}${sep}lang=${encodeURIComponent(s.lang)}&adult=${s.adult ? 1 : 0}`);
  if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export interface HealthInfo {
  ok: boolean;
  tmdb: "live" | "fallback";
  time: string;
}

export const api = {
  health: () => get<HealthInfo>("/health"),
  home: () => get<{ rows: HomeRow[] }>("/home").then((r) => r.rows),
  search: (q: string, page = 1) =>
    get<{ items: Card[]; page: number; totalPages: number }>(
      `/search?q=${encodeURIComponent(q)}&page=${page}`,
    ),
  browse: (section: string, opts: { cat?: string; type?: string; range?: string; region?: string; audio?: string; genres?: string[]; page?: number } = {}) => {
    const p = new URLSearchParams({ section });
    if (opts.cat) p.set("cat", opts.cat);
    if (opts.type) p.set("type", opts.type);
    if (opts.range) p.set("range", opts.range);
    if (opts.region) p.set("region", opts.region);
    if (opts.audio) p.set("audio", opts.audio);
    if (opts.genres && opts.genres.length) p.set("genres", opts.genres.join(","));
    p.set("page", String(opts.page ?? 1));
    return get<{ items: Card[]; page: number; totalPages: number }>(`/browse?${p.toString()}`);
  },
  title: (type: "movie" | "tv", id: number | string) => get<TitleDetail>(`/title/${type}/${id}`),
  season: (id: number | string, n: number) =>
    get<{ seasonNumber: number; episodes: Episode[] }>(`/title/tv/${id}/season/${n}`),
  providers: () => get<ProviderInfo[]>("/providers"),
  providersHealth: () => get<ProviderHealth[]>("/providers/health"),
};

/** Build the SSE URL for a sources run (consumed via EventSource). */
export function sourcesStreamUrl(opts: {
  type: "movie" | "tv";
  id: number | string;
  season?: number;
  episode?: number;
}): string {
  const s = getSettings();
  const p = new URLSearchParams({ type: opts.type, id: String(opts.id), lang: s.lang });
  if (opts.season != null) p.set("season", String(opts.season));
  if (opts.episode != null) p.set("episode", String(opts.episode));
  return `/api/sources/stream?${p.toString()}`;
}
