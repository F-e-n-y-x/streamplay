// Mirrors the backend API shapes (see server/src).

export interface Card {
  id: number;
  type: "movie" | "tv";
  title: string;
  posterUrl?: string;
  backdropUrl?: string;
  year?: string;
  voteAverage?: number;
  voteCount?: number;
  overview?: string;
  // Anime browse cards come from AniList (id = AniList id) and resolve to a playable
  // TMDB id on click. `resolveTitles` carries the JP/romaji/English name variants.
  needsResolve?: boolean;
  anilistId?: number;
  resolveTitles?: string[];
  resolveType?: "movie" | "tv";
}

export interface HomeRow {
  key: string;
  name: string;
  type: "movie" | "tv";
  items: Card[];
}

export interface Classification {
  isAnime: boolean;
  isAsian: boolean;
  isBollywood: boolean;
  isCartoon: boolean;
}

export interface SeasonStub {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  /** AniList cour id (anime plans only) — lets a browsed season deep-link to itself. */
  anilistId?: number;
}

export interface CastMember {
  name: string;
  character?: string;
  profileUrl?: string;
}

export interface TitleDetail {
  id: number;
  type: "movie" | "tv";
  title: string;
  posterUrl?: string;
  backdropUrl?: string;
  year?: string;
  overview?: string;
  runtime?: number;
  voteAverage?: number;
  genres: string[];
  imdbId?: string;
  cast: CastMember[];
  recommendations: Card[];
  trailerKeys: string[];
  seasons: SeasonStub[];
  /** Which plan numbered `seasons`. Pass it back as `src` to api.season / sourcesStreamUrl / skipTimes. */
  metaSource?: MetaSource;
  /** Set when the title was opened by AniList id (negative URL id): the cour to pre-select. */
  anilistId?: number;
  classification: Classification;
  /** ISO 639-1 ("en", "ko"): the default audio preference when the user set none */
  originalLanguage?: string;
}

export type MetaSource = "anilist" | "tvdb" | "castle" | "tmdb";

export interface Episode {
  id: number | string;
  name: string;
  overview?: string;
  stillUrl?: string;
  episodeNumber: number;
  seasonNumber: number;
  voteAverage?: number;
  airDate?: string;
  /** minutes */
  runtime?: number;
}

export interface ProviderStats {
  successRate: number;
  avgTimeMs: number;
  isCircuitBroken: boolean;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
}

export interface ProviderInfo {
  id: string;
  name: string;
  kind: "multi" | "movie" | "series" | "anime" | "bollywood" | "asian" | "subtitles";
  host: string;
  needsToken?: boolean;
  stats: ProviderStats;
  priorityScore: number;
}

export interface ProviderHealth {
  id: string;
  name: string;
  host: string;
  status: "up" | "down";
  latencyMs: number;
  httpStatus?: number;
}

export type ProviderRunState = "pending" | "running" | "found" | "empty" | "failed" | "circuit-broken";

export interface ProviderRun {
  id: string;
  name: string;
  state: ProviderRunState;
  durationMs?: number;
  /** Backend streams the resolved links array (empty for ping-only providers). */
  links: StreamLink[];
  priorityScore: number;
  note?: string;
}

export interface StreamLink {
  providerId: string;
  name: string;
  url: string;
  type: "youtube" | "m3u8" | "mp4" | "iframe";
  quality?: number;
  playable: boolean;
  host?: string;
}

export interface SubtitleTrack {
  providerId: string;
  lang: string;
  url: string;
}

/** Nuvio plugin repos / Stremio addon manifests (server-wide, GET /api/config). */
export interface AddonList { urls: string[]; source: "ui" | "env" | "none"; redacted?: boolean }
export interface NuvioManifestStatus { manifest: string; name?: string; ok: boolean; error?: string; scrapers: string[] }
export type AddonKind = "nuvio" | "stremio";

/** GET /api/addons/catalog — curated, server-checked addons. */
export interface CatalogEntry {
  name: string;
  manifestUrl: string;
  kind: AddonKind;
  description: string;
  tags: string[];
  needsDebrid: boolean;
  needsConfig?: boolean;
  configureUrl?: string;
  obfuscated: boolean;
  obfuscatedCount?: number;
  scraperCount?: number;
  lastUpdated?: string;
  lastChecked: string;
  added: boolean;
}

/** POST /api/addons/inspect — manifest preview (the server never runs scraper code for it). */
export type AddonPreview = { ok: true; added: boolean; name: string; version?: string; description?: string; warnings: string[] } & (
  | { kind: "nuvio"; scrapers: { id: string; name: string; supportedTypes: ("movie" | "tv")[]; enabled: boolean; description?: string; contentLanguage?: string[]; formats?: string[] }[] }
  | { kind: "stremio"; logo?: string; types: string[]; stream?: { types: string[] }; subtitles?: { types: string[] }; configurationRequired: boolean }
);

/** GET/POST /api/addons/scrapers — every scraper of every configured Nuvio repo. */
export interface ScraperRepo {
  manifest: string;
  name?: string;
  ok: boolean;
  error?: string;
  scrapers: {
    id: string;
    scraperId: string;
    name: string;
    enabled: boolean;
    manifestEnabled: boolean;
    supportedTypes: ("movie" | "tv")[];
    description?: string;
    contentLanguage?: string[];
  }[];
}
