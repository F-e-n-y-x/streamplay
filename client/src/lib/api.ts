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
// `signal` lets TanStack Query cancel an in-flight request when the component
// unmounts or its inputs change — replacing the old hand-rolled `alive` guards.

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const s = getSettings();
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`/api${path}${sep}lang=${encodeURIComponent(s.lang)}&adult=${s.adult ? 1 : 0}`, { signal });
  if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Admin-Token": token } : {}) },
    body: JSON.stringify(body),
  });
  // Keep a JSON error body (endpoints return `{ ok:false, error }` on a 4xx so the UI can
  // show the reason), but if a failure comes back as non-JSON (e.g. a 500 HTML page) surface
  // a clean status error instead of throwing an opaque JSON parse error.
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (data == null) {
    if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
    return null as T;
  }
  return data as T;
}

export interface TorznabInfo { kind: string; url: string; hasKey: boolean; source: "ui" | "env" }

export interface HealthInfo {
  ok: boolean;
  tmdb: "live" | "fallback";
  warp?: boolean;
  time: string;
}

export interface BrowseOpts { cat?: string; type?: string; range?: string; region?: string; ol?: string; audio?: string; genres?: string[]; page?: number; /** cache-buster for the Random button (ignored by the server query) */ nonce?: number }
export const browseQuery = (section: string, opts: BrowseOpts = {}): string => {
  const p = new URLSearchParams({ section });
  if (opts.cat) p.set("cat", opts.cat);
  if (opts.type) p.set("type", opts.type);
  if (opts.range) p.set("range", opts.range);
  if (opts.region) p.set("region", opts.region);
  if (opts.ol && opts.ol !== "all") p.set("ol", opts.ol);
  if (opts.audio) p.set("audio", opts.audio);
  if (opts.genres && opts.genres.length) p.set("genres", opts.genres.join(","));
  p.set("page", String(opts.page ?? 1));
  return p.toString();
};

export const api = {
  health: (signal?: AbortSignal) => get<HealthInfo>("/health", signal),
  home: (signal?: AbortSignal) => get<{ rows: HomeRow[] }>("/home", signal).then((r) => arr(r.rows)),
  search: (q: string, page = 1, signal?: AbortSignal) =>
    get<{ items: Card[]; page: number; totalPages: number }>(
      `/search?q=${encodeURIComponent(q)}&page=${page}`, signal,
    ),
  browse: (section: string, opts: BrowseOpts = {}, signal?: AbortSignal) =>
    get<{ items: Card[]; page: number; totalPages: number }>(`/browse?${browseQuery(section, opts)}`, signal),
  title: (type: "movie" | "tv", id: number | string, signal?: AbortSignal) => get<TitleDetail>(`/title/${type}/${id}`, signal),
  season: (id: number | string, n: number, signal?: AbortSignal) =>
    get<{ seasonNumber: number; episodes: Episode[] }>(`/title/tv/${id}/season/${n}`, signal),
  providers: (signal?: AbortSignal) => get<ProviderInfo[]>("/providers", signal).then(arr),
  providersHealth: (signal?: AbortSignal) => get<ProviderHealth[]>("/providers/health", signal).then(arr),
  diag: (signal?: AbortSignal) => get<DiagInfo>("/diag", signal),
  skipTimes: (type: "movie" | "tv", id: number | string, episode: number, season?: number, length = 0) =>
    get<SkipTimes>(`/skip-times?type=${type}&id=${id}&episode=${episode}${season ? `&season=${season}` : ""}&length=${length}`),
  config: () => get<{ torznab: TorznabInfo | null; adminLock: boolean }>("/config"),
  saveTorznab: (body: { kind: string; url: string; apiKey: string }, token?: string) =>
    post<{ ok: boolean; error?: string; torznab: TorznabInfo | null }>("/config/torznab", body, token),
  testTorznab: () => get<{ ok: boolean; count?: number; error?: string }>("/config/torznab/test"),
};

/** Defensive: guarantee an array so a malformed payload can't crash a `.map` in render. */
function arr<T>(v: T[] | undefined | null): T[] { return Array.isArray(v) ? v : []; }

export interface SkipInterval { start: number; end: number; }
export interface SkipTimes { opening: SkipInterval | null; ending: SkipInterval | null; }

export interface DiagNode { host: string; up: boolean; latencyMs: number; version?: string; ip?: string; error?: string; }
export interface DiagInfo {
  directIp?: string;
  warpMode: string;
  warpEnabled: boolean;
  flaresolverr: DiagNode[];
  warpSocks: DiagNode[];
  tookMs: number;
  time: string;
}

/** Build the SSE URL for a sources run (consumed via EventSource). */
export function sourcesStreamUrl(opts: {
  type: "movie" | "tv";
  id: number | string;
  season?: number;
  episode?: number;
  /** Bypass the server's resolved-source cache and re-scan every provider. */
  fresh?: boolean;
  /** Re-scan only these provider ids (leave empty for all). */
  providers?: string[];
}): string {
  const s = getSettings();
  const p = new URLSearchParams({ type: opts.type, id: String(opts.id), lang: s.lang });
  if (opts.season != null) p.set("season", String(opts.season));
  if (opts.episode != null) p.set("episode", String(opts.episode));
  if (s.warp && s.warp !== "off") p.set("warp", s.warp);
  if (opts.fresh) p.set("fresh", "1");
  if (opts.providers && opts.providers.length) p.set("providers", opts.providers.join(","));
  if ((s as unknown as { torrentMode?: boolean }).torrentMode) p.set("torrent", "1");
  return `/api/sources/stream?${p.toString()}`;
}
