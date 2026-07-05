import axios from 'axios';
import { getTorznab } from './serverConfig';

/**
 * Torrent indexers for the torrent-mode providers (movies / TV / anime).
 *
 * Each returns normalised releases with a magnet + seeder count. WebTorrent needs
 * live seeders, so callers sort by seeders and drop dead swarms. Anime keeps using
 * AnimeTosho (see extractors/torrent.ts); this covers the rest:
 *   - YTS      — movies, excellent well-seeded 720p/1080p/2160p (query by IMDb id)
 *   - EZTV     — TV episodes (query by IMDb id; carries season/episode fields)
 *   - apibay   — The Pirate Bay JSON API, movies + TV, broad catalogue
 */

export interface TRelease {
    title: string;
    magnet: string;
    size: number;
    seeders: number;
    files: number;
    season?: number;
    episode?: number;
    /** Direct HTTP link when the torrent is already CACHED on the configured debrid
     *  service (RealDebrid/AllDebrid/…). Streams instantly with no P2P — far more
     *  reliable than waiting on a swarm. Set only when a debrid key is configured. */
    url?: string;
    cached?: boolean;
}

// A fresh, broad tracker set (opentrackr/demonii/eu.org/… — the ngosang "best" list).
// Peer discovery is the #1 reliability lever for P2P streaming: more live trackers =
// more peers = faster metadata + fewer stalls. Baked into every magnet we build.
export const TRACKERS = [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://open.demonii.com:1337/announce',
    'udp://open.stealth.si:80/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://exodus.desync.com:6969/announce',
    'udp://tracker.openbittorrent.com:6969/announce',
    'udp://open.tracker.cl:1337/announce',
    'udp://tracker.dler.org:6969/announce',
    'udp://explodie.org:6969/announce',
    'udp://tracker1.bt.moack.co.kr:80/announce',
    'udp://tracker.tiny-vps.com:6969/announce',
    'udp://p4p.arenabg.com:1337/announce',
    'udp://tracker.internetwarriors.net:1337/announce',
    'udp://tracker.moeking.me:6969/announce',
    'https://tracker.tamersunion.org:443/announce',
];
export const magnetFromHash = (hash: string, name?: string): string =>
    `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(name || '')}${TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;

/**
 * Debrid config for Torrentio. When any of these env keys is set, Torrentio resolves
 * torrents through the debrid service and returns DIRECT cached HTTP links (instant,
 * no buffering) instead of magnets — the standard way reliable torrent-streamers work.
 * Returns Torrentio's URL config segment (e.g. `realdebrid=KEY`), or '' if none set.
 */
export const debridConfig = (): string => {
    const map: Array<[string, string]> = [
        ['REALDEBRID_KEY', 'realdebrid'], ['ALLDEBRID_KEY', 'alldebrid'], ['TORBOX_KEY', 'torbox'],
        ['PREMIUMIZE_KEY', 'premiumize'], ['DEBRIDLINK_KEY', 'debridlink'], ['OFFCLOUD_KEY', 'offcloud'],
    ];
    for (const [env, provider] of map) {
        const k = process.env[env];
        if (k) return `${provider}=${k}`;
    }
    return '';
};
export const debridEnabled = (): boolean => !!debridConfig();

/** YTS — movies only. `imdbId` (ttXXXXXXX) gives the most precise match. */
export async function searchYTS(imdbId?: string, title?: string): Promise<TRelease[]> {
    const term = imdbId || title;
    if (!term) return [];
    try {
        const { data } = await axios.get('https://yts.mx/api/v2/list_movies.json', { params: { query_term: term, limit: 6 }, timeout: 12000 });
        const movies: any[] = data?.data?.movies || [];
        const out: TRelease[] = [];
        for (const m of movies) {
            for (const t of (m.torrents || [])) {
                out.push({
                    title: `${m.title_long} [${t.quality}] [${t.type}] YTS`,
                    magnet: magnetFromHash(t.hash, m.title_long),
                    size: Number(t.size_bytes) || 0,
                    seeders: Number(t.seeds) || 0,
                    files: 1,
                });
            }
        }
        return out;
    } catch { return []; }
}

/** The Pirate Bay JSON API. `cats` e.g. "201,207" (movies) or "205,208" (TV). */
export async function searchApibay(query: string, cats: string): Promise<TRelease[]> {
    if (!query.trim()) return [];
    try {
        const { data } = await axios.get('https://apibay.org/q.php', { params: { q: query, cat: cats }, timeout: 12000 });
        const arr: any[] = Array.isArray(data) ? data : [];
        return arr
            .filter((r) => r.info_hash && !/^0+$/.test(r.info_hash) && r.name && !/^no results/i.test(r.name))
            .map((r) => ({
                title: String(r.name),
                magnet: magnetFromHash(r.info_hash, r.name),
                size: Number(r.size) || 0,
                seeders: Number(r.seeders) || 0,
                files: Number(r.num_files) || 1,
            }));
    } catch { return []; }
}

const SIZE_UNITS: Record<string, number> = { b: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12 };
const parseSize = (s: string): number => {
    const m = /([\d.]+)\s*(b|[kmgt]i?b)/i.exec(s || '');
    return m ? Math.round(parseFloat(m[1]) * (SIZE_UNITS[m[2].toLowerCase()] || 1)) : 0;
};

/**
 * Nyaa (nyaa.si) — THE anime torrent tracker, via its RSS feed. AnimeTosho mirrors
 * Nyaa but querying it directly catches fresher/edge releases and gives independent
 * seeder counts. `c=1_2` = English-translated anime. Parsed with regex (namespaced
 * RSS tags like <nyaa:infoHash> are a pain for XML parsers).
 */
export async function searchNyaa(query: string): Promise<TRelease[]> {
    if (!query.trim()) return [];
    try {
        const { data } = await axios.get('https://nyaa.si/', {
            params: { page: 'rss', q: query, c: '1_2', f: 0 },
            timeout: 12000, responseType: 'text', transformResponse: (r) => r,
        });
        const out: TRelease[] = [];
        for (const it of String(data).split('<item>').slice(1)) {
            const title = (it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i) || [])[1]?.trim();
            const hash = (it.match(/<nyaa:infoHash>([^<]*)<\/nyaa:infoHash>/i) || [])[1]?.trim();
            if (!title || !hash) continue;
            out.push({
                title,
                magnet: magnetFromHash(hash, title),
                size: parseSize((it.match(/<nyaa:size>([^<]*)<\/nyaa:size>/i) || [])[1] || ''),
                seeders: Number((it.match(/<nyaa:seeders>([^<]*)<\/nyaa:seeders>/i) || [])[1]) || 0,
                files: 1,
            });
        }
        return out;
    } catch { return []; }
}

/**
 * Torznab meta-indexer (Jackett / Prowlarr) — the way the *arr stack and Stremio's
 * Jackettio get broad, reliable torrent coverage: one query fans out across every
 * indexer the user has configured (100s of public + private trackers). Env-gated:
 *   TORZNAB_URL + TORZNAB_API_KEY   (generic Torznab feed), or
 *   JACKETT_URL + JACKETT_API_KEY   (Jackett — we build the all-indexers endpoint), or
 *   PROWLARR_URL + PROWLARR_API_KEY (Prowlarr aggregate feed).
 * Newznab cats: movies=2000, tv=5000, anime=5070.
 */
const xmlText = (s: string): string => (s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'");
export async function searchTorznab(query: string, cat: string): Promise<TRelease[]> {
    const { url: base, apiKey: key } = getTorznab();   // UI config → env fallback
    if (!base || !key || !query.trim()) return [];
    // A bare Jackett base URL → its all-indexers Torznab endpoint; otherwise use as-is.
    const endpoint = /torznab|\/api\b/i.test(base) ? base : `${base.replace(/\/$/, '')}/api/v2.0/indexers/all/results/torznab/api`;
    try {
        const { data } = await axios.get(endpoint, {
            params: { apikey: key, t: 'search', q: query, cat }, timeout: 15000,
            responseType: 'text', transformResponse: (r) => r,
        });
        const out: TRelease[] = [];
        for (const it of String(data).split('<item>').slice(1)) {
            const title = xmlText((it.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
            if (!title) continue;
            const attr = (n: string) => (it.match(new RegExp(`name="${n}"\\s+value="([^"]*)"`, 'i')) || [])[1];
            const enclosure = (it.match(/<enclosure[^>]+url="([^"]+)"/i) || [])[1] || '';
            let magnet = attr('magneturl') || (/^magnet:/i.test(enclosure) ? xmlText(enclosure) : '');
            const hash = attr('infohash');
            if (!magnet && hash) magnet = magnetFromHash(hash, title);
            if (!magnet || !/^magnet:/i.test(magnet)) continue;   // skip .torrent-file-only results (can't stream directly)
            out.push({
                title, magnet,
                size: Number(attr('size') || (it.match(/<size>(\d+)<\/size>/i) || [])[1]) || 0,
                seeders: Number(attr('seeders')) || 0, files: Number(attr('files')) || 1,
            });
        }
        return out;
    } catch { return []; }
}
export const torznabEnabled = (): boolean => { const t = getTorznab(); return !!(t.url && t.apiKey); };

/** EZTV — TV episodes by IMDb id (digits only). Carries season/episode fields. */
export async function searchEztv(imdbId?: string): Promise<TRelease[]> {
    const imdb = (imdbId || '').replace(/^tt/i, '');
    if (!imdb) return [];
    try {
        const { data } = await axios.get('https://eztvx.to/api/get-torrents', { params: { imdb_id: imdb, limit: 100 }, timeout: 12000 });
        const torr: any[] = data?.torrents || [];
        return torr.map((t) => ({
            title: String(t.title || ''),
            magnet: String(t.magnet_url || ''),
            size: Number(t.size_bytes) || 0,
            seeders: Number(t.seeds) || 0,
            files: 1,
            season: Number(t.season) || undefined,
            episode: Number(t.episode) || undefined,
        })).filter((r) => r.magnet);
    } catch { return []; }
}

/**
 * Torrentio — a free public aggregator (Stremio addon) that scrapes MANY trackers at
 * once (YTS, EZTV, RARBG mirrors, 1337x, ThePirateBay, KickassTorrents…) and returns
 * them keyed by IMDb id, with seeder counts. One call ≈ a dozen indexers. Movies use
 * `movie/<imdb>`, TV uses `series/<imdb>:<season>:<episode>`.
 */
export async function searchTorrentio(kind: 'movie' | 'series', imdbId?: string, season?: number, episode?: number): Promise<TRelease[]> {
    if (!imdbId) return [];
    const id = kind === 'series' ? `${imdbId}:${season || 1}:${episode || 1}` : imdbId;
    // With a debrid key, Torrentio returns DIRECT cached http `url`s (instant playback);
    // without one it returns `infoHash`es we stream over P2P.
    const cfg = debridConfig();
    const base = cfg ? `https://torrentio.strem.fun/${cfg}/stream` : 'https://torrentio.strem.fun/stream';
    try {
        const { data } = await axios.get(`${base}/${kind}/${id}.json`, { timeout: 15000 });
        const streams: any[] = data?.streams || [];
        const out: TRelease[] = [];
        for (const s of streams) {
            const full = String(s.title || '');
            const name = full.split('\n')[0] || s.name || 'Torrent';     // first line = release name (has quality/codec)
            const seeders = Number((full.match(/👤\s*(\d+)/) || [])[1]) || 0;
            if (s.url) {
                // Debrid-resolved direct link (cached on the debrid service → reliable).
                out.push({ title: name, magnet: '', url: String(s.url), cached: true, size: 0, seeders: seeders || 999, files: 1 });
            } else if (s.infoHash) {
                out.push({ title: name, magnet: magnetFromHash(s.infoHash, name), size: 0, seeders, files: 1 });
            }
        }
        return out;
    } catch { return []; }
}

const p2 = (n: number) => String(n).padStart(2, '0');
export const sxe = (s: number, e: number) => `S${p2(s)}E${p2(e)}`;
export const qualityOf = (t: string): string | undefined => (t.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1];

/**
 * Alternate spellings of a title to search — so a torrent named slightly differently
 * from TMDB still turns up. Covers the original-language title, a subtitle-stripped
 * form, &↔and, and dropped apostrophes/periods (the common release-naming mistakes).
 */
export function titleVariants(title: string, orgTitle?: string): string[] {
    const out: string[] = [];
    const add = (t?: string) => {
        const s = (t || '').replace(/\s+/g, ' ').trim();
        if (s && s.length >= 2 && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
    };
    add(title);
    add(orgTitle);
    // drop a subtitle after a colon or a SPACED dash — but not an intra-word hyphen
    // ("Spider-Man" must stay "Spider-Man", not become "Spider").
    add(title.replace(/(\s*[:–—]|\s+-)\s*.*$/, ''));
    add(title.replace(/\band\b/gi, '&'));
    add(title.replace(/&/g, 'and'));
    add(title.replace(/['’.!?,]/g, ''));         // drop punctuation that release names omit
    return out.slice(0, 4);
}

/** Normalised token overlap 0..1 — a tolerant title check for fuzzy/typo'd names. */
export function titleSimilarity(a: string, b: string): number {
    const tok = (s: string) => (s.toLowerCase().match(/[a-z0-9]{2,}/g) || []).filter((w) => !/^(the|a|an|of|and|to|in|season|part)$/.test(w));
    const ta = tok(a), tb = new Set(tok(b));
    if (!ta.length) return 0;
    return ta.filter((t) => tb.has(t)).length / ta.length;
}

/** Score a video release: quality + browser-friendly codec + seeders; avoid cams. */
export function scoreVideo(r: TRelease, year?: number): number {
    const t = r.title;
    let s = 0;
    if (r.cached) s += 10;                                   // debrid-cached = instant + reliable → rank first
    if (/\b1080p\b/i.test(t)) s += 4; else if (/\b720p\b/i.test(t)) s += 2; else if (/\b(2160p|4k)\b/i.test(t)) s += 2; else s += 1;
    if (/\b(x264|h\.?264|avc)\b/i.test(t)) s += 2;           // cheap remux (no transcode)
    if (/\b(cam|hdcam|ts|telesync|hdts|scr)\b/i.test(t)) s -= 8;  // drop cams/screeners
    s += Math.min(4, Math.log10((r.seeders || 0) + 1) * 2);  // well-seeded = streamable
    if (year && new RegExp(`\\b${year}\\b`).test(t)) s += 1;
    return s;
}

/** Short human label for a release: "1080p WEB-DL RARBG". */
export function shortLabel(title: string): string {
    const q = qualityOf(title) || '';
    const src = (title.match(/\b(WEB[-\s.]?DL|WEBRip|BluRay|BRRip|HDRip|HDTV|DVDRip|REMUX)\b/i) || [])[1] || '';
    const group = (title.match(/[-\s]([A-Za-z0-9]+)$/) || [])[1] || '';
    return [q, src, group].filter(Boolean).join(' ') || 'Torrent';
}
