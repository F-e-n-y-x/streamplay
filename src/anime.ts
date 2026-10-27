import net from './utils/net';
import { AnimeIds, LinkData } from './types';

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
      id idMal seasonYear format synonyms
      title { romaji english native }
    }
  }
}`;

interface AniHit { id: number; idMal?: number; seasonYear?: number; format?: string; title?: { romaji?: string; english?: string; native?: string }; synonyms?: string[] }

/** Ordered, de-duplicated alt titles from an AniList hit (romaji/english/native + synonyms). */
const titlesOf = (hit: AniHit): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [hit.title?.romaji, hit.title?.english, hit.title?.native, ...(hit.synonyms || [])]) {
        const s = (t || '').trim();
        const k = s.toLowerCase();
        // Skip pure-ASCII-less duplicates and empties; keep native (JP) too — some
        // sites (AniZone via orgTitle) match on it.
        if (s && !seen.has(k)) { seen.add(k); out.push(s); }
    }
    return out;
};

// Cache resolved ids per TMDB title. AniList (~90 req/min) and MALSync throttle
// hard, and the SSE route resolves the same title on every /sources request, so
// without this a rewatch or a quick retry can rate-limit the whole anime chain.
const idCache = new Map<string, AnimeIds>();
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6h
const cacheAt = new Map<string, number>();

async function anilistSearch(title: string, isMovie: boolean, year?: number): Promise<AniHit | null> {
    try {
        const variables = {
            search: title,
            type: 'ANIME',
            format: isMovie ? ['MOVIE'] : ['TV', 'ONA', 'OVA', 'TV_SHORT'],
        };
        const res = await net.post(ANILIST, { query: SEARCH_QUERY, variables },
            { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 12000 });
        const media: AniHit[] = res.data?.data?.Page?.media ?? [];
        if (!media.length) return null;
        // Prefer an exact season-year match when we know the year — and among those the
        // main TV/MOVIE entry: a same-year ONA/TV_SHORT spin-off (Frieren's "Mini Anime")
        // can out-rank it in SEARCH_MATCH and hand every id-keyed provider the wrong show.
        const main = (m: AniHit) => m.format === 'TV' || m.format === 'MOVIE';
        if (year) { const y = media.filter((m) => m.seasonYear === year); if (y.length) return y.find(main) || y[0]; }
        return media.find(main) || media[0];
    } catch { return null; }
}

export const resolveAnimeIds = async (tmdbId: number, type: 'movie' | 'tv', title?: string, date?: string, orgTitle?: string): Promise<AnimeIds> => {
    const cacheKey = `${type}:${tmdbId}`;
    const cachedTs = cacheAt.get(cacheKey);
    if (cachedTs && Date.now() - cachedTs < CACHE_TTL) {
        const hit = idCache.get(cacheKey);
        if (hit) return hit;
    }

    const year = date ? parseInt(String(date).slice(0, 4)) || undefined : undefined;
    const isMovie = type === 'movie';

    let anilistId: number | undefined;
    let malId: number | undefined;
    let titles: string[] | undefined;

    // 1) TMDB → AniList. Try several forms of the name: the full TMDB English title
    //    ("Haganai: I Don't Have Many Friends") frequently returns 0 on AniList, while
    //    a colon-trimmed form ("Haganai") or the original/Japanese title match and give
    //    us the romaji ("Boku wa Tomodachi ga Sukunai") the anime sites index by.
    const candidates: string[] = [];
    const addCand = (s?: string) => { const t = (s || '').trim(); if (t && !candidates.some((c) => c.toLowerCase() === t.toLowerCase())) candidates.push(t); };
    addCand(title);
    addCand(title?.split(/[:\-–—(]/)[0]);
    addCand(orgTitle);
    let hit: AniHit | null = null;
    for (const q of candidates) { hit = await anilistSearch(q, isMovie, year); if (hit) break; }
    if (hit) { anilistId = hit.id; malId = hit.idMal ?? undefined; titles = titlesOf(hit); }

    // 2) Backfill MAL id via ani.zip (which *does* accept anilist_id) if needed.
    if (anilistId && !malId) {
        try {
            const r = await net.get(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, { timeout: 10000 });
            malId = r.data?.mappings?.mal_id ?? undefined;
        } catch { /* ignore */ }
    }

    // 3) MALSync → per-provider slugs. Note the API key is `Sites` (capital S).
    let zoroIds: string[] | undefined;
    let kaasSlug: string | undefined;
    let animepaheUrl: string | undefined;
    if (malId) {
        try {
            const r = await net.get(`${MALSYNC}/mal/anime/${malId}`, { timeout: 10000 });
            const sites = r.data?.Sites ?? r.data?.sites;
            if (sites) {
                if (sites.Zoro) zoroIds = Object.keys(sites.Zoro);
                if (sites.KickAssAnime) kaasSlug = (Object.values(sites.KickAssAnime)[0] as any)?.identifier;
                if (sites.animepahe) animepaheUrl = (Object.values(sites.animepahe)[0] as any)?.url;
            }
        } catch { /* ignore */ }
    }

    const ids: AnimeIds = { malId, anilistId, zoroIds, kaasSlug, animepaheUrl, titles };
    // Only cache a resolved hit; a miss (all-undefined) should be retried next time
    // in case AniList/MALSync were transiently down.
    if (anilistId || malId) { idCache.set(cacheKey, ids); cacheAt.set(cacheKey, Date.now()); }
    return ids;
};

/**
 * Ordered, de-duplicated list of titles an anime provider should try when searching:
 * TMDB's title/original, PLUS the AniList romaji/english/native/synonyms. This is the
 * fix for "the anime exists on the site but the provider finds nothing" — TMDB's
 * English name (e.g. "Haganai: I Don't Have Many Friends") rarely matches a site that
 * indexes by romaji ("Boku wa Tomodachi ga Sukunai") or a short title ("Haganai").
 */
export const animeSearchTitles = (data: LinkData): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [data.title, data.orgTitle, data.jpTitle, ...(data.animeIds?.titles || [])]) {
        const s = (t || '').trim();
        const k = s.toLowerCase();
        if (s && !seen.has(k)) { seen.add(k); out.push(s); }
    }
    return out;
};

/**
 * AniList id + episode for the id-keyed anime APIs (Anikage, Just4Anime, Animekizz).
 * null when the id can't be trusted for this season: on a TMDB plan, S2+ still carries
 * the show's S1 AniList id, so asking for "episode N" there would land on the wrong cour.
 * (AniList-plan cours are fine — buildLinkData swaps in that cour's id + seasonResolved.)
 */
export const anilistEpisode = (data: LinkData): { id: number; ep: number } | null => {
    const id = data.animeIds?.anilistId;
    if (!data.isAnime || !id) return null;
    if (data.type === 'tv' && (data.season ?? 1) > 1 && !data.seasonResolved) return null;
    return { id, ep: data.type === 'movie' ? 1 : data.episode ?? 1 };
};
