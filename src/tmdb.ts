import axios from 'axios';
import { dohAxios } from './utils/dns';
import { currentSignal } from './utils/reqctx';
import { MetaData, Season } from './types';

const TMDB_API_URL = 'https://api.themoviedb.org/3';
const API_KEY = process.env.TMDB_API_KEY || 'dummy_key'; // Ideally this should be a valid API key

// Resolve TMDB over DoH too (DOH_ENABLED) so metadata survives a poisoning ISP —
// otherwise every browse/title/search request dies at DNS before a provider runs.
const axiosInstance = axios.create({
    baseURL: TMDB_API_URL,
    ...dohAxios(),
    params: {
        api_key: API_KEY
    }
});
// Honour the per-request cancellation signal (abandoned SSE tab) on every call.
axiosInstance.interceptors.request.use((cfg) => { if (!cfg.signal) cfg.signal = currentSignal() as any; return cfg; });

/** Is a real TMDB key configured (vs. the dummy fallback)? */
export const tmdbIsLive = (): boolean => !!API_KEY && API_KEY !== 'dummy_key';

/** Generic TMDB GET. `params` merges over the api_key default. */
export const tmdbGet = async (path: string, params: Record<string, any> = {}): Promise<any> => {
    const res = await axiosInstance.get(path, { params });
    return res.data;
};

/** Build a TMDB image URL (or undefined). size e.g. 'w500', 'w780', 'w1280', 'original'. */
export const tmdbImg = (p?: string | null, size = 'w500'): string | undefined =>
    p ? `https://image.tmdb.org/t/p/${size}${p}` : undefined;

/** One classification for /title AND the resolver (they used to disagree on ja/th "Asian"). */
export const classify = (d: any) => {
    const genres: string[] = (d.genres || []).map((g: any) => g.name);
    const lang = d.original_language;
    const isAnime = genres.includes('Animation') && (lang === 'ja' || lang === 'zh');
    return {
        genres,
        isAnime,
        isCartoon: genres.includes('Animation') && !isAnime,   // Western/other animation, e.g. Ben 10
        isAsian: !isAnime && ['ko', 'zh', 'ja', 'th'].includes(lang),
        isBollywood: (d.production_countries || []).some((c: any) => c.iso_3166_1 === 'IN' || c.name === 'India'),
    };
};

export const getTMDBInfo = async (id: number, type: 'movie' | 'tv'): Promise<(MetaData & { episodeRuntime?: number }) | null> => {
    try {
        const { data } = await axiosInstance.get(`/${type}/${id}`, { params: { append_to_response: 'external_ids' } });
        const year = parseInt((data.release_date || data.first_air_date || '').slice(0, 4)) || undefined;
        return {
            id: data.id,
            title: data.title || data.name,
            originalTitle: data.original_title || data.original_name,
            type,
            year,
            originalLanguage: data.original_language,
            posterUrl: tmdbImg(data.poster_path, 'w500'),
            backgroundUrl: tmdbImg(data.backdrop_path, 'w1280'),
            description: data.overview,
            imdbId: data.external_ids?.imdb_id,
            episodeRuntime: data.episode_run_time?.[0] || undefined,   // typical episode length (min)
            rating: data.vote_average,
            ...classify(data),
            seasons: (data.seasons || []).map((s: any): Season => ({
                seasonNumber: s.season_number,
                name: s.name,
                episodeCount: s.episode_count,
                airDate: s.air_date,
            })),
        };
    } catch (error: any) {
        // message only — the AxiosError object carries the request params (api_key).
        console.error('Error fetching TMDB Info:', error?.message);
        return null;
    }
};
