import { app } from './http';

/**
 * Dynamic domain resolver, ported from StreamPlay.getDomains().
 *
 * The scraping sites rotate domains constantly, so the plugin reads the current
 * list from a hosted JSON instead of hard-coding them. We cache it in-process.
 */

const DOMAINS_URL = 'https://raw.githubusercontent.com/phisher98/TVVVV/refs/heads/main/domains.json';

// Maps our camelCase accessor -> the JSON key used in domains.json
const KEY_MAP: Record<string, string> = {
    moviesdrive: 'moviesdrive',
    hdhub4u: 'HDHUB4u',
    n4khdhub: '4khdhub',
    multiMovies: 'MultiMovies',
    bollyflix: 'bollyflix',
    uhdmovies: 'UHDMovies',
    moviesmod: 'moviesmod',
    topMovies: 'topMovies',
    hdmovie2: 'hdmovie2',
    vegamovies: 'vegamovies',
    rogmovies: 'rogmovies',
    luxmovies: 'luxmovies',
    movierulzhd: 'movierulzhd',
    extramovies: 'extramovies',
    filmyfiy: 'filmyfiy',
    hindmoviez: 'hindmoviez',
    hubcloud: 'hubcloud',
    movies4u: 'movies4u',
    cinevood: 'cinevood',
    dudefilms: 'dudefilms',
    m4ufree: 'm4ufree',
    zinkmovies: 'zinkmovies',
};

export type DomainKey = keyof typeof KEY_MAP;

let cached: Record<string, string> | null = null;

export const getDomains = async (forceRefresh = false): Promise<Record<string, string> | null> => {
    if (cached && !forceRefresh) return cached;
    try {
        const res = await app.get(DOMAINS_URL, { timeout: 15000 });
        cached = res.json<Record<string, string>>();
    } catch (e: any) {
        console.error('[getDomains] failed:', e?.message || e);
    }
    return cached;
};

/** Resolve a single provider domain by its camelCase accessor name. */
export const getDomain = async (key: DomainKey): Promise<string | undefined> => {
    const domains = await getDomains();
    return domains?.[KEY_MAP[key]];
};
