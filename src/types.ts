export interface Stream {
    server: string;
    link: string;
    type: 'm3u8' | 'mp4' | 'iframe';
    quality?: string;
    headers?: Record<string, string>;
    /** For HLS with alternate audio: force this audio rendition (by NAME) to be the default. */
    audioName?: string;
    /** This `link` is a debrid-cached DIRECT http file (not a magnet): route it through
     *  /api/torrent/http (range passthrough for mp4, on-the-fly remux for mkv). */
    debrid?: boolean;
    /** Addon streams: the site behind the addon ("VidFast") and its free-text release notes. */
    origin?: string;
    description?: string;
}

export interface Subtitle {
    language: string;
    url: string;
    /** Headers the subtitle host needs (e.g. a Referer) — sent by /api/proxy/sub. */
    headers?: Record<string, string>;
}

export interface ExtractorResult {
    streams: Stream[];
    subtitles: Subtitle[];
}

export interface SearchResult {
    id: number;
    title: string;
    originalTitle?: string;
    type: 'movie' | 'tv';
    posterUrl?: string;
    year?: number;
    rating?: number;
}

export interface MetaData {
    id: number;
    title: string;
    originalTitle: string;
    type: 'movie' | 'tv';
    year?: number;
    originalLanguage?: string;
    posterUrl?: string;
    backgroundUrl?: string;
    description?: string;
    imdbId?: string;
    rating?: number;
    genres?: string[];
    isAnime?: boolean;
    isCartoon?: boolean;
    isAsian?: boolean;
    isBollywood?: boolean;
    seasons?: Season[];
    episodes?: Episode[];
}

export interface Season {
    seasonNumber: number;
    name: string;
    episodeCount: number;
    airDate?: string;
}

export interface Episode {
    seasonNumber: number;
    episodeNumber: number;
    title: string;
    description?: string;
    airDate?: string;
    stillUrl?: string;
}

export interface AnimeIds {
    malId?: number;
    anilistId?: number;
    zoroIds?: string[];
    kaasSlug?: string;
    animepaheUrl?: string;
    /** Alternative titles (AniList romaji/english/native + synonyms) for provider
     *  search — anime sites index by romaji/short title, not TMDB's English name. */
    titles?: string[];
}

export interface LinkData {
    id: number;
    imdbId?: string;
    tvdbId?: number;
    type: 'movie' | 'tv';
    season?: number;
    episode?: number;
    /** Absolute (series-wide) episode number for anime. Sources like AnimeTosho/Nyaa
     *  index anime by absolute episode, not season+episode — so S2E1 might be #13.
     *  Computed from TMDB prior-season episode counts; falls back to `episode`. */
    absoluteEpisode?: number;
    /** AniList cour titles for the SELECTED season (e.g. "Solo Leveling Season 2 -Arise
     *  from the Shadow-"). Torrents search these directly (that cour is numbered 1..N on
     *  Nyaa/AnimeTosho). Scraper providers keep using `title` + `season` — they do their
     *  own season matching, so overriding their title would break them. */
    animeSeasonTitles?: string[];
    /** Set when `title` has already been resolved to the EXACT entry for the selected
     *  anime cour (via AniList). Scraper providers then match by title and SKIP their
     *  season-scoring — anime sites title later seasons unpredictably ("…Season 2 -Arise
     *  from the Shadow-", "Shingeki no Kyojin: The Final Season"), so scoring on "season N"
     *  text lands on the wrong entry. */
    seasonResolved?: boolean;
    title: string;
    year?: number;
    /** Air year of the SELECTED season (not the series' first-air year). Providers
     *  that split a show into per-season entries (CastleTV, the anime sites) use
     *  this to pick the right season instead of always landing on episode-N of
     *  whichever entry ranked first. */
    seasonYear?: number;
    orgTitle?: string;
    isAnime?: boolean;
    isCartoon?: boolean;
    jpTitle?: string;
    date?: string;
    airedDate?: string;
    isAsian?: boolean;
    isBollywood?: boolean;
    animeIds?: AnimeIds;
}

/** Content kind a title is resolved as, used to gate which providers run. */
export type ContentKind = 'anime' | 'movie' | 'series' | 'asian';

export interface Provider {
    id: string;
    name: string;
    invoke: (data: LinkData) => Promise<ExtractorResult>;
    /**
     * This provider's upstream hard-blocks common egress IPs (e.g. AnimePahe's Kwik
     * CDN), so it only resolves through the Cloudflare WARP proxy. In WARP mode
     * `required` this is the flag that opts it in; in `off` it simply won't work.
     */
    requiresWarp?: boolean;
    /**
     * Which content kinds this provider can serve. OMITTED = all kinds (the generic
     * TMDB/IMDB-id providers). The resolver only runs providers whose `kinds` include
     * the requested kind, so an anime title doesn't wake ~12 Indian movie scrapers
     * (and their slow FlareSolverr solves), and vice-versa.
     */
    kinds?: ContentKind[];
}
