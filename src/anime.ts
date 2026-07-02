import axios from 'axios';
import { AnimeIds } from './types';

/**
 * Resolve a TMDB movie/show to anime provider IDs.
 *
 * TMDB has no anime IDs, and api.ani.zip does NOT accept `?tmdb_id=`, so we map
 * by title through **AniList** (GraphQL search → id + idMal), then use **MALSync**
 * to get the per-site slugs (AnimePahe / Zoro / KickAssAnime). This is what the
 * dedicated anime providers consume.
 */

const ANILIST = 'https://graphql.anilist.co';
const MALSYNC = 'https://api.malsync.moe';

const SEARCH_QUERY = `
query ($search: String, $type: MediaType, $format: [MediaFormat]) {
  Page(page: 1, perPage: 10) {
    media(search: $search, type: $type, format_in: $format, sort: SEARCH_MATCH) {
      id idMal seasonYear format
      title { romaji english }
    }
  }
}`;

interface AniHit { id: number; idMal?: number; seasonYear?: number }

async function anilistSearch(title: string, isMovie: boolean, year?: number): Promise<AniHit | null> {
    try {
        const variables = {
            search: title,
            type: 'ANIME',
            format: isMovie ? ['MOVIE'] : ['TV', 'ONA', 'OVA', 'TV_SHORT'],
        };
        const res = await axios.post(ANILIST, { query: SEARCH_QUERY, variables },
            { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 12000 });
        const media: AniHit[] = res.data?.data?.Page?.media ?? [];
        if (!media.length) return null;
        // Prefer an exact season-year match when we know the year.
        if (year) { const y = media.find((m) => m.seasonYear === year); if (y) return y; }
        return media[0];
    } catch { return null; }
}

export const resolveAnimeIds = async (tmdbId: number, type: 'movie' | 'tv', title?: string, date?: string): Promise<AnimeIds> => {
    const year = date ? parseInt(String(date).slice(0, 4)) || undefined : undefined;
    const isMovie = type === 'movie';

    let anilistId: number | undefined;
    let malId: number | undefined;

    // 1) TMDB → AniList by title (with a year hint for disambiguation).
    const hit = title ? await anilistSearch(title, isMovie, year) : null;
    if (hit) { anilistId = hit.id; malId = hit.idMal ?? undefined; }

    // 2) Backfill MAL id via ani.zip (which *does* accept anilist_id) if needed.
    if (anilistId && !malId) {
        try {
            const r = await axios.get(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, { timeout: 10000 });
            malId = r.data?.mappings?.mal_id ?? undefined;
        } catch { /* ignore */ }
    }

    // 3) MALSync → per-provider slugs. Note the API key is `Sites` (capital S).
    let zoroIds: string[] | undefined;
    let kaasSlug: string | undefined;
    let animepaheUrl: string | undefined;
    if (malId) {
        try {
            const r = await axios.get(`${MALSYNC}/mal/anime/${malId}`, { timeout: 10000 });
            const sites = r.data?.Sites ?? r.data?.sites;
            if (sites) {
                if (sites.Zoro) zoroIds = Object.keys(sites.Zoro);
                if (sites.KickAssAnime) kaasSlug = (Object.values(sites.KickAssAnime)[0] as any)?.identifier;
                if (sites.animepahe) animepaheUrl = (Object.values(sites.animepahe)[0] as any)?.url;
            }
        } catch { /* ignore */ }
    }

    return { malId, anilistId, zoroIds, kaasSlug, animepaheUrl };
};
