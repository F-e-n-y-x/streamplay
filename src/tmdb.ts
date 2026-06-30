import axios from 'axios';
import { SearchResult, MetaData, Episode, Season } from './types';

const TMDB_API_URL = 'https://api.themoviedb.org/3';
const API_KEY = process.env.TMDB_API_KEY || 'dummy_key'; // Ideally this should be a valid API key

const axiosInstance = axios.create({
    baseURL: TMDB_API_URL,
    params: {
        api_key: API_KEY
    }
});

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

export const searchTMDB = async (query: string): Promise<SearchResult[]> => {
    try {
        const response = await axiosInstance.get('/search/multi', {
            params: {
                query,
                language: 'en-US',
                include_adult: false
            }
        });

        const results = response.data.results;
        return results
            .filter((item: any) => item.media_type === 'movie' || item.media_type === 'tv')
            .map((item: any) => ({
                id: item.id,
                title: item.title || item.name,
                originalTitle: item.original_title || item.original_name,
                type: item.media_type,
                posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : undefined,
                year: item.release_date ? parseInt(item.release_date.split('-')[0]) : (item.first_air_date ? parseInt(item.first_air_date.split('-')[0]) : undefined),
                rating: item.vote_average
            }));
    } catch (error) {
        console.error('Error searching TMDB:', error);
        return [];
    }
};

export const getTMDBInfo = async (id: number, type: 'movie' | 'tv'): Promise<MetaData | null> => {
    try {
        const response = await axiosInstance.get(`/${type}/${id}`, {
            params: {
                append_to_response: 'alternative_titles,credits,external_ids,videos,recommendations,images'
            }
        });

        const data = response.data;
        const genres = data.genres?.map((g: any) => g.name) || [];
        const isAnime = genres.includes('Animation') && (data.original_language === 'ja' || data.original_language === 'zh');
        const isAsian = !isAnime && (data.original_language === 'ko' || data.original_language === 'zh');
        const isBollywood = data.production_countries?.some((c: any) => c.name === 'India') || false;

        let seasons: Season[] = [];
        let episodes: Episode[] = [];

        if (type === 'tv' && data.seasons) {
            seasons = data.seasons.map((s: any) => ({
                seasonNumber: s.season_number,
                name: s.name,
                episodeCount: s.episode_count,
                airDate: s.air_date
            }));
            
            // We fetch the latest season's episodes or all seasons if needed. 
            // For now, we will leave fetching individual episodes per season to a separate function or if explicitly requested.
            // But let's fetch season 1 as default to populate episodes.
            try {
                if (seasons.length > 0) {
                    const firstSeason = seasons.find(s => s.seasonNumber === 1) || seasons[0];
                    const seasonRes = await axiosInstance.get(`/tv/${id}/season/${firstSeason.seasonNumber}`);
                    episodes = seasonRes.data.episodes.map((e: any) => ({
                        seasonNumber: e.season_number,
                        episodeNumber: e.episode_number,
                        title: e.name,
                        description: e.overview,
                        airDate: e.air_date,
                        stillUrl: e.still_path ? `https://image.tmdb.org/t/p/w500${e.still_path}` : undefined
                    }));
                }
            } catch(e) {
                console.error("Could not fetch season details", e);
            }
        }

        return {
            id: data.id,
            title: data.title || data.name,
            originalTitle: data.original_title || data.original_name,
            type,
            year: data.release_date ? parseInt(data.release_date.split('-')[0]) : (data.first_air_date ? parseInt(data.first_air_date.split('-')[0]) : undefined),
            originalLanguage: data.original_language,
            posterUrl: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : undefined,
            backgroundUrl: data.backdrop_path ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}` : undefined,
            description: data.overview,
            imdbId: data.external_ids?.imdb_id,
            rating: data.vote_average,
            genres,
            isAnime,
            isAsian,
            isBollywood,
            seasons,
            episodes
        };
    } catch (error) {
        console.error('Error fetching TMDB Info:', error);
        return null;
    }
};

export const getTMDBSeasonEpisodes = async (id: number, seasonNumber: number): Promise<Episode[]> => {
    try {
        const response = await axiosInstance.get(`/tv/${id}/season/${seasonNumber}`);
        return response.data.episodes.map((e: any) => ({
            seasonNumber: e.season_number,
            episodeNumber: e.episode_number,
            title: e.name,
            description: e.overview,
            airDate: e.air_date,
            stillUrl: e.still_path ? `https://image.tmdb.org/t/p/w500${e.still_path}` : undefined
        }));
    } catch (error) {
        console.error(`Error fetching episodes for season ${seasonNumber}:`, error);
        return [];
    }
}
