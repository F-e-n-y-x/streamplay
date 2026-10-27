import { Router } from 'express';
import { createHash } from 'node:crypto';
import axios from 'axios';
import { tmdbGet, tmdbImg, tmdbIsLive, getTMDBInfo, classify } from '../tmdb';
import { getProviders, getProvidersForKind, torrentProviders } from '../extractors';
import { providerDomains } from '../providersList';
import { resolveAnimeIds } from '../anime';
import { anilistBrowse, anilistTitleVariants, rangeStart } from '../anilist';
import { seasonPlan, planEpisodes, planToAired, TMDB_PLAN, MetaInput, SeasonPlan } from '../meta';
import { LinkData, Stream, ContentKind, MetaData, Provider } from '../types';
import { b64 } from './proxy';
import { runWithWarp, normalizeWarpMode, warpConfigured, warpConfig, probeWarpSocks, WarpMode } from '../utils/warp';
import { runWithSignal } from '../utils/reqctx';
import { flareSolverrEndpoints, probeFlareSolverr, flareSolverrLoad } from '../utils/flaresolverr';
import { recordProvider, providerShouldRun, providerStat, providerPriority, recordPlayback, recordVerify, providerHidden, providerReliability } from '../utils/providerStats';
import { probeStream, scoreSource, detectAudio, parseReport, webReadyOf, mbpsOf, ScorePrefs, GOOD_SCORE, audioTracks, failReason, FailReason } from '../utils/sourceProbe';
import { rateLimit } from './sync';
import { torznabPublic, setTorznab, addonPublic, setAddonUrls, AddonKind } from '../utils/serverConfig';
import { reloadNuvio, nuvioStatus } from '../extractors/nuvio';
import { reloadStremio } from '../extractors/stremio';
import { searchTorznab } from '../utils/torrentSearch';

/**
 * Web API for the React client. Mirrors the client's api.ts contract:
 *   /health /home /search /title/:type/:id /title/tv/:id/season/:n
 *   /providers /providers/health /sources/stream (SSE)
 * Metadata is live TMDB; playable links come from the real provider engine,
 * served back through /api/proxy so they play cross-origin in the browser.
 */
const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────
const langOf = (req: any): string => (req.query.lang as string) || 'en-US';
const adultOf = (req: any): boolean => req.query.adult === '1';
// Indian-origin content — routed to TVDB (better coverage/order than TMDB) when a key is set.
const INDIAN_LANGS = new Set(['hi', 'ta', 'te', 'ml', 'kn', 'bn', 'mr', 'pa', 'gu', 'or', 'as', 'ur']);
const isIndian = (lang?: string, isBollywood?: boolean): boolean => !!isBollywood || INDIAN_LANGS.has((lang || '').toLowerCase());
// Non-negative integer query/path param, else undefined (rejects '1/../x', 'NaN', '').
const int = (v: unknown): number | undefined => (typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : undefined);
const pageOf = (req: any): number => Math.min(Math.max(int(req.query.page) || 1, 1), 500);   // TMDB caps at 500
const metaInput = (id: number, info: MetaData): MetaInput => ({
    id, type: info.type, title: info.title, year: info.year, imdbId: info.imdbId, orgTitle: info.originalTitle,
    isAnime: info.isAnime, isCartoon: info.isCartoon, indian: isIndian(info.originalLanguage, info.isBollywood),
});
// The season plan the client is showing. /title reports `metaSource`; the client echoes it
// as ?src= so /season, /skip-times and the SSE resolver number seasons the SAME way even
// when /title had to time out to TMDB while the AniList plan was still building.
// If the client numbered by AniList/TVDB but that plan just failed to rebuild, refuse
// (503 → client retries) rather than silently mapping cour N onto TMDB season N.
const planFor = async (req: any, id: number, info: MetaData): Promise<SeasonPlan> => {
    if (req.query.src === 'tmdb' || info.type !== 'tv') return TMDB_PLAN;
    const plan = await seasonPlan(metaInput(id, info));
    if (req.query.src && plan.source === 'tmdb') throw Object.assign(new Error('season metadata temporarily unavailable, retry'), { status: 503 });
    return plan;
};

// Belt-and-suspenders 18+ filter: TMDB include_adult only blocks pornographic
// titles, so also drop obvious adult markers when adult content is disabled.
// IMPORTANT: only UNAMBIGUOUS porn tokens here. Word-colliding tokens (sex, nudity,
// ecchi, yuri, yaoi, censored, fanservice) were silently blanking mainstream results
// — "Sex Education", "Yuri!!! on Ice", "Masters of Sex" — so they were removed.
const ADULT_RE = /(\b18\s*\+|\bhentai\b|\buncensored\b|\bnsfw\b|\bporn|\bxxx\b|\bahegao\b|\bhenta\b|\brape\b|\bincest\b)/i;
const isAdultItem = (it: any): boolean =>
    it.adult === true || ADULT_RE.test(it.title || it.name || '') || ADULT_RE.test(it.original_title || it.original_name || '');

// TMDB tags hentai/erotic content with keywords even when `adult` is false. Resolve
// those keyword ids once and exclude them from discovery when 18+ is off.
let adultKeywordIds: string | null = null;
// EXACT keyword names only (matched case-insensitively, whole name). Broad substring
// terms like 'sex'/'mature'/'adult animation' matched hundreds of keywords and stripped
// legitimate anime wholesale, so they're gone. These are unambiguously pornographic.
const ADULT_KW_TERMS = [
    'hentai', 'erotic', 'erotica', 'softcore', 'hardcore', 'pornographic', 'pornography',
    'ahegao', 'sexual violence', 'bestiality',
];
const getAdultKeywordIds = async (): Promise<string> => {
    // Memoize ONLY a non-empty result. Previously a single failed TMDB lookup at
    // startup cached '' forever, permanently DISABLING the 18+ keyword exclusion so
    // hentai/ecchi leaked into browse even with adult off. Now a total failure just
    // returns '' for this call and is retried on the next request.
    if (adultKeywordIds) return adultKeywordIds;
    const ids = new Set<number>();
    await Promise.all(ADULT_KW_TERMS.map(async (t) => {
        try {
            const d = await tmdbGet('/search/keyword', { query: t });
            (d.results || []).forEach((k: any) => { if ((k.name || '').toLowerCase() === t) ids.add(k.id); });
        } catch { /* ignore — don't poison the cache */ }
    }));
    const joined = [...ids].join('|'); // pipe = OR (exclude any)
    if (joined) adultKeywordIds = joined;
    return joined;
};

interface Card {
    id: number; type: 'movie' | 'tv'; title: string;
    posterUrl?: string; backdropUrl?: string; year?: string; voteAverage?: number; voteCount?: number; overview?: string;
}
const toCard = (item: any, forced?: 'movie' | 'tv'): Card => {
    const type: 'movie' | 'tv' = forced || item.media_type || (item.first_air_date || item.name ? 'tv' : 'movie');
    const date = item.release_date || item.first_air_date;
    return {
        id: item.id,
        type,
        title: item.title || item.name || 'Untitled',
        posterUrl: tmdbImg(item.poster_path, 'w500'),
        backdropUrl: tmdbImg(item.backdrop_path, 'w1280'),
        year: date ? String(date).slice(0, 4) : undefined,
        voteAverage: item.vote_average || undefined,
        voteCount: item.vote_count || 0,
        overview: item.overview || undefined,
    };
};

const qualityNum = (s: Stream): number => {
    const t = `${s.quality || ''} ${s.server || ''}`;
    if (/\b(2160|4k|uhd)\b/i.test(t)) return 2160;
    if (/\b1440\b/.test(t)) return 1440;
    if (/\b1080\b/.test(t)) return 1080;
    if (/\b720\b/.test(t)) return 720;
    if (/\b480\b/.test(t)) return 480;
    const m = /(\d{3,4})\s*p/i.exec(t);
    return m ? parseInt(m[1]) : 0;
};

const proxify = (s: Stream, episode?: number): string => {
    if (s.type === 'iframe') return s.link;
    // Debrid-cached direct file: stream through /api/torrent/http (range passthrough for
    // mp4, on-the-fly mkv→mp4 remux) — instant, no P2P.
    if (s.debrid) return `/api/torrent/http?url=${b64(s.link)}&remux=1`;
    // Torrent sources carry a magnet as the link — stream it through /api/torrent
    // (remux=1 so the browser can play the usual .mkv release as fragmented MP4).
    // Pass the episode so a BATCH torrent serves the RIGHT file (not just the largest).
    if (s.link.startsWith('magnet:')) return `/api/torrent/stream?magnet=${b64(s.link)}&remux=1${episode ? `&ep=${episode}` : ''}`;
    const u = b64(s.link);
    const h = s.headers ? `&h=${b64(JSON.stringify(s.headers))}` : '';
    const a = s.audioName ? `&audio=${encodeURIComponent(s.audioName)}` : '';
    return `/api/proxy?url=${u}${h}${a}${s.type === 'm3u8' ? '&m3u8=1' : ''}`;
};
const subProxy = (url: string, headers?: Record<string, string>): string => `/api/proxy/sub?url=${b64(url)}${headers ? `&h=${b64(JSON.stringify(headers))}` : ''}`;
const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return ''; } };

// ── AniList → TMDB bridge (for the AniList-powered anime browse) ───────────────
// A browsed anime is an AniList cour; playback runs off a TMDB id, so map it back by
// searching TMDB across the title's Japanese/romaji/English variants (the user's
// "some sources use the JP name, some the translated, some the English" case) and
// scoring by exact title + air year + Japanese-origin + Animation genre. Cached —
// mappings are stable, so each cour resolves TMDB at most once per process.
const normTitle = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const aniTmdb = new Map<number, { type: 'movie' | 'tv'; id: number } | null>();
const ANI_TMDB_MAX = 5000;
async function resolveAnimeToTmdb(anilistId: number, titles: string[], year?: number, type?: 'movie' | 'tv'): Promise<{ type: 'movie' | 'tv'; id: number } | null> {
    if (anilistId && aniTmdb.has(anilistId)) return aniTmdb.get(anilistId)!;
    let list = (titles || []).filter(Boolean);
    let ty = type, yr = year;
    let errored = false;   // a network failure must not be cached as "no TMDB match"
    if (!list.length && anilistId) {
        try {
            const info = await anilistTitleVariants(anilistId);
            if (info) { list = info.titles; ty = ty || info.type; yr = yr ?? info.year; }
        } catch { errored = true; }
    }
    // TMDB indexes the ROOT series ("Skeleton Knight in Another World"), not the cour
    // ("… Season 2"), so strip season/part markers and search the base name too — else a
    // Season-2 card finds nothing and the card dead-ends. The exact season is then
    // re-selected on the title page via ?al=.
    const stripSeason = (t: string): string => t
        .replace(/\s*[:\-–]?\s*(the\s+)?(final\s+season|season\s*\d+|\d+(?:st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+)\s*$/i, '')
        .replace(/\s{2,}/g, ' ').trim();
    const seenQ = new Set<string>();
    const queries: string[] = [];
    for (const t of list.slice(0, 3)) {
        for (const q of [t, stripSeason(t)]) { const k = normTitle(q); if (q && k && !seenQ.has(k)) { seenQ.add(k); queries.push(q); } }
    }
    const searchTypes: ('tv' | 'movie')[] = ty ? [ty] : ['tv', 'movie'];
    let best: { type: 'movie' | 'tv'; id: number } | null = null;
    let bestScore = 0;
    for (const t of queries) {
        for (const st of searchTypes) {
            let d: any;
            try { d = await tmdbGet(`/search/${st}`, { query: t }); } catch { errored = true; continue; }
            for (const it of (d.results || [])) {
                const cand = normTitle(it.title || it.name || ''), want = normTitle(t);
                if (!cand || !want) continue;
                let s = cand === want ? 4 : (cand.includes(want) || want.includes(cand)) ? 1 : 0;
                if (!s) continue;
                // Year MATCH is a bonus only — a cour's year differs from the root series,
                // so a mismatch must NOT penalize the correct root entry.
                const iy = parseInt((it.first_air_date || it.release_date || '').slice(0, 4)) || 0;
                if (yr && iy && iy === yr) s += 2;
                if (it.original_language === 'ja') s += 1;
                if ((it.genre_ids || []).includes(16)) s += 1;   // Animation
                if (s > bestScore) { bestScore = s; best = { type: st, id: it.id }; }
            }
        }
        if (best && bestScore >= 6) break;   // strong exact+ja+anim match — stop early
    }
    if (anilistId && (best || !errored)) { if (aniTmdb.size >= ANI_TMDB_MAX) aniTmdb.clear(); aniTmdb.set(anilistId, best); }
    return best;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => {
    // Swallow a rejection that arrives AFTER the race already settled — otherwise a
    // provider that rejects post-timeout becomes an unhandledRejection (process crash
    // under PM2/hardened Node). And clear the timer on settle so it can't leak.
    p.catch(() => { /* handled by the race, or ignored if it lands late */ });
    let timer: NodeJS.Timeout;
    const timeout = new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
};

// ── /health ──────────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
    res.json({ ok: true, tmdb: tmdbIsLive() ? 'live' : 'fallback', warp: warpConfigured(), time: new Date().toISOString() });
});

// ── /home ────────────────────────────────────────────────────────────────────
const HOME_ROWS: Array<{ key: string; name: string; path: string; type?: 'movie' | 'tv' }> = [
    { key: 'trending', name: 'Trending This Week', path: '/trending/all/week' },
    { key: 'pop_movies', name: 'Popular Movies', path: '/movie/popular', type: 'movie' },
    { key: 'pop_tv', name: 'Popular Series', path: '/tv/popular', type: 'tv' },
    { key: 'top_movies', name: 'Top Rated Movies', path: '/movie/top_rated', type: 'movie' },
    { key: 'now_playing', name: 'In Theaters', path: '/movie/now_playing', type: 'movie' },
    { key: 'airing', name: 'On TV Today', path: '/tv/airing_today', type: 'tv' },
];
router.get('/home', async (req, res) => {
    const language = langOf(req);
    try {
        const adult = adultOf(req);
        const rows = await Promise.all(HOME_ROWS.map(async (r) => {
            try {
                const data = await tmdbGet(r.path, { language, region: 'US', include_adult: adult });
                const items = (data.results || [])
                    .filter((it: any) => adult || !isAdultItem(it))
                    .map((it: any) => toCard(it, r.type))
                    .filter((c: Card) => c.posterUrl && (c.type === 'movie' || c.type === 'tv'))
                    .slice(0, 20);
                return { key: r.key, name: r.name, type: r.type || 'movie', items };
            } catch { return { key: r.key, name: r.name, type: r.type || 'movie', items: [] }; }
        }));
        res.json({ rows: rows.filter((r) => r.items.length) });
    } catch (e: any) {
        res.status(500).json({ rows: [], error: e?.message });
    }
});

// ── /search ──────────────────────────────────────────────────────────────────
// Typo tolerance: TMDB search is exact-ish ("naurto" → 0 hits). When a page-1 search
// is thin we also try Wikipedia's spelling suggestion and shortened-prefix queries,
// then rank the merged hits by bigram similarity to what was typed.
const bigrams = (s: string) => {
    const t = ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
    const out = new Map<string, number>();
    for (let i = 0; i < t.length - 1; i++) out.set(t.slice(i, i + 2), (out.get(t.slice(i, i + 2)) || 0) + 1);
    return out;
};
export const similarity = (a: string, b: string) => {   // Dice coefficient, 0..1
    const A = bigrams(a), B = bigrams(b);
    let hit = 0, total = 0;
    for (const [k, n] of A) { hit += Math.min(n, B.get(k) || 0); total += n; }
    for (const n of B.values()) total += n;
    return total ? (2 * hit) / total : 0;
};
const spellCache = new Map<string, string[]>();
const spellCooldown: Record<string, number> = {};
// Search-engine autocomplete knows show/actor names that dictionaries don't
// ("the kardshin" → "the kardashians"). Both are asked; either may be blocked.
const SPELLERS: [string, (q: string) => string][] = [
    ['ddg', q => `https://duckduckgo.com/ac/?type=list&kl=us-en&q=${encodeURIComponent(q)}`],
    ['google', q => `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(q)}`],
];
// "joker movie" / "titanic 1997" / "friends cast" → the title part
const SUGGEST_NOISE = /\s+(movie|movies|film|series|show|tv|cast|meme|memes|wallpaper|wallpapers|song|songs|full|full movie|trailer|release date|season \d+|part \d+|ott|imdb|images?|(19|20)\d\d)$/i;
const coreOf = (x: string) => { let y = x.trim(); for (let i = 0; i < 3; i++) y = y.replace(SUGGEST_NOISE, ''); return y.toLowerCase(); };
async function askSpeller(name: string, url: string): Promise<string[]> {
    if (Date.now() < (spellCooldown[name] || 0)) return [];
    try {
        const { data } = await axios.get(url, { timeout: 3000, headers: { 'User-Agent': 'Mozilla/5.0 (StreamPlay)' } });
        return Array.isArray(data?.[1]) ? data[1] : [];
    } catch (e: any) {
        // only a real block/rate-limit benches a speller; a slow reply just skips this query
        if ([403, 429].includes(e?.response?.status)) spellCooldown[name] = Date.now() + 60_000;
        return [];
    }
}
async function spellSuggest(q: string): Promise<string[]> {
    const key = q.toLowerCase().trim();
    const hit = spellCache.get(key);
    if (hit) return hit;
    const lists = await Promise.all(SPELLERS.map(([n, u]) => askSpeller(n, u(q))));
    // interleave so each speller's best guesses come first
    const merged: string[] = [];
    for (let i = 0; i < 8; i++) for (const l of lists) if (l[i]) merged.push(coreOf(l[i]));
    // suggestion order varies by region; keep the ones closest to what was typed
    const fixes = [...new Set(merged)].filter(x => x.length > 1 && x !== key)
        .sort((a, b) => similarity(key, b) - similarity(key, a)).slice(0, 5);
    if (lists.some(l => l.length)) {   // don't cache a total failure
        if (spellCache.size > 2000) spellCache.clear();
        spellCache.set(key, fixes);
    }
    return fixes;
}
// "interstaler" → ["interstal", "interst"]: drop the tail of the longest word.
const prefixVariants = (q: string) => {
    const words = q.trim().split(/\s+/);
    const i = words.reduce((m, w, j) => (w.length > words[m].length ? j : m), 0);
    const w = words[i];
    if (w.length < 5) return [];
    return [...new Set([Math.ceil(w.length * 0.8), Math.ceil(w.length * 0.6), Math.max(4, Math.ceil(w.length * 0.5))])]
        .map(n => [...words.slice(0, i), w.slice(0, n)].join(' '));
};

async function searchCards(q: string, req: any, page: number) {
    const showAdult = adultOf(req);
    const data = await tmdbGet('/search/multi', { query: q, language: langOf(req), include_adult: showAdult, page });
    const items: Card[] = (data.results || [])
        .filter((it: any) => (it.media_type === 'movie' || it.media_type === 'tv') && (showAdult || !isAdultItem(it)))
        .map((it: any) => toCard(it));
    return { items, page: data.page || 1, totalPages: data.total_pages || 1 };
}

// TMDB "found something" isn't enough: "the kardshin" matches junk like "Kingdom of the
// Silver Lion". Only trust it when a top hit actually resembles what was typed.
const goodMatch = (q: string, items: Card[]) => items.slice(0, 5).some(c => similarity(q, c.title) >= 0.9);

// Rank = closeness to what was typed, closeness to a spelling fix, popularity
// (Joker beats "Jokes"; Titanic beats "Buffet Titanic").
const rankScore = (q: string, fixes: string[], c: Card) =>
    0.5 * similarity(q, c.title) + 0.3 * Math.max(0, ...fixes.map(f => similarity(f, c.title)))
    + 0.2 * Math.min(1, Math.log10(1 + (c.voteCount || 0)) / 4.5);

// TMDB's own order puts obscure near-matches first ("ExoMars: Europe's Imposible Mission"
// above Mission: Impossible) — re-sort by closeness + popularity.
const rerank = (q: string, items: Card[]) =>
    items.map(c => ({ c, s: rankScore(q, [], c) })).sort((a, b) => b.s - a.s).map(x => x.c);

const fuzzyCache = new Map<string, { at: number; v: { items: Card[]; didYouMean?: string } }>();
async function fuzzySearch(q: string, req: any, base: Card[]) {
    const key = `${q.toLowerCase()}|${langOf(req)}|${adultOf(req)}`;
    const c = fuzzyCache.get(key);
    if (c && Date.now() - c.at < 10 * 60_000) return c.v;
    const fixes = await spellSuggest(q);
    const queries = [...new Set([...fixes, ...prefixVariants(q)])].slice(0, 8);
    let partial = false;   // a failed lookup must not be cached as the answer
    const batches = await Promise.all(queries.map(v => searchCards(v, req, 1).then(r => r.items).catch(() => { partial = true; return [] as Card[]; })));
    const seen = new Set<string>();
    const ranked = [...base, ...batches.flat()]
        .filter(c => !seen.has(`${c.type}:${c.id}`) && seen.add(`${c.type}:${c.id}`))
        .map(c => ({ c, sq: similarity(q, c.title), sf: Math.max(0, ...fixes.map(f => similarity(f, c.title))) }))
        .filter(x => Math.max(x.sq, x.sf) >= 0.35)
        .map(x => ({ c: x.c, score: rankScore(q, fixes, x.c) }))
        .sort((a, b) => b.score - a.score)
        .map(x => x.c);
    const top = ranked[0];
    const fix = top && [...fixes].sort((a, b) => similarity(b, top.title) - similarity(a, top.title))[0];
    // a correct prefix ("breaking" → Breaking Bad) is not a typo: no "Did you mean"
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const isPrefix = ranked.slice(0, 3).some(c => norm(c.title).startsWith(norm(q)));
    const v = { items: ranked.slice(0, 20), didYouMean: top && !isPrefix && similarity(q, top.title) < 0.9 ? (fix && similarity(fix, top.title) >= 0.7 ? fix : top.title) : undefined };
    if (fuzzyCache.size > 1000) fuzzyCache.clear();
    if (!partial) fuzzyCache.set(key, { at: Date.now(), v });
    return v;
}

router.get('/search', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 120);
    const page = pageOf(req);
    if (!q) return res.json({ items: [], page: 1, totalPages: 0 });
    try {
        const r = await searchCards(q, req, page);
        if (page > 1) return res.json(r);
        if (goodMatch(q, r.items)) return res.json({ ...r, items: rerank(q, r.items) });
        const f = await fuzzySearch(q, req, r.items);
        if (!f.items.length) return res.json(r);
        res.json({ items: f.items, page: 1, totalPages: 1, didYouMean: f.didYouMean });
    } catch (e: any) {
        res.status(500).json({ items: [], page: 1, totalPages: 0, error: e?.message });
    }
});

// As-you-type suggestions (header search dropdown): top 8, typo-tolerant.
router.get('/suggest', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (q.length < 2) return res.json({ items: [] });
    try {
        const r = await searchCards(q, req, 1);
        if (goodMatch(q, r.items)) return res.json({ items: rerank(q, r.items).slice(0, 8) });
        const f = await fuzzySearch(q, req, r.items);
        res.json({ items: (f.items.length ? f.items : r.items).slice(0, 8), didYouMean: f.didYouMean });
    } catch {
        res.json({ items: [] });
    }
});

// ── /browse — generalized discovery for Anime / Movies / Series / Asian drama ──
const ANIME_GENRE = 16; // TMDB "Animation" genre
interface SectionDef { withGenres?: number; withoutGenres?: number; langs?: string[]; types: ('tv' | 'movie')[]; }
const SECTIONS: Record<string, SectionDef> = {
    anime: { withGenres: ANIME_GENRE, langs: ['ja'], types: ['tv', 'movie'] },
    movies: { types: ['movie'] },
    // Series = live-action TV (anime/animation lives on the Anime page)
    series: { withoutGenres: ANIME_GENRE, types: ['tv'] },
    // Asian drama = Korean / Chinese / Japanese live-action (exclude Animation)
    asian: { withoutGenres: ANIME_GENRE, langs: ['ko', 'zh', 'ja'], types: ['tv', 'movie'] },
};

// Category → TMDB genre id per kind (movie/tv genre lists differ). `kw` is a
// keyword-search fallback used when a kind has no matching genre (e.g. TV has no
// Romance/Horror genre — so anime romance/horror filter by keyword instead).
const CATEGORY_GENRES: Record<string, { movie?: number; tv?: number; kw?: string }> = {
    action: { movie: 28, tv: 10759 },
    adventure: { movie: 12, tv: 10759 },
    comedy: { movie: 35, tv: 35 },
    drama: { movie: 18, tv: 18 },
    romance: { movie: 10749, kw: 'romance' },
    scifi: { movie: 878, tv: 10765 },
    fantasy: { movie: 14, tv: 10765 },
    horror: { movie: 27, kw: 'horror' },
    thriller: { movie: 53, kw: 'thriller' },
    mystery: { movie: 9648, tv: 9648 },
    crime: { movie: 80, tv: 80 },
    family: { movie: 10751, tv: 10751 },
    music: { movie: 10402, kw: 'music' },
    documentary: { movie: 99, tv: 99 },
};

// Resolve a TMDB keyword id by term (cached).
const keywordCache = new Map<string, number | null>();
const getKeywordId = async (term: string): Promise<number | null> => {
    if (keywordCache.has(term)) return keywordCache.get(term)!;
    let id: number | null = null;
    try {
        const d = await tmdbGet('/search/keyword', { query: term });
        const results = d.results || [];
        const t = term.toLowerCase();
        // Exact name first; else a keyword whose name CONTAINS the term (e.g. "slice of
        // life anime"). Never blindly bind to the unrelated first result.
        const exact = results.find((k: any) => (k.name || '').toLowerCase() === t);
        const contains = results.find((k: any) => (k.name || '').toLowerCase().includes(t));
        id = exact?.id ?? contains?.id ?? null;
    } catch { /* ignore */ }
    // Only memoize a real hit — caching a transient-failure `null` would permanently
    // disable that genre keyword for the process lifetime.
    if (id !== null) keywordCache.set(term, id);
    return id;
};

const buildDiscover = (kind: 'tv' | 'movie', olang: string | undefined, cat: string, range: string, page: number, language: string, sec: SectionDef, adult = false, genreId?: number, withoutKeywords?: string, withKeyword?: number): Record<string, any> => {
    // newest = by premiere/release date; window = "active in range" (TV uses episode air dates so
    // Trending This Week = currently-airing, not just series that *premiered* this week).
    const newestField = kind === 'movie' ? 'primary_release_date' : 'first_air_date';
    const windowField = kind === 'movie' ? 'primary_release_date' : 'air_date';
    const today = new Date().toISOString().slice(0, 10);
    const start = rangeStart(range);
    const p: Record<string, any> = { include_adult: adult, language, page };
    const genreIds = [sec.withGenres, genreId].filter((g): g is number => !!g);
    if (genreIds.length) p.with_genres = genreIds.join(',');
    if (sec.withoutGenres) p.without_genres = sec.withoutGenres;
    if (withoutKeywords) p.without_keywords = withoutKeywords;
    if (withKeyword) p.with_keywords = String(withKeyword);
    if (olang) p.with_original_language = olang;
    switch (cat) {
        case 'newest':
            p.sort_by = `${newestField}.desc`; p[`${newestField}.lte`] = today; p['vote_count.gte'] = 5; break;
        case 'trending':
            p.sort_by = 'popularity.desc'; if (start) { p[`${windowField}.gte`] = start; p[`${windowField}.lte`] = today; } break;
        case 'toprated':
            p.sort_by = 'vote_average.desc'; p['vote_count.gte'] = 150; if (start) { p[`${windowField}.gte`] = start; p[`${windowField}.lte`] = today; } break;
        case 'random':
            p.sort_by = 'popularity.desc'; p.page = 1 + Math.floor(Math.random() * 15); break;
        default: // popular / all
            p.sort_by = 'popularity.desc'; break;
    }
    return p;
};

router.get('/browse', async (req, res) => {
    const section = (req.query.section as string) || 'movies';
    const sec = SECTIONS[section];
    if (!sec) return res.status(400).json({ items: [], page: 1, totalPages: 0, error: 'unknown section' });

    const cat = (req.query.cat as string) || 'popular';
    const range = (req.query.range as string) || 'all';
    const audio = req.query.audio as string;
    const page = pageOf(req);
    const language = langOf(req);

    const reqType = req.query.type as string;
    const kinds: ('tv' | 'movie')[] = (reqType === 'tv' || reqType === 'movie') ? [reqType] : sec.types;

    const region = req.query.region as string;
    // `ol` = explicit original-language / industry filter (Bollywood=hi, Tollywood=te,
    // Kollywood=ta, Mollywood=ml, Sandalwood=kn, Hollywood=en). Overrides the section
    // default so Movies/Series can be filtered by industry too.
    const ol = req.query.ol as string;
    let langs: (string | undefined)[];
    if (ol && ol !== 'all') langs = [ol];
    else if (!sec.langs) langs = [undefined];
    else if (region && region !== 'all') langs = [region];
    else langs = section === 'asian' ? ['ko', 'zh'] : sec.langs;

    const cats = ((req.query.genres as string) || '').split(',').map((s) => s.trim()).filter(Boolean);

    // Anime browses AniList directly (complete catalog, real multi-genres/tags, correct
    // per-cour dates so new seasons surface in Newest/Top-Rated). Each card is a cour
    // resolved to a TMDB id on click. Sub/Dub also FILTERS here: audio=dub keeps only
    // titles with a known dub (best-effort, from MyDubList — see dublist.ts), since
    // AniList itself has no dub data.
    if (section === 'anime') {
        try {
            const r = await anilistBrowse({
                page, cats,
                type: (reqType === 'tv' || reqType === 'movie') ? reqType : 'all',
                cat, range, adult: adultOf(req), audio,
            });
            const items = r.items.map((m) => ({
                // Negated AniList id: keeps the card's plain href (/title/tv/-<al>) resolvable on
                // its own (new tab, refresh, share) without colliding with a TMDB id. See titleRef.
                id: -m.anilistId, type: m.type, title: m.title,
                posterUrl: m.posterUrl, year: m.year ? String(m.year) : undefined,
                voteAverage: m.score, voteCount: 0,
                needsResolve: true, anilistId: m.anilistId, resolveTitles: m.titles, resolveType: m.type,
            }));
            return res.json({ items, page, totalPages: r.lastPage });
        } catch (e: any) {
            return res.status(500).json({ items: [], page: 1, totalPages: 0, error: e?.message });
        }
    }

    try {
        // When 18+ is off, exclude hentai/erotic keyword content (TMDB doesn't flag all of it as adult).
        const withoutKeywords = adultOf(req) ? undefined : await getAdultKeywordIds();

        const batches: { k: 'tv' | 'movie'; l: string | undefined; genreId?: number; keywordId?: number }[] = [];
        for (const k of kinds) for (const l of langs) {
            if (cats.length) {
                for (const c of cats) {
                    const def = CATEGORY_GENRES[c];
                    if (!def) continue;
                    const gid = def[k];
                    if (gid) batches.push({ k, l, genreId: gid });
                    else if (def.kw) { const kid = await getKeywordId(def.kw); if (kid) batches.push({ k, l, keywordId: kid }); }
                }
            } else {
                batches.push({ k, l });
            }
        }

        const results = await Promise.all(batches.map(async ({ k, l, genreId, keywordId }) => {
            const data = await tmdbGet(k === 'movie' ? '/discover/movie' : '/discover/tv', buildDiscover(k, l, cat, range, page, language, sec, adultOf(req), genreId, withoutKeywords, keywordId));
            return { results: data.results || [], total: data.total_pages || 1, kind: k };
        }));

        const showAdult = adultOf(req);
        // Key the dedupe set by KIND+id: TMDB movie and TV ids are independent sequences,
        // so a movie and a show can share a numeric id and the second was being dropped.
        const seen = new Set<string>();
        const merged: any[] = [];
        results.forEach((r) => r.results.forEach((it: any) => {
            const k = `${r.kind}:${it.id}`;
            if (it.poster_path && !seen.has(k) && (showAdult || !isAdultItem(it))) { seen.add(k); merged.push({ ...it, __kind: r.kind }); }
        }));

        const key = cat === 'newest'
            ? (x: any) => x.release_date || x.first_air_date || ''
            : cat === 'toprated' ? (x: any) => x.vote_average || 0 : (x: any) => x.popularity || 0;
        merged.sort((a, b) => (key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0));

        // No slice: each TMDB batch is its own page N, so trimming the merge to 24 made the
        // rest of every batch's page N unreachable (page N+1 starts at the batch's next page).
        const items = merged.map((it) => toCard(it, it.__kind));
        const totalPages = Math.min(Math.max(...results.map((r) => r.total), 1), 50);
        res.json({ items, page, totalPages });
    } catch (e: any) {
        res.status(500).json({ items: [], page: 1, totalPages: 0, error: e?.message });
    }
});

// ── /resolve/anime — map a browsed AniList cour → a playable TMDB id ──────────
// The anime browse returns AniList entries; a card carries its title variants + year
// so playback can find the TMDB entry on click (`anilistId` is echoed back so the
// title page can pre-select the exact season/cour that was clicked).
router.get('/resolve/anime', async (req, res) => {
    const al = int(req.query.al) || 0;
    let titles: string[] = [];
    try { const raw = req.query.titles as string; if (raw) { const j = JSON.parse(raw); if (Array.isArray(j)) titles = j.map(String); } } catch { /* */ }
    const year = int(req.query.year);
    const type = req.query.type === 'movie' ? 'movie' : req.query.type === 'tv' ? 'tv' : undefined;
    if (!al && !titles.length) return res.status(400).json({ error: 'need al or titles' });
    const r = await resolveAnimeToTmdb(al, titles, year, type as any);
    if (!r) return res.status(404).json({ error: 'no matching TMDB entry' });
    res.json({ ...r, anilistId: al || undefined });
});

// ── /title/:type/:id ─────────────────────────────────────────────────────────
// User-safe title errors (the raw upstream message, e.g. axios "status code 404", never leaks).
const TITLE_GONE = { error: "This title isn't available anymore.", code: 'not_found' };
const TITLE_DOWN = { error: "Couldn't load this title. Check your connection and try again.", code: 'upstream' };
const titleErr = (res: any, e: any, extra: object = {}) => (e?.response?.status === 404 || e?.status === 404
    ? res.status(404).json({ ...TITLE_GONE, ...extra }) : res.status(502).json({ ...TITLE_DOWN, ...extra }));

/** A title route id → TMDB {type,id}. A NEGATIVE id is an AniList id (anime browse cards,
 *  see /browse) and is resolved to its TMDB entry, so a cold server serves any such link. */
async function titleRef(type: 'movie' | 'tv', raw: string): Promise<{ type: 'movie' | 'tv'; id: number; anilistId?: number } | null> {
    if (!/^-?\d{1,9}$/.test(raw) || Number(raw) === 0) return null;
    const id = Number(raw);
    if (id > 0) return { type, id };
    const r = await resolveAnimeToTmdb(-id, [], undefined, type);
    if (!r) throw Object.assign(new Error('no TMDB match'), { status: 404 });
    return { ...r, anilistId: -id };
}

router.get('/title/:type/:id', async (req, res) => {
    if (req.params.type !== 'movie' && req.params.type !== 'tv') return res.status(400).json({ error: 'bad type or id', code: 'bad_request' });
    try {
        const ref = await titleRef(req.params.type, req.params.id);
        if (!ref) return res.status(400).json({ error: 'bad type or id', code: 'bad_request' });
        const { type, id } = ref;
        const d = await tmdbGet(`/${type}/${id}`, {
            language: langOf(req),
            append_to_response: 'credits,recommendations,videos,external_ids',
        });
        const { genres, isAnime, isCartoon, isAsian, isBollywood } = classify(d);
        const lang = d.original_language;

        // Better season structure than TMDB for anime (AniList cours) and cartoons/
        // series (TheTVDB). Falls back to TMDB seasons when the plan is 'tmdb'.
        let seasons = (d.seasons || []).filter((s: any) => s.season_number > 0).map((s: any) => ({
            seasonNumber: s.season_number, name: s.name, episodeCount: s.episode_count,
        }));
        let metaSource: SeasonPlan['source'] = 'tmdb';
        if (type === 'tv') {
            try {
                // Bounded so a slow/rate-limited AniList never stalls the title page — degrade to
                // TMDB. The build keeps going (deduped in seasonPlan); the client echoes the
                // metaSource we report here as ?src= so /season + the SSE resolver agree with it.
                const plan = await withTimeout(
                    seasonPlan({ id: d.id, type, title: d.name || d.title, year: parseInt((d.first_air_date || '').slice(0, 4)) || undefined, imdbId: d.external_ids?.imdb_id, orgTitle: d.original_name || d.original_title, isAnime, isCartoon, indian: isIndian(lang, isBollywood) }),
                    9000, TMDB_PLAN,
                );
                if (plan.source !== 'tmdb' && plan.seasons.length) {
                    // AniList cour names come lower-case sometimes ("restart") — sentence-case those, leave real casing alone
                    seasons = plan.seasons.map((s) => ({ seasonNumber: s.seasonNumber, name: s.name && s.name === s.name.toLowerCase() ? s.name[0].toUpperCase() + s.name.slice(1) : s.name, episodeCount: s.episodeCount, anilistId: s.anilistId }));
                    metaSource = plan.source;
                }
            } catch { /* keep TMDB seasons */ }
        }

        res.json({
            id: d.id,
            type,
            anilistId: ref.anilistId,   // set when the link was an AniList id: the cour to pre-select
            title: d.title || d.name,
            posterUrl: tmdbImg(d.poster_path, 'w500'),
            backdropUrl: tmdbImg(d.backdrop_path, 'w1280'),
            year: (d.release_date || d.first_air_date || '').slice(0, 4) || undefined,
            overview: d.overview,
            runtime: d.runtime || (d.episode_run_time && d.episode_run_time[0]) || undefined,
            voteAverage: d.vote_average || undefined,
            genres,
            imdbId: d.external_ids?.imdb_id,
            cast: (d.credits?.cast || []).slice(0, 16).map((c: any) => ({
                name: c.name, character: c.character, profileUrl: tmdbImg(c.profile_path, 'w185'),
            })),
            recommendations: (d.recommendations?.results || []).filter((r: any) => r.poster_path).slice(0, 18).map((r: any) => toCard(r)),
            trailerKeys: (d.videos?.results || []).filter((v: any) => v.site === 'YouTube' && /trailer|teaser/i.test(v.type)).map((v: any) => v.key),
            seasons,
            originalLanguage: lang,
            metaSource,
            classification: { isAnime, isAsian, isBollywood, isCartoon },
        });
    } catch (e: any) {
        titleErr(res, e);
    }
});

// ── /title/tv/:id/season/:n ──────────────────────────────────────────────────
router.get('/title/tv/:id/season/:n', async (req, res) => {
    const n = int(req.params.n);
    let id: number | undefined;
    try { id = (await titleRef('tv', req.params.id))?.id; } catch (e) { return titleErr(res, e, { seasonNumber: n, episodes: [] }); }
    if (!id || n === undefined) return res.status(400).json({ seasonNumber: n, episodes: [], error: 'bad id or season', code: 'bad_request' });
    // Prefer the AniList/TVDB plan (matches the seasons /title returned, see planFor); fall back to TMDB.
    try {
        const info = req.query.src === 'tmdb' ? null : await getTMDBInfo(id, 'tv');
        if (info) {
            const plan = await planFor(req, id, info);
            if (plan.source !== 'tmdb') {
                const ps = plan.seasons.find((s) => s.seasonNumber === n);
                const runtime = ps?.runtime ?? info.episodeRuntime;   // per-episode length falls back to the cour's / series' typical one
                const eps = await planEpisodes(plan, n);
                if (eps && eps.length) {
                    return res.json({ seasonNumber: n, episodes: eps.map((e) => ({ id: `${id}-${e.seasonNumber}-${e.episodeNumber}`, name: e.name, overview: e.overview, stillUrl: e.stillUrl, episodeNumber: e.episodeNumber, seasonNumber: e.seasonNumber, airDate: e.airDate, runtime: e.runtime ?? runtime })) });
                }
                // Plan exists but no per-episode detail: return a BARE numbered list from the
                // plan's episodeCount. Do NOT fall back to tmdbGet(/season/n) — here `n` is the
                // AniList cour / TVDB-order index, NOT a TMDB season number, so TMDB would
                // return the wrong season entirely.
                const count = ps?.episodeCount || 0;
                const bare = Array.from({ length: count }, (_v, i) => ({ id: `${id}-${n}-${i + 1}`, episodeNumber: i + 1, seasonNumber: n, runtime }));
                return res.json({ seasonNumber: n, episodes: bare });
            }
        }
    } catch (e: any) {
        if (e?.status === 503) return res.status(503).json({ error: e.message });
        /* else fall through to TMDB */
    }
    try {
        const data = await tmdbGet(`/tv/${id}/season/${n}`, { language: langOf(req) });
        const episodes = (data.episodes || []).map((e: any) => ({
            id: e.id, name: e.name, overview: e.overview, stillUrl: tmdbImg(e.still_path, 'w300'),
            episodeNumber: e.episode_number, seasonNumber: e.season_number,
            voteAverage: e.vote_average || undefined, airDate: e.air_date, runtime: e.runtime || undefined,
        }));
        res.json({ seasonNumber: n, episodes });
    } catch (e: any) {
        titleErr(res, e, { seasonNumber: n, episodes: [] });
    }
});

// ── /skip-times — AniSkip OP/ED intervals for an anime episode ────────────────
// Resolves the title's MAL id (via the cached anime resolver) then queries the
// AniSkip API (https://github.com/aniskip/aniskip-api). Returns opening/ending
// intervals in seconds, or nulls for non-anime / unknown episodes.
router.get('/skip-times', async (req, res) => {
    const empty = { opening: null as null | { start: number; end: number }, ending: null as null | { start: number; end: number } };
    try {
        const id = int(req.query.id);
        const type = req.query.type as 'movie' | 'tv';
        const episode = int(req.query.episode) || 1;
        const season = int(req.query.season);
        const length = int(req.query.length) || 0;
        if (!id || (type !== 'movie' && type !== 'tv')) return res.json(empty);

        const info = await getTMDBInfo(id, type);
        if (!info?.isAnime) return res.json(empty);
        const ids = await resolveAnimeIds(id, type, info.title, info.year?.toString(), info.originalTitle);

        // For S2+, AniSkip needs the MAL id of THAT COUR (the episode number is per-cour) —
        // using the root's MAL id would return season-1's OP/ED times. Get the cour's MAL id
        // from the AniList franchise plan.
        let malId = ids.malId;
        if (type === 'tv' && season && season > 1 && ids.anilistId) {
            try {
                const plan = await planFor(req, id, info);
                const cour = plan.source === 'anilist' ? plan.seasons.find((s) => s.seasonNumber === season) : undefined;
                if (cour?.malId) malId = cour.malId;
            } catch { /* fall back to root MAL id */ }
        }
        if (!malId) return res.json(empty);

        const url = `https://api.aniskip.com/v2/skip-times/${malId}/${episode}?types=op&types=ed&episodeLength=${length}`;
        const r = await axios.get(url, { timeout: 8000, validateStatus: () => true });
        const out = { ...empty };
        if (r.data?.found && Array.isArray(r.data.results)) {
            for (const s of r.data.results) {
                const iv = s.interval && typeof s.interval.startTime === 'number' && typeof s.interval.endTime === 'number'
                    ? { start: s.interval.startTime, end: s.interval.endTime } : null;
                if (!iv) continue;
                if (s.skipType === 'op') out.opening = iv;
                else if (s.skipType === 'ed') out.ending = iv;
            }
        }
        res.json(out);
    } catch {
        res.json(empty);
    }
});

// ── /diag — FlareSolverr + WARP health (uptime/ping/version + egress IP) ───────
// Lets you confirm each FlareSolverr is up AND that traffic actually leaves via
// WARP: compare the server's DIRECT ip against each FlareSolverr/WARP egress ip —
// if WARP is working they differ (WARP shows a Cloudflare IP).
const hostLabel = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/v1\/?$/, '').replace(/^socks5:\/\//, '');
router.get('/diag', async (_req, res) => {
    const startedAt = Date.now();
    let directIp: string | undefined;
    try { directIp = (await axios.get('https://api.ipify.org?format=json', { timeout: 8000 })).data?.ip; } catch { /* */ }

    const fsEndpoints = flareSolverrEndpoints();
    const cfg = warpConfig();
    const [flaresolverr, warpSocks] = await Promise.all([
        Promise.all(fsEndpoints.map(async (ep) => ({ host: hostLabel(ep), ...(await probeFlareSolverr(ep)) }))),
        Promise.all(cfg.socks.map(async (s) => ({ host: hostLabel(s), ...(await probeWarpSocks(s)) }))),
    ]);
    res.json({
        directIp,
        warpMode: cfg.mode,
        warpEnabled: warpConfigured(),
        flaresolverr,
        warpSocks,
        flaresolverrLoad: flareSolverrLoad(),
        tookMs: Date.now() - startedAt,
        time: new Date().toISOString(),
    });
});

// ── /providers + /providers/health ───────────────────────────────────────────
// From the provider's own `kinds` gating (extractors/index.ts): one kind → that kind,
// several or none (= serves all) → multi. Subtitle providers carry no kind data.
const KIND_OF = (p: Provider): string =>
    /subtitle|subs$/i.test(p.id) ? 'subtitles' : p.kinds?.length === 1 ? p.kinds[0] : 'multi';
const hostFor = (id: string): string => {
    const d = providerDomains.find((p) => p.id === id);
    return d ? d.url.replace(/^https?:\/\//, '') : '';
};
router.get('/providers', (_req, res) => {
    const list = getProviders().map((p) => ({
        id: p.id, name: p.name, kind: KIND_OF(p), host: hostFor(p.id), needsToken: false,
        stats: providerStat(p.id),                 // real success rate / latency / circuit state
        priorityScore: providerPriority(p.id),
    }));
    res.json(list);
});

router.get('/providers/health', async (_req, res) => {
    // Only report providers that are actually served (avoids showing disabled /
    // anime domains that never produce links).
    const activeIds = new Set(getProviders().map((p) => p.id));
    const active = providerDomains.filter((p) => activeIds.has(p.id));
    const results = await Promise.all(active.map(async (p) => {
        const start = Date.now();
        try {
            const r = await axios.get(p.url, { timeout: 6000, validateStatus: () => true });
            return { id: p.id, name: p.name, host: p.url.replace(/^https?:\/\//, ''), status: 'up' as const, latencyMs: Date.now() - start, httpStatus: r.status };
        } catch {
            return { id: p.id, name: p.name, host: p.url.replace(/^https?:\/\//, ''), status: 'down' as const, latencyMs: Date.now() - start };
        }
    }));
    res.json(results);
});

// ── /config — runtime server config set from the UI (Torrent indexer) ─────────
// Writes are gated by ADMIN_TOKEN when it's set (lock down a public instance); open
// otherwise (personal use). Header only (X-Admin-Token) — a ?token= lands in access logs.
// The API key is never returned to the client.
const configAuthed = (req: any): boolean => !process.env.ADMIN_TOKEN || req.get('x-admin-token') === process.env.ADMIN_TOKEN;
// Addon URLs often embed secrets (Torrentio: /realdebrid=KEY/manifest.json), so full URLs
// go only to a request carrying the real ADMIN_TOKEN; everyone else sees just the host.
const maskUrl = (u: string) => { try { return `${new URL(u).origin}/…`; } catch { return '…'; } };
router.get('/config', (req, res) => {
    const full = !!process.env.ADMIN_TOKEN && req.get('x-admin-token') === process.env.ADMIN_TOKEN;
    const view = <T extends { urls: string[] }>(l: T) => (full ? l : { ...l, urls: l.urls.map(maskUrl), redacted: true });
    const status = nuvioStatus().map(st => (full ? st : { ...st, manifest: maskUrl(st.manifest) }));
    res.json({
        torznab: torznabPublic(), adminLock: !!process.env.ADMIN_TOKEN,
        nuvio: { ...view(addonPublic('nuvio')), status }, stremio: view(addonPublic('stremio')),
    });
});
// Nuvio plugin repos / Stremio addon manifests. Body: { urls: string[] } (replaces the UI
// list) or { urls: null } (clear → fall back to the env var). Unlike Torznab these REQUIRE
// ADMIN_TOKEN to be set: a Nuvio plugin is code the server executes, and both lists
// allowlist their (possibly LAN) origins in the SSRF guard — never open to anonymous writes.
const addonRoute = (kind: AddonKind, reload: () => Promise<void>) => async (req: any, res: any) => {
    if (!process.env.ADMIN_TOKEN) return res.status(403).json({ ok: false, error: 'set ADMIN_TOKEN on the server to manage addons from the UI' });
    if (!configAuthed(req)) return res.status(403).json({ ok: false, error: 'admin token required' });
    const urls = req.body?.urls;
    if (urls !== null && !(Array.isArray(urls) && urls.every((u: unknown) => typeof u === 'string'))) return res.status(400).json({ ok: false, error: 'urls must be a string[] or null' });
    setAddonUrls(kind, urls);
    await reload().catch(() => { /* per-manifest errors are reported in status */ });
    res.json({ ok: true, [kind]: kind === 'nuvio' ? { ...addonPublic('nuvio'), status: nuvioStatus() } : addonPublic('stremio') });
};
router.post('/config/nuvio', addonRoute('nuvio', reloadNuvio));
router.post('/config/stremio', addonRoute('stremio', reloadStremio));
router.post('/config/torznab', (req, res) => {
    if (!configAuthed(req)) return res.status(403).json({ ok: false, error: 'admin token required' });
    const { kind, url, apiKey } = req.body || {};
    const k = ['jackett', 'prowlarr', 'torznab'].includes(kind) ? kind : 'jackett';
    setTorznab(k, String(url || ''), String(apiKey || ''));
    res.json({ ok: true, torznab: torznabPublic() });
});
// Live test: run a sample query and report how many releases came back.
router.get('/config/torznab/test', async (_req, res) => {
    try {
        const r = await searchTorznab('the', '2000');   // a broad query that any movie indexer answers
        res.json({ ok: true, count: r.length });
    } catch (e: any) {
        res.json({ ok: false, error: String(e?.message || e).slice(0, 200) });
    }
});

// ── resolved-source cache ─────────────────────────────────────────────────────
// Re-resolving all providers (and re-solving Cloudflare) on every open of the same
// title/episode is slow and hammers the FlareSolverr pool. Cache the full set of SSE
// events for a few minutes and replay them instantly on a repeat open / rewatch /
// SSE-reconnect / failover. `?fresh=1` bypasses. Sources with short-lived tokens are
// covered by the modest TTL + the player's automatic failover to another source.
interface SourceCacheEntry { at: number; isAnime?: boolean; originalLanguage?: string; events: { e: string; d: any }[] }
const SOURCE_CACHE_TTL = 8 * 60 * 1000;   // 8 minutes
const SOURCE_CACHE_MAX = 500;
const sourceCache = new Map<string, SourceCacheEntry>();
const sourceCacheKey = (type: string, id: number, season?: number, episode?: number, src?: unknown) => `${type}:${id}:${season ?? ''}:${episode ?? ''}${src === 'tmdb' ? ':tmdb' : ''}`;

// ── console.error trace capture (concurrency-safe) ────────────────────────────
// The debug endpoint needs the provider's ANIME_DEBUG breadcrumbs. Rather than
// swap console.error per request (which races and mis-restores when two debug
// calls overlap), install ONE wrapper that fans each line out to every active
// trace buffer, ref-counted so ANIME_DEBUG stays on only while a capture is live.
const activeTraces = new Set<string[]>();
let traceInstalled = false;
let savedDebugEnv: string | undefined;
const fmtArg = (a: any) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
const beginTrace = (buf: string[]) => {
    if (!traceInstalled) {
        traceInstalled = true;
        savedDebugEnv = process.env.ANIME_DEBUG;
        process.env.ANIME_DEBUG = '1';
        const origErr = console.error.bind(console);
        (console as any).error = (...args: any[]) => { const line = args.map(fmtArg).join(' '); for (const b of activeTraces) b.push(line); origErr(...args); };
        (console as any).__spOrigErr = origErr;
    }
    activeTraces.add(buf);
};
const endTrace = (buf: string[]) => {
    activeTraces.delete(buf);
    if (!activeTraces.size && traceInstalled) {
        traceInstalled = false;
        if ((console as any).__spOrigErr) console.error = (console as any).__spOrigErr;
        if (savedDebugEnv === undefined) delete process.env.ANIME_DEBUG; else process.env.ANIME_DEBUG = savedDebugEnv;
    }
};

// ── LinkData for the resolver (shared by /sources/stream and /debug/provider) ──
// `season`/`episode` arrive in the numbering of the plan the client is showing (see
// planFor). Providers expect TMDB/aired numbering, so:
//   • AniList cour (anime): `season` is the cour index. absoluteEpisode = prior cours'
//     episodes + episode (from the PLAN, not TMDB); a DISTINCT renamed cour (Solo Leveling
//     S2 = "Arise from the Shadow") is handed over as its exact title + per-cour episode with
//     seasonResolved + that cour's AniList/MAL ids, so scrapers match by title and the id
//     providers ask for the right cour (not S1's id with S2's episode number);
//   • TVDB official/DVD order (cartoons): mapped back to aired S/E (planToAired);
//   • TMDB plan: anime absoluteEpisode from TMDB season counts.
async function buildLinkData(type: 'movie' | 'tv', id: number, season: number | undefined, episode: number | undefined, req: any): Promise<{ info: MetaData; linkData: LinkData } | null> {
    const info = await getTMDBInfo(id, type);
    if (!info) return null;
    let animeIds = info.isAnime ? await resolveAnimeIds(id, type, info.title, info.year?.toString(), info.originalTitle) : undefined;
    let title = info.title, orgTitle = info.originalTitle;
    let absoluteEpisode: number | undefined, animeSeasonTitles: string[] | undefined, seasonYear: number | undefined;
    let seasonResolved = false;
    const tmdbSeasons = (info.seasons || []).filter((s) => s.seasonNumber >= 1);
    if (type === 'tv' && season) {
        const plan = await planFor(req, id, info);
        if (plan.source === 'anilist') {
            const sn = season;
            const cour = plan.seasons.find((s) => s.seasonNumber === sn);
            const s1 = plan.seasons.find((s) => s.seasonNumber === 1);
            seasonYear = cour?.year;   // the cour's own year — TMDB season `season` is a different axis
            if (episode) {
                const prior = plan.seasons.filter((s) => s.seasonNumber < sn).reduce((sum, s) => sum + (s.episodeCount || 0), 0);
                if (prior > 0) absoluteEpisode = prior + episode;
            }
            if (cour?.titles?.length && cour.anilistId !== s1?.anilistId) {
                animeSeasonTitles = cour.titles;
                title = cour.titles[0];
                orgTitle = cour.titles[1] || orgTitle;
                seasonResolved = true;
                animeIds = { ...animeIds, titles: cour.titles, malId: cour.malId ?? animeIds?.malId, anilistId: cour.anilistId ?? animeIds?.anilistId };
            }
        } else {
            if (episode) ({ season, episode } = await planToAired(plan, season, episode));
            const sn = season;
            if (info.isAnime && sn > 1 && episode) {
                const prior = tmdbSeasons.filter((s) => s.seasonNumber < sn).reduce((sum, s) => sum + (s.episodeCount || 0), 0);
                if (prior > 0) absoluteEpisode = prior + episode;
            }
        }
        // Air year of the SELECTED season — lets per-season providers pick the right entry
        // (a series' seasons are often separate entries on the upstream site).
        const sn = season;
        if (!seasonYear) seasonYear = parseInt((tmdbSeasons.find((s) => s.seasonNumber === sn)?.airDate || '').slice(0, 4)) || undefined;
    }
    const linkData: LinkData = {
        id, imdbId: info.imdbId, type, season, episode, absoluteEpisode, animeSeasonTitles, seasonResolved,
        title, year: info.year, seasonYear, orgTitle,
        isAnime: info.isAnime, isCartoon: info.isCartoon, isAsian: info.isAsian, isBollywood: info.isBollywood, animeIds,
    };
    return { info, linkData };
}

// ── /debug/provider — run ONE provider and return its RAW output or error ─────
// Diagnoses why a specific provider yields nothing behind FlareSolverr/WARP, which
// the SSE stream can't show. Disabled unless DEBUG_TOKEN is set; send it as the
// X-Debug-Token header. Example:
//   curl -H "X-Debug-Token: $DEBUG_TOKEN" '/api/debug/provider?provider=allanime&type=tv&id=1234&season=1&episode=1&warp=all'
router.get('/debug/provider', async (req, res) => {
    if (!process.env.DEBUG_TOKEN || req.get('x-debug-token') !== process.env.DEBUG_TOKEN) return res.status(403).json({ error: 'forbidden' });
    const pid = req.query.provider as string;
    const type = req.query.type as 'movie' | 'tv';
    const id = int(req.query.id);
    const season = int(req.query.season);
    const episode = int(req.query.episode);
    const p = getProviders().find((x) => x.id === pid) || torrentProviders().find((x) => x.id === pid);
    if (!p) return res.status(404).json({ error: 'unknown provider', known: [...getProviders().map((x) => x.id), ...torrentProviders().map((x) => x.id)] });
    if ((type !== 'movie' && type !== 'tv') || !id) return res.status(400).json({ error: 'need type=movie|tv & id=<tmdbId>' });

    const trace: string[] = [];
    beginTrace(trace);
    try {
        const built = await buildLinkData(type, id, season, episode, req);
        if (!built) return res.json({ error: 'metadata not found for that id/type', trace });
        const { info, linkData } = built;
        const warpMode: WarpMode = normalizeWarpMode(req.query.warp as string);
        const t = Date.now();
        const r = await runWithWarp({ mode: warpMode, requiresWarp: p.requiresWarp }, () => p.invoke(linkData));
        res.json({
            provider: p.id, ms: Date.now() - t, warpMode, warpConfigured: warpConfigured(),
            resolved: { title: linkData.title, orgTitle: linkData.orgTitle, season: linkData.season, episode: linkData.episode, isAnime: info.isAnime, animeIds: linkData.animeIds },
            streamCount: (r.streams || []).length, streams: r.streams, subtitles: r.subtitles, trace,
        });
    } catch (e: any) {
        res.json({ provider: pid, error: String(e?.stack || e?.message || e).slice(0, 800), trace });
    } finally {
        endTrace(trace);
    }
});

// ── source ranking: probe → score → best ────────────────────────────────────
const PROBES_PER_PROVIDER = 4;          // links beyond this per provider stay verified:"unknown"
const BEST_GRACE_MS = 3500;             // wait this long after the first candidate for a better one
const UPGRADE_DELTA = 15;               // a later verified source must beat `best` by this to send `upgrade`
// URLs the client reported as failed (proxied URL → when): treated as verified:false for a
// while so a cached replay doesn't hand the same dead source back as `best`.
const BAD_URL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const badUrls = new Map<string, { at: number; count: number; reason: FailReason }>();   // at = last failed report
const isBadUrl = (u: string) => Date.now() - (badUrls.get(u)?.at || 0) < BAD_URL_MS;
/** failures{count24h,lastAt,lastReason}: client failure reports for this URL + a failed probe. */
const failuresOf = (l: any) => {
    const rep = badUrls.get(l.url);
    const out: { count24h: number; lastAt?: number; lastReason?: FailReason } = { count24h: 0 };
    if (rep && Date.now() - rep.at < DAY_MS) Object.assign(out, { count24h: rep.count, lastAt: rep.at, lastReason: rep.reason });
    if (l.verifyError) {
        out.count24h++;
        if (!out.lastAt || (l.verifiedAt || 0) > out.lastAt) Object.assign(out, { lastAt: l.verifiedAt, lastReason: failReason(l.verifyError) });
    }
    return out;
};

// No audio preference sent → prefer the title's original language, then English, so an
// English show doesn't auto-start on a German dub. (Anime is handled by sub/dub instead.)
const langName = (code?: string) => { try { return code ? new Intl.DisplayNames(['en'], { type: 'language' }).of(code) : undefined; } catch { return undefined; } };
const prefsOf = (req: any, isAnime?: boolean, originalLanguage?: string): ScorePrefs => {
    const asked = String(req.query.audio || '').split(',').map((a) => a.trim()).filter((a) => /^[A-Za-z ]{2,20}$/.test(a)).slice(0, 10);
    const fallback = isAnime ? [] : [...new Set([langName(originalLanguage), 'English'].filter((x): x is string => !!x))];
    return {
        audio: asked.length ? asked : fallback,
        anime: isAnime && (req.query.anime === 'sub' || req.query.anime === 'dub') ? req.query.anime : undefined,
    };
};
/** Attach live provider state (hidden, reliability, reported-bad) and the score. */
const rescore = (l: any, prefs: ScorePrefs) => {
    const verified = isBadUrl(l.url) ? false : l.verified;
    const st = providerStat(l.providerId);
    return {
        ...l, verified, hidden: st.hidden, browserPlayable: l.webReady !== false,
        startupMs: st.ttffMs || l.latencyMs,   // reported time-to-first-frame, else the probe's latency
        failures: failuresOf(l),
        score: scoreSource({ ...l, verified, hidden: st.hidden, reliability: st.reliability }, prefs),
    };
};
// Failed verification last, then hidden providers, then score.
const byRank = (a: any, b: any) => Number(a.verified === false) - Number(b.verified === false) || Number(a.hidden) - Number(b.hidden) || b.score - a.score;
const isCandidate = (l: any) => l.type !== 'iframe' && l.verified !== false && !l.hidden && l.webReady !== false;
const ranked = (links: any[]) => {
    const sorted = [...links].sort(byRank), rec = sorted.find(isCandidate);
    return { sources: sorted.map((l, i) => ({ url: l.url, providerId: l.providerId, score: l.score, rank: i + 1, verified: l.verified, hidden: l.hidden, recommended: l === rec })) };
};

/** Picks the auto-play source: `best` at once for a good verified source, else after a grace
 *  window (or at the end); later `upgrade` for a markedly better verified one. */
function bestPicker(send: (event: string, data: any) => void) {
    const pool: any[] = [];
    let sent: any, timer: NodeJS.Timeout | undefined, finished = false;
    const top = () => pool.filter(isCandidate).sort(byRank)[0];
    const emit = (reason: string) => {
        const b = top();
        if (sent || !b) return;
        sent = b; send('best', { type: 'best', source: { ...b, recommended: true }, reason });
    };
    return {
        pool,
        add(links: any[]) {
            pool.push(...links);
            if (finished) return;
            const b = top();
            if (!b) return;
            if (sent) {
                if (b.verified === true && b.url !== sent.url && b.score >= sent.score + UPGRADE_DELTA) { sent = b; send('upgrade', { type: 'upgrade', source: { ...b, recommended: true } }); }
                return;
            }
            if (b.verified === true && b.score >= GOOD_SCORE) return emit('good');
            timer ??= setTimeout(() => emit('grace'), BEST_GRACE_MS);
        },
        finish() { clearTimeout(timer); emit('done'); finished = true; },
    };
}

// Reports only count for streams this server actually handed out, once per client IP and
// stream — otherwise anyone could POST four fake "failed" reports and hide a provider for
// every user (provider ids are public).
const EMITTED_TTL = 2 * 60 * 60 * 1000;
const emitted = new Map<string, { provider: string; at: number }>();
const noteEmitted = (l: any) => {
    if (!l?.url || !l.providerId) return;
    if (emitted.size >= 20000) for (const [k, v] of emitted) if (Date.now() - v.at > EMITTED_TTL || emitted.size >= 20000) emitted.delete(k); else break;
    emitted.set(l.url, { provider: l.providerId, at: Date.now() });
};
const votes = new Map<string, number>();   // `${ip}|${url}` → at
const firstVote = (ip: string, url: string) => {
    const k = `${ip}|${url}`, now = Date.now();
    if (votes.size >= 20000) votes.clear();   // ponytail: crude bound; worst case one extra vote each
    const seen = votes.get(k);
    votes.set(k, now);
    return !seen || now - seen > EMITTED_TTL;
};

// Client playback feedback → provider playback reliability / hiding.
router.post('/sources/report', rateLimit(Number(process.env.SOURCE_REPORT_PER_MIN) || 30), (req, res) => {
    const known = new Set([...getProviders(), ...torrentProviders()].map((p) => p.id));
    const r = parseReport(req.body, known);
    if ('invalid' in r) return res.status(400).json({ ok: false, error: r.invalid });
    const e = r.url ? emitted.get(r.url) : undefined;
    if (!e || e.provider !== r.provider || Date.now() - e.at > EMITTED_TTL) return res.json({ ok: true, ignored: 'not a recently served stream' });
    if (!firstVote(req.ip || '', r.url!)) return res.json({ ok: true, ignored: 'already reported', hidden: providerHidden(r.provider) });
    recordPlayback(r.provider, r.outcome, r.ttffMs, r.error);
    if (r.url && r.outcome === 'played') badUrls.delete(r.url);
    else if (r.url && r.outcome === 'failed') {
        if (badUrls.size >= 5000) badUrls.clear();   // ponytail: crude memory bound
        const prev = badUrls.get(r.url), now = Date.now();
        badUrls.set(r.url, { at: now, count: prev && now - prev.at < DAY_MS ? prev.count + 1 : 1, reason: failReason(r.error) });
    }
    res.json({ ok: true, hidden: providerHidden(r.provider) });
});

// ── /sources/stream (SSE) ────────────────────────────────────────────────────
// Events: provider, link, subtitle, log, done + best / upgrade / ranked. Every link is
// probed for playability and scored before it's emitted (see utils/sourceProbe.ts).
router.get('/sources/stream', async (req, res) => {
    const type = req.query.type as 'movie' | 'tv';
    const id = int(req.query.id);
    const season = int(req.query.season);
    const episode = int(req.query.episode);
    if ((type !== 'movie' && type !== 'tv') || !id) return res.status(400).json({ error: 'need type=movie|tv & id' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    // Abort all in-flight provider/FlareSolverr work when the client disconnects so
    // an abandoned tab doesn't keep ~24 providers + FlareSolverr browsers busy for
    // the full PROVIDER_TIMEOUT_MS (which starves the pool for the next request).
    const ac = new AbortController();
    req.on('close', () => { closed = true; ac.abort(); });
    const send = (event: string, data: any) => { if (!closed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    // Optional subset: re-scan only these provider ids (used by the "refresh failed"
    // button). A subset scan always bypasses the cache and never overwrites it.
    const onlyProviders = ((req.query.providers as string) || '').split(',').map((s) => s.trim()).filter(Boolean);
    // Torrent mode: hide the scrapers and resolve via the torrent provider only.
    const torrentMode = req.query.torrent === '1';

    // Fast path: replay a recent resolve instead of re-running every provider.
    const cacheKey = sourceCacheKey(type, id, season, episode, req.query.src) + (torrentMode ? ':t' : '');
    const cached = sourceCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SOURCE_CACHE_TTL && req.query.fresh !== '1' && !onlyProviders.length) {
        send('log', { msg: 'Loaded cached sources.' });
        // Re-score on replay: preferences and provider health may differ from when it was cached.
        const prefs = prefsOf(req, cached.isAnime, cached.originalLanguage);
        const links = cached.events.filter((ev) => ev.e === 'link').map((ev) => rescore(ev.d, prefs)).sort(byRank).map((l, i) => ({ ...l, rank: i + 1 }));
        const best = links.find(isCandidate);
        if (best) best.recommended = true;
        for (const ev of cached.events) {
            if (ev.e === 'provider') send('provider', { ...ev.d, hidden: ev.d.state === 'circuit-broken' || providerHidden(ev.d.id) });
            else if (ev.e !== 'link' && ev.e !== 'done') send(ev.e, ev.d);
        }
        links.forEach((l) => { noteEmitted(l); send('link', l); });
        const nProv = cached.events.filter((ev) => ev.e === 'provider').length;
        send('progress', { total: nProv, settled: nProv, done: true });
        if (best) send('best', { type: 'best', source: best, reason: 'cached' });
        send('ranked', ranked(links));
        send('done', {});
        return res.end();
    }
    // Record the resolvable events (everything but transient logs) so we can cache them.
    const recorded: { e: string; d: any }[] = [];
    const rsend = (event: string, data: any) => { if (event !== 'log') recorded.push({ e: event, d: data }); send(event, data); };
    const picker = bestPicker(send);

    try {
        send('log', { msg: 'Resolving metadata…' });
        // Not under the tab's abort signal: the season plan build is SHARED (deduped with
        // /title), so a closed tab must not abort it and cache a degraded TMDB plan.
        const built = await buildLinkData(type, id, season, episode, req);
        if (!built) { send('log', { msg: 'Metadata not found.' }); send('done', {}); return res.end(); }
        const { info, linkData } = built;
        const prefs = prefsOf(req, info.isAnime, info.originalLanguage);

        // Only run providers that serve THIS content kind — an anime title shouldn't
        // wake the Indian movie scrapers (each a slow FlareSolverr solve), and a movie
        // shouldn't wake the anime providers. Generic id-based providers serve all kinds.
        // Cartoons (Ben 10 etc.) resolve as 'series'/'movie' so they get AnimeWorld
        // (all-kinds) AND the series/movie scrapers — not a narrower cartoon bucket.
        const kind: ContentKind = info.isAnime ? 'anime' : info.isAsian ? 'asian' : (type === 'movie' ? 'movie' : 'series');
        let providers = torrentMode
            ? torrentProviders().filter((p) => !p.kinds || p.kinds.includes(kind))
            : getProvidersForKind(kind);
        if (onlyProviders.length) providers = providers.filter((p) => onlyProviders.includes(p.id));
        // Circuit breaker: skip providers that have been failing/timing out repeatedly so
        // they stop wasting a FlareSolverr slot + PROVIDER_TIMEOUT_MS on every open. A
        // targeted re-scan (onlyProviders, the "refresh failed" button) bypasses this so
        // the user can always force a retry. A half-open probe (in providerShouldRun)
        // auto-revives a recovered provider.
        // Breaker-skipped providers are still announced (state circuit-broken, hidden) so the
        // UI can count them under "N unavailable".
        else {
            const all = providers; providers = [];
            for (const p of all) {
                if (providerShouldRun(p.id)) { providers.push(p); continue; }
                rsend('provider', { id: p.id, name: p.name, state: 'circuit-broken', durationMs: 0, links: [], priorityScore: 0, hidden: true, note: 'skipped: failing repeatedly, auto-retries after a cool-down' });
            }
        }
        // Chronically unplayable (hidden) providers start last.
        providers.sort((a, b) => Number(providerHidden(a.id)) - Number(providerHidden(b.id)));
        send('log', { msg: torrentMode ? 'Searching torrents…' : `Fanning out across ${providers.length} ${kind} providers…` });

        // WARP proxy mode for this request (Settings → falls back to server default).
        const warpMode: WarpMode = normalizeWarpMode(req.query.warp as string);

        const TIMEOUT = Number(process.env.PROVIDER_TIMEOUT_MS) || 45000;
        const TIMED_OUT = Symbol('timeout');
        // Scan progress for "Still looking: checked 14 of 36" (breaker-skipped providers excluded).
        let settled = 0;
        send('progress', { total: providers.length, settled, done: false });
        await Promise.all(providers.map(async (p) => {
            send('provider', { id: p.id, name: p.name, state: 'running', links: [], priorityScore: 0, hidden: providerHidden(p.id) });
            const t = Date.now();
            // Per-provider signal: aborted when the tab closes OR when this provider is done
            // (incl. timed out) — otherwise a timed-out provider keeps holding its
            // FlareSolverr/WARP slot until its own requests give up.
            const pac = new AbortController();
            const signal = AbortSignal.any([ac.signal, pac.signal]);
            try {
                let r = await runWithSignal(signal, () => runWithWarp(
                    { mode: warpMode, requiresWarp: p.requiresWarp },
                    () => withTimeout<any>(p.invoke(linkData), TIMEOUT, TIMED_OUT),
                ));
                const timedOut = r === TIMED_OUT;
                if (timedOut) r = { streams: [], subtitles: [] };
                // `fallback` mode: if a provider came back empty (not timed out), give
                // it one more go routed through WARP (a clean egress often unblocks it).
                if (warpMode === 'fallback' && warpConfigured() && !closed && !timedOut && !(r.streams || []).length) {
                    send('log', { msg: `${p.name}: retrying via WARP…` });
                    r = await runWithSignal(signal, () => runWithWarp(
                        { mode: warpMode, forceWarp: true },
                        () => withTimeout(p.invoke(linkData), TIMEOUT, { streams: [], subtitles: [] }),
                    ));
                }
                const durationMs = Date.now() - t;
                // Probe each link (HLS master → variant → segment bytes; MP4 ranged GET) before
                // emitting it, so every link carries verified/latencyMs/real quality + score.
                let probed = false, anyOk = false;
                const ep = (linkData.animeSeasonTitles?.length ? linkData.episode : linkData.absoluteEpisode) ?? linkData.episode;
                const links = (await Promise.all((r.streams || [])
                    .filter((s: Stream) => typeof s.link === 'string' && s.link)   // guard: a non-string link would crash proxify's Buffer.from
                    .map(async (s: Stream, i: number) => {
                        const label = `${s.server || ''} ${s.quality || ''} ${(s as any).description || ''}`;
                        const url = proxify(s, ep);
                        const audio = detectAudio(`${s.server || ''} ${s.audioName || ''}`);
                        const l: any = {
                            id: createHash('sha1').update(url).digest('hex').slice(0, 16), providerId: p.id, providerName: p.name, variant: s.server,
                            name: s.server, url, type: s.type, external: /\bvlc\b/i.test(label),
                            audioTracks: audioTracks(`${label} ${s.audioName || ''}`, audio, info.isAnime),
                            quality: qualityNum(s) || undefined, playable: s.type !== 'iframe', host: hostOf(s.link),
                            audio: audio || undefined, verified: 'unknown',
                            // the URL path counts too: CDNs file HEVC under /h265/, names end .mkv
                            webReady: webReadyOf(`${label} ${s.link.split('?')[0]}`, undefined, (s as any).notWebReady), mbps: mbpsOf(label),
                        };
                        if (!torrentMode && s.type !== 'iframe' && !s.link.startsWith('magnet:') && i < PROBES_PER_PROVIDER) {
                            const pr = await probeStream(s.link, s.type, s.headers);
                            if (!pr.inconclusive) { probed = true; anyOk ||= pr.ok; }
                            l.verified = pr.inconclusive ? 'unknown' : pr.ok; l.latencyMs = pr.latencyMs; l.kbps = pr.kbps; l.verifiedAt = pr.at;
                            if (pr.height) l.quality = pr.height;   // the playlist's advertised max beats the label
                            if (!pr.ok) l.verifyError = pr.error;
                            if (pr.format === 'mkv' || pr.hevc) l.webReady = false;
                            if (pr.hevc) l.codec = 'hevc';
                        }
                        return rescore(l, prefs);
                    }))).sort(byRank);
                if (!closed && probed) recordVerify(p.id, anyOk);
                links.forEach((l: any) => { noteEmitted(l); rsend('link', l); });
                picker.add(links);
                (r.subtitles || []).forEach((sub: any) => rsend('subtitle', { providerId: p.id, lang: sub.language, url: subProxy(sub.url, sub.headers) }));
                const best = links.reduce((m: number, l: any) => Math.max(m, l.quality || 0), 0);
                // A timeout is reported as `failed` with a reason so it's visible in the
                // UI (previously indistinguishable from a genuine "no sources").
                const state = links.length ? 'found' : timedOut ? 'failed' : 'empty';
                const note = timedOut ? `timed out after ${Math.round(durationMs / 1000)}s` : undefined;
                // Feed the health/circuit-breaker (skip aborted runs — a closed tab isn't a failure).
                if (!closed && !torrentMode) recordProvider(p.id, state, durationMs);
                rsend('provider', { id: p.id, name: p.name, state, durationMs, links, priorityScore: best, note, hidden: providerHidden(p.id), reliability: providerStat(p.id).reliability });
                send('log', { msg: `${p.name}: ${timedOut ? 'timed out' : `${links.length} link${links.length === 1 ? '' : 's'}`} (${durationMs}ms)` });
            } catch (e: any) {
                if (!closed && !torrentMode) recordProvider(p.id, 'failed', Date.now() - t);
                rsend('provider', { id: p.id, name: p.name, state: 'failed', durationMs: Date.now() - t, links: [], priorityScore: 0, note: String(e?.message || e).slice(0, 80), hidden: providerHidden(p.id) });
            } finally {
                pac.abort();
                send('progress', { total: providers.length, settled: ++settled, done: false });
            }
        }));

        picker.finish();
        send('progress', { total: providers.length, settled, done: true });
        send('ranked', ranked(picker.pool));
        rsend('done', {});
        // Cache a COMPLETE resolve that actually produced sources (skip aborted /
        // all-empty runs, and subset re-scans, so we never serve a bad/partial result).
        if (!closed && !onlyProviders.length && recorded.some((x) => x.e === 'link')) {
            if (sourceCache.size >= SOURCE_CACHE_MAX) {
                let oldestKey: string | undefined; let oldestAt = Infinity;
                for (const [k, v] of sourceCache) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
                if (oldestKey) sourceCache.delete(oldestKey);
            }
            sourceCache.set(cacheKey, { at: Date.now(), isAnime: info.isAnime, originalLanguage: info.originalLanguage, events: recorded });
        }
        res.end();
    } catch (e: any) {
        picker.finish();
        send('log', { msg: `Resolver error: ${e?.message || e}` });
        send('done', {});
        res.end();
    }
});

export default router;
