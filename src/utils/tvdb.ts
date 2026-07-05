import net from './net';

/**
 * TheTVDB v4 client — a better episode/season source than TMDB for CARTOONS
 * (Ben 10 etc., where production/DVD order differs from aired order) and for
 * Indian / international series (far deeper coverage than TMDB).
 *
 * Enabled only when TVDB_API_KEY is set. Auth = POST /login with the API key
 * (+ optional subscriber PIN) → a bearer token valid ~1 month, cached in memory.
 *
 * Docs: https://thetvdb.github.io/v4-api/
 */

const BASE = 'https://api4.thetvdb.com/v4';
const API_KEY = process.env.TVDB_API_KEY || '';
const PIN = process.env.TVDB_PIN || '';            // only for the user-supported (free) model

export const tvdbEnabled = (): boolean => !!API_KEY;

// TVDB "season types" — which ordering to read episodes in. Cartoons like Ben 10
// live under 'official' (production) or 'dvd'; most shows use 'default' (aired).
export type TvdbOrder = 'default' | 'official' | 'dvd' | 'absolute' | 'alternate' | 'regional';

let token: string | null = null;
let tokenAt = 0;
const TOKEN_TTL = 24 * 24 * 60 * 60 * 1000;         // refresh well within TVDB's ~1-month validity

async function getToken(): Promise<string> {
    if (token && Date.now() - tokenAt < TOKEN_TTL) return token;
    const body: Record<string, string> = { apikey: API_KEY };
    if (PIN) body.pin = PIN;
    const { data } = await net.post(`${BASE}/login`, body, { timeout: 15000 });
    const t = data?.data?.token;
    if (!t) throw new Error('TVDB login returned no token');
    token = t; tokenAt = Date.now();
    return t;
}

async function tvdbGet(path: string, params: Record<string, any> = {}): Promise<any> {
    const t = await getToken();
    const { data } = await net.get(`${BASE}${path}`, {
        params,
        headers: { Authorization: `Bearer ${t}` },
        timeout: 15000,
    });
    return data?.data;
}

export interface TvdbEpisode {
    seasonNumber: number;
    episodeNumber: number;
    absoluteNumber?: number;
    name?: string;
    overview?: string;
    aired?: string;
    runtime?: number;
    still?: string;
}

const IMG = (p?: string): string | undefined => (p ? (/^https?:/i.test(p) ? p : `https://artworks.thetvdb.com${p}`) : undefined);

/** Find a TVDB series id by title (optionally disambiguated by first-air year). */
export async function tvdbFindSeries(title: string, year?: number): Promise<number | null> {
    try {
        const res: any[] = (await tvdbGet('/search', { query: title, type: 'series', limit: 8 })) || [];
        if (!res.length) return null;
        const byYear = year ? res.find((r) => String(r.year) === String(year)) : undefined;
        const hit = byYear || res[0];
        const id = hit?.tvdb_id || hit?.id;
        return id ? Number(String(id).replace(/^series-/, '')) : null;
    } catch { return null; }
}

/** Resolve a TVDB series id from an external id (IMDb / TMDB) via /search/remoteid. */
export async function tvdbFromRemoteId(remoteId: string): Promise<number | null> {
    try {
        const res: any[] = (await tvdbGet(`/search/remoteid/${encodeURIComponent(remoteId)}`)) || [];
        const series = res.map((r) => r.series).find(Boolean);
        return series?.id ? Number(series.id) : null;
    } catch { return null; }
}

/**
 * Full episode list for a series in the requested order (paginated). Returns them
 * normalised to our episode shape, sorted by season then episode.
 */
export async function tvdbEpisodes(seriesId: number, order: TvdbOrder = 'default', lang = 'eng'): Promise<TvdbEpisode[]> {
    const out: TvdbEpisode[] = [];
    for (let page = 0; page < 20; page++) {
        const data = await tvdbGet(`/series/${seriesId}/episodes/${order}/${lang}`, { page });
        const eps: any[] = data?.episodes || [];
        for (const e of eps) {
            out.push({
                seasonNumber: e.seasonNumber ?? 0,
                episodeNumber: e.number ?? 0,
                absoluteNumber: e.absoluteNumber || undefined,
                name: e.name || undefined,
                overview: e.overview || undefined,
                aired: e.aired || undefined,
                runtime: e.runtime || undefined,
                still: IMG(e.image),
            });
        }
        if (eps.length < 500) break;   // last page
    }
    return out.sort((a, b) => a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber);
}

/** Season list (numbers + episode counts) derived from the episode list for an order. */
export async function tvdbSeasons(seriesId: number, order: TvdbOrder = 'default'): Promise<{ seasonNumber: number; episodeCount: number }[]> {
    const eps = await tvdbEpisodes(seriesId, order);
    const counts = new Map<number, number>();
    for (const e of eps) counts.set(e.seasonNumber, (counts.get(e.seasonNumber) || 0) + 1);
    return [...counts.entries()]
        .filter(([s]) => s >= 1)                 // drop specials (season 0)
        .sort((a, b) => a[0] - b[0])
        .map(([seasonNumber, episodeCount]) => ({ seasonNumber, episodeCount }));
}
