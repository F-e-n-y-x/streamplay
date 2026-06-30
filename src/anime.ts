import axios from 'axios';
import { AnimeIds } from './types';

export const resolveAnimeIds = async (tmdbId: number, type: 'movie' | 'tv', title?: string, date?: string): Promise<AnimeIds> => {
    try {
        let malId: number | undefined;
        let anilistId: number | undefined;

        // Using AniZip to get mapping
        try {
            // we use the tmdb_id directly with malsync or anizip
            // AniZip expects ?tmdb_id= for tv shows or movie
            const aniZipUrl = type === 'tv' 
                ? `https://api.ani.zip/mappings?tmdb_id=${tmdbId}`
                : `https://api.ani.zip/mappings?tmdb_id=${tmdbId}`; // AniZip might not fully support tmdb movie ids directly, but let's try
            
            const aniZipRes = await axios.get(aniZipUrl);
            malId = aniZipRes.data?.mappings?.mal_id;
            anilistId = aniZipRes.data?.mappings?.anilist_id;
        } catch (e) {
            console.log('AniZip mapping failed for tmdbId:', tmdbId);
        }

        let zoroIds: string[] | undefined;
        let kaasSlug: string | undefined;
        let animepaheUrl: string | undefined;

        if (malId) {
            try {
                const malSyncRes = await axios.get(`https://api.malsync.moe/mal/anime/${malId}`);
                const sites = malSyncRes.data?.sites;
                if (sites) {
                    if (sites.Zoro) {
                        zoroIds = Object.keys(sites.Zoro);
                    }
                    if (sites.KickAssAnime) {
                        const vals = Object.values(sites.KickAssAnime) as any[];
                        kaasSlug = vals[0]?.identifier;
                    }
                    if (sites.animepahe) {
                        const vals = Object.values(sites.animepahe) as any[];
                        animepaheUrl = vals[0]?.url;
                    }
                }
            } catch (e) {
                console.log('MalSync mapping failed for malId:', malId);
            }
        }

        return {
            malId,
            anilistId,
            zoroIds,
            kaasSlug,
            animepaheUrl
        };

    } catch (error) {
        console.error('Error resolving Anime IDs:', error);
        return {};
    }
};
