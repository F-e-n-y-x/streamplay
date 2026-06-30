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
  classification: Classification;
}

export interface Episode {
  id: number;
  name: string;
  overview?: string;
  stillUrl?: string;
  episodeNumber: number;
  seasonNumber: number;
  voteAverage?: number;
  airDate?: string;
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
