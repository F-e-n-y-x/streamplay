export interface Stream {
    server: string;
    link: string;
    type: 'm3u8' | 'mp4' | 'iframe';
    quality?: string;
    headers?: Record<string, string>;
}

export interface Subtitle {
    language: string;
    url: string;
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
}

export interface LinkData {
    id: number;
    imdbId?: string;
    tvdbId?: number;
    type: 'movie' | 'tv';
    season?: number;
    episode?: number;
    title: string;
    year?: number;
    orgTitle?: string;
    isAnime?: boolean;
    jpTitle?: string;
    date?: string;
    airedDate?: string;
    isAsian?: boolean;
    isBollywood?: boolean;
    animeIds?: AnimeIds;
}

export interface Provider {
    id: string;
    name: string;
    invoke: (data: LinkData) => Promise<ExtractorResult>;
}
