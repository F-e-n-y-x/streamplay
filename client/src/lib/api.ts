import { useSyncExternalStore } from "react";
import { getSettings } from "./settings";
import type {
  AddonKind,
  AddonPreview,
  CatalogEntry,
  ScraperRepo,
  AddonList,
  Card,
  Episode,
  HomeRow,
  MetaSource,
  NuvioManifestStatus,
  ProviderHealth,
  ProviderInfo,
  TitleDetail,
} from "./types";

// Thin fetch client for the StreamPlay backend (proxied at /api in dev).
// `signal` lets TanStack Query cancel an in-flight request when the component
// unmounts or its inputs change — replacing the old hand-rolled `alive` guards.

// STREAMPLAY_PASSWORD: the server answers 401 on /api/* until the browser has the
// sp_key cookie (set by visiting `/?key=<password>`). Any 401 flips this flag and
// App shows the password screen.
let authNeeded = false;
const authListeners = new Set<() => void>();
function check401(res: Response) {
  if (res.status === 401 && !authNeeded) { authNeeded = true; authListeners.forEach((l) => l()); }
}
export function useAuthNeeded(): boolean {
  return useSyncExternalStore((fn) => { authListeners.add(fn); return () => authListeners.delete(fn); }, () => authNeeded);
}

async function get<T>(path: string, signal?: AbortSignal, token?: string): Promise<T> {
  const s = getSettings();
  const sep = path.includes("?") ? "&" : "?";
  const headers = token ? { "X-Admin-Token": token } : undefined;
  const res = await fetch(`/api${path}${sep}lang=${encodeURIComponent(s.lang)}&adult=${s.adult ? 1 : 0}`, { signal, headers });
  check401(res);
  if (!res.ok) await fail(res);
  return (await res.json()) as T;
}

/** A failed API call. `message` is the server's user-safe `error` text when it sent one
 *  (e.g. "Title not found"), so pages can show it as-is; status/code stay for logic. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); this.name = "ApiError"; }
}
const STATUS_TEXT: Record<number, string> = { 400: "The request wasn't valid.", 403: "Not allowed.", 404: "Not found.", 429: "Too many requests. Wait a moment and try again." };
async function fail(res: Response): Promise<never> {
  let body: { error?: unknown; code?: unknown } | null = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  const msg = typeof body?.error === "string" && body.error ? body.error
    : STATUS_TEXT[res.status] ?? (res.status >= 500 ? "The server couldn't finish the request." : `Request failed (${res.status}).`);
  throw new ApiError(msg, res.status, typeof body?.code === "string" ? body.code : undefined);
}

async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { "X-Admin-Token": token } : {}) },
    body: JSON.stringify(body),
  });
  check401(res);
  // Keep a JSON error body (endpoints return `{ ok:false, error }` on a 4xx so the UI can
  // show the reason), but if a failure comes back as non-JSON (e.g. a 500 HTML page) surface
  // a clean status error instead of throwing an opaque JSON parse error.
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (data == null) {
    if (!res.ok) throw new ApiError(STATUS_TEXT[res.status] ?? "The server couldn't finish the request.", res.status);
    return null as T;
  }
  return data as T;
}

/** Admin write/inspect: same as post(), but a `{ok:false, error}` reply throws an ApiError. */
async function adminPost<T>(path: string, body: unknown, token: string): Promise<T> {
  const r = await post<{ ok?: boolean; error?: string } | null>(path, body, token || undefined);
  if (!r?.ok) throw new ApiError(r?.error || "The server couldn't finish the request.", 0);
  return r as T;
}

export interface TorznabInfo { kind: string; url: string; hasKey: boolean; source: "ui" | "env" }

export interface ServerConfig {
  torznab: TorznabInfo | null;
  adminLock: boolean;
  nuvio: AddonList & { status: NuvioManifestStatus[] };
  stremio: AddonList;
}

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
    get<{ items: Card[]; page: number; totalPages: number; didYouMean?: string }>(
      `/search?q=${encodeURIComponent(q)}&page=${page}`, signal,
    ),
  /** As-you-type, typo-tolerant top 8 (header/search dropdown). */
  suggest: (q: string, signal?: AbortSignal) =>
    get<{ items: Card[]; didYouMean?: string }>(`/suggest?q=${encodeURIComponent(q)}`, signal),
  browse: (section: string, opts: BrowseOpts = {}, signal?: AbortSignal) =>
    get<{ items: Card[]; page: number; totalPages: number }>(`/browse?${browseQuery(section, opts)}`, signal),
  title: (type: "movie" | "tv", id: number | string, signal?: AbortSignal) => get<TitleDetail>(`/title/${type}/${id}`, signal),
  // Resolve a browsed AniList anime card → a playable TMDB {type,id} (+ echoed anilistId).
  resolveAnime: (card: Card, signal?: AbortSignal) =>
    get<{ type: "movie" | "tv"; id: number; anilistId?: number }>(
      `/resolve/anime?al=${card.anilistId ?? ""}&titles=${encodeURIComponent(JSON.stringify(card.resolveTitles ?? [card.title]))}&year=${card.year ?? ""}&type=${card.resolveType ?? card.type}`,
      signal,
    ),
  // `src` = TitleDetail.metaSource, so the server numbers seasons the way /title did.
  season: (id: number | string, n: number, signal?: AbortSignal, src?: MetaSource) =>
    get<{ seasonNumber: number; episodes: Episode[] }>(`/title/tv/${id}/season/${n}${src ? `?src=${src}` : ""}`, signal),
  providers: (signal?: AbortSignal) => get<ProviderInfo[]>("/providers", signal).then(arr),
  providersHealth: (signal?: AbortSignal) => get<ProviderHealth[]>("/providers/health", signal).then(arr),
  diag: (signal?: AbortSignal) => get<DiagInfo>("/diag", signal),
  skipTimes: (type: "movie" | "tv", id: number | string, episode: number, season?: number, length = 0, src?: MetaSource) =>
    get<SkipTimes>(`/skip-times?type=${type}&id=${id}&episode=${episode}${season ? `&season=${season}` : ""}&length=${length}${src ? `&src=${src}` : ""}`),
  config: (signal?: AbortSignal, token?: string) => get<ServerConfig>("/config", signal, token),
  saveTorznab: (body: { kind: string; url: string; apiKey: string }, token?: string) =>
    post<{ ok: boolean; error?: string; torznab: TorznabInfo | null }>("/config/torznab", body, token),
  testTorznab: () => get<{ ok: boolean; count?: number; error?: string }>("/config/torznab/test"),
  addonCatalog: (signal?: AbortSignal) => get<{ entries: CatalogEntry[] }>("/addons/catalog", signal).then((r) => arr(r.entries)),
  /** Manifest preview. Fetches JSON only; the server never runs scraper code for it. */
  inspectAddon: (url: string, token: string) => adminPost<AddonPreview>("/addons/inspect", { url }, token),
  scrapers: (signal?: AbortSignal, token?: string) => get<{ repos: ScraperRepo[] }>("/addons/scrapers", signal, token).then((r) => arr(r.repos)),
  /** `null` resets a scraper to its manifest default. */
  setScrapers: (changes: Record<string, boolean | null>, token: string) =>
    adminPost<{ ok: true; repos: ScraperRepo[] }>("/addons/scrapers", { changes }, token).then((r) => r.repos),
  /** Replace a whole addon list (throws on {ok:false}). */
  setAddons: (kind: AddonKind, urls: string[] | null, token: string) => adminPost<{ ok: true }>(`/config/${kind}`, { urls }, token),
  /** Playback feedback so the server's source scoring learns (ux/sources-contract.md).
   *  Fire-and-forget: never throws, survives page unload (keepalive). */
  reportSource: (body: { provider: string; outcome: "played" | "failed" | "stalled"; url?: string; ttffMs?: number; error?: string }) => {
    fetch("/api/sources/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => { /* best effort */ });
  },
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
  /** TitleDetail.metaSource — which season numbering `season` is in. */
  src?: MetaSource;
}): string {
  const s = getSettings();
  const p = new URLSearchParams({ type: opts.type, id: String(opts.id), lang: s.lang });
  if (opts.season != null) p.set("season", String(opts.season));
  if (opts.episode != null) p.set("episode", String(opts.episode));
  if (s.warp && s.warp !== "off") p.set("warp", s.warp);
  if (opts.fresh) p.set("fresh", "1");
  if (opts.src) p.set("src", opts.src);
  if (opts.providers && opts.providers.length) p.set("providers", opts.providers.join(","));
  if ((s as unknown as { torrentMode?: boolean }).torrentMode) p.set("torrent", "1");
  // Scoring prefs: preferred audio languages (names the server accepts) + anime Sub/Dub.
  const audio = s.audioLanguages.filter((l) => /^[A-Za-z ]{2,20}$/.test(l)).slice(0, 10);
  if (audio.length) p.set("audio", audio.join(","));
  p.set("anime", s.anime);
  return `/api/sources/stream?${p.toString()}`;
}
