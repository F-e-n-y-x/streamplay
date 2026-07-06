import { Router } from 'express';
import axios from 'axios';
import { tmdbGet, tmdbImg, tmdbIsLive, getTMDBInfo } from '../tmdb';
import { getProviders, getProvidersForKind, torrentProviders } from '../extractors';
import { providerDomains } from '../providersList';
import { resolveAnimeIds } from '../anime';
import { anilistBrowse, anilistTitleVariants } from '../anilist';
import { seasonPlan, planEpisodes } from '../meta';
import { tvdbEnabled } from '../utils/tvdb';
import { LinkData, Stream, ContentKind } from '../types';
import { b64 } from './proxy';
import { runWithWarp, normalizeWarpMode, warpConfigured, warpConfig, probeWarpSocks, WarpMode } from '../utils/warp';
import { runWithSignal } from '../utils/reqctx';
import { flareSolverrEndpoints, probeFlareSolverr, flareSolverrLoad } from '../utils/flaresolverr';
import { recordProvider, providerShouldRun, providerStat, providerPriority } from '../utils/providerStats';
import { torznabPublic, setTorznab } from '../utils/serverConfig';
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
// TVDB drives season/episode data for cartoons + Indian TV series when a key is configured.
const tvdbActiveFor = (info: any): boolean => tvdbEnabled() && !info?.isAnime && (info?.isCartoon || isIndian(info?.originalLanguage, info?.isBollywood));

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

/**
 * Dub heuristic: TMDB has no dub-availability data, so we approximate by
 * popularity — established/popular anime are almost always dubbed, while
 * new/niche seasonal titles are sub-only. Tunable.
 */
const DUB_VOTE_THRESHOLD = 500;

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
const subProxy = (url: string): string => `/api/proxy/sub?url=${b64(url)}`;
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
    if (!list.length && anilistId) {
        const info = await anilistTitleVariants(anilistId);
        if (info) { list = info.titles; ty = ty || info.type; yr = yr ?? info.year; }
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
            try { d = await tmdbGet(`/search/${st}`, { query: t }); } catch { continue; }
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
    if (anilistId) { if (aniTmdb.size >= ANI_TMDB_MAX) aniTmdb.clear(); aniTmdb.set(anilistId, best); }
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
router.get('/search', async (req, res) => {
    const q = (req.query.q as string) || '';
    const page = parseInt((req.query.page as string) || '1');
    if (!q.trim()) return res.json({ items: [], page: 1, totalPages: 0 });
    try {
        const showAdult = adultOf(req);
        const data = await tmdbGet('/search/multi', { query: q, language: langOf(req), include_adult: showAdult, page });
        const items = (data.results || [])
            .filter((it: any) => (it.media_type === 'movie' || it.media_type === 'tv') && (showAdult || !isAdultItem(it)))
            .map((it: any) => toCard(it));
        res.json({ items, page: data.page || 1, totalPages: data.total_pages || 1 });
    } catch (e: any) {
        res.status(500).json({ items: [], page: 1, totalPages: 0, error: e?.message });
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

// Anime categories (MAL/AniList-style). Genre where TMDB has one, else a keyword.
const ANIME_CATEGORIES: Record<string, { movie?: number; tv?: number; kw?: string }> = {
    action: { movie: 28, tv: 10759 }, adventure: { movie: 12, tv: 10759 }, cars: { kw: 'racing' },
    comedy: { movie: 35, tv: 35 }, dementia: { kw: 'psychological' }, demons: { kw: 'demon' },
    drama: { movie: 18, tv: 18 }, ecchi: { kw: 'ecchi' }, fantasy: { movie: 14, tv: 10765 },
    game: { kw: 'video game' }, harem: { kw: 'harem' }, historical: { kw: 'historical' },
    horror: { movie: 27, kw: 'horror' }, isekai: { kw: 'isekai' }, josei: { kw: 'josei' },
    kids: { tv: 10762, kw: 'children' }, magic: { kw: 'magic' }, mahoushoujo: { kw: 'magical girl' },
    martialarts: { kw: 'martial arts' }, mecha: { kw: 'mecha' }, military: { kw: 'military' },
    music: { movie: 10402, kw: 'music' }, mystery: { movie: 9648, tv: 9648 }, parody: { kw: 'parody' },
    police: { kw: 'police' }, psychological: { kw: 'psychological' }, romance: { movie: 10749, kw: 'romance' },
    samurai: { kw: 'samurai' }, school: { kw: 'school life' }, scifi: { movie: 878, tv: 10765 },
    seinen: { kw: 'seinen' }, shoujo: { kw: 'shoujo' }, shoujoai: { kw: 'yuri' }, shounen: { kw: 'shounen' },
    shounenai: { kw: 'yaoi' }, sliceoflife: { kw: 'slice of life' }, space: { kw: 'space' },
    sports: { kw: 'sports' }, superpower: { kw: 'superhero' }, supernatural: { kw: 'supernatural' },
    suspense: { kw: 'suspense' }, thriller: { movie: 53, kw: 'thriller' }, vampire: { kw: 'vampire' },
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

const rangeStart = (range: string): string | undefined => {
    const d = new Date();
    if (range === 'day') d.setDate(d.getDate() - 1);
    else if (range === 'week') d.setDate(d.getDate() - 7);
    else if (range === 'month') d.setMonth(d.getMonth() - 1);
    else if (range === 'year') d.setFullYear(d.getFullYear() - 1);
    else return undefined; // all-time
    return d.toISOString().slice(0, 10);
};

const buildDiscover = (kind: 'tv' | 'movie', olang: string | undefined, cat: string, range: string, page: number, language: string, sec: SectionDef, audio?: string, adult = false, genreId?: number, withoutKeywords?: string, withKeyword?: number): Record<string, any> => {
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
    // Anime Sub/Dub heuristic (popularity proxy — see DUB_VOTE_THRESHOLD).
    if (sec.withGenres === ANIME_GENRE && audio) {
        if (audio === 'dub') p['vote_count.gte'] = Math.max(p['vote_count.gte'] || 0, DUB_VOTE_THRESHOLD);
        else if (audio === 'sub') p['vote_count.lte'] = DUB_VOTE_THRESHOLD;
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
    const page = parseInt((req.query.page as string) || '1');
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
                id: m.anilistId, type: m.type, title: m.title,
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
                const catMap = section === 'anime' ? ANIME_CATEGORIES : CATEGORY_GENRES;
                for (const c of cats) {
                    const def = catMap[c];
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
            const data = await tmdbGet(k === 'movie' ? '/discover/movie' : '/discover/tv', buildDiscover(k, l, cat, range, page, language, sec, audio, adultOf(req), genreId, withoutKeywords, keywordId));
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

        const items = merged.slice(0, 24).map((it) => toCard(it, it.__kind));
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
    const al = parseInt(req.query.al as string) || 0;
    let titles: string[] = [];
    try { const raw = req.query.titles as string; if (raw) { const j = JSON.parse(raw); if (Array.isArray(j)) titles = j.map(String); } } catch { /* */ }
    const year = req.query.year ? parseInt(req.query.year as string) : undefined;
    const type = req.query.type === 'movie' ? 'movie' : req.query.type === 'tv' ? 'tv' : undefined;
    if (!al && !titles.length) return res.status(400).json({ error: 'need al or titles' });
    const r = await resolveAnimeToTmdb(al, titles, year, type as any);
    if (!r) return res.status(404).json({ error: 'no matching TMDB entry' });
    res.json({ ...r, anilistId: al || undefined });
});

// ── /title/:type/:id ─────────────────────────────────────────────────────────
router.get('/title/:type/:id', async (req, res) => {
    const type = req.params.type as 'movie' | 'tv';
    const id = req.params.id;
    if (type !== 'movie' && type !== 'tv') return res.status(400).json({ error: 'bad type' });
    try {
        const d = await tmdbGet(`/${type}/${id}`, {
            language: langOf(req),
            append_to_response: 'credits,recommendations,videos,external_ids',
        });
        const genres = (d.genres || []).map((g: any) => g.name);
        const lang = d.original_language;
        const isAnime = genres.includes('Animation') && (lang === 'ja' || lang === 'zh');
        const isCartoon = genres.includes('Animation') && !isAnime;
        const isAsian = !isAnime && ['ko', 'zh', 'ja', 'th'].includes(lang);
        const isBollywood = (d.production_countries || []).some((c: any) => c.iso_3166_1 === 'IN' || c.name === 'India');

        // Better season structure than TMDB for anime (AniList cours) and cartoons/
        // series (TheTVDB). Falls back to TMDB seasons when the plan is 'tmdb'.
        let seasons = (d.seasons || []).filter((s: any) => s.season_number > 0).map((s: any) => ({
            seasonNumber: s.season_number, name: s.name, episodeCount: s.episode_count,
        }));
        let metaSource = 'tmdb';
        if (type === 'tv') {
            try {
                // Bounded so a slow/rate-limited AniList never stalls the title page — degrade to TMDB.
                const plan = await withTimeout(
                    seasonPlan({ id: d.id, type, title: d.name || d.title, year: parseInt((d.first_air_date || '').slice(0, 4)) || undefined, imdbId: d.external_ids?.imdb_id, orgTitle: d.original_name || d.original_title, isAnime, isCartoon, indian: isIndian(lang, isBollywood) }),
                    9000, { source: 'tmdb' as const, seasons: [] },
                );
                if (plan.source !== 'tmdb' && plan.seasons.length) {
                    seasons = plan.seasons.map((s) => ({ seasonNumber: s.seasonNumber, name: s.name, episodeCount: s.episodeCount, anilistId: (s as any).anilistId }));
                    metaSource = plan.source;
                }
            } catch { /* keep TMDB seasons */ }
        }

        res.json({
            id: d.id,
            type,
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
            metaSource,
            classification: { isAnime, isAsian, isBollywood, isCartoon },
        });
    } catch (e: any) {
        res.status(404).json({ error: e?.message || 'not found' });
    }
});

// ── /title/tv/:id/season/:n ──────────────────────────────────────────────────
router.get('/title/tv/:id/season/:n', async (req, res) => {
    const id = Number(req.params.id);
    const n = Number(req.params.n);
    // Prefer the AniList/TVDB plan (matches the seasons /title returned); fall back to TMDB.
    try {
        const info = await getTMDBInfo(id, 'tv');
        // Include the Indian branch even without TVDB — CastleTV can supply the episode
        // list for daily soaps. Otherwise /title (Castle plan) and /season disagree.
        if (info && (info.isAnime || info.isCartoon || tvdbActiveFor(info) || isIndian(info.originalLanguage, info.isBollywood))) {
            const plan = await seasonPlan({ id, type: 'tv', title: info.title, year: info.year, imdbId: info.imdbId, orgTitle: info.originalTitle, isAnime: info.isAnime, isCartoon: info.isCartoon, indian: isIndian(info.originalLanguage, info.isBollywood) });
            if (plan.source !== 'tmdb') {
                const eps = await planEpisodes(plan, n);
                if (eps && eps.length) {
                    return res.json({ seasonNumber: n, episodes: eps.map((e) => ({ id: `${id}-${e.seasonNumber}-${e.episodeNumber}`, name: e.name, overview: e.overview, stillUrl: e.stillUrl, episodeNumber: e.episodeNumber, seasonNumber: e.seasonNumber, airDate: e.airDate })) });
                }
                // Plan exists but no per-episode detail: return a BARE numbered list from the
                // plan's episodeCount. Do NOT fall back to tmdbGet(/season/n) — here `n` is the
                // AniList cour / TVDB-order index, NOT a TMDB season number, so TMDB would
                // return the wrong season entirely.
                const ps = plan.seasons.find((s) => s.seasonNumber === n);
                const count = ps?.episodeCount || 0;
                const bare = Array.from({ length: count }, (_v, i) => ({ id: `${id}-${n}-${i + 1}`, episodeNumber: i + 1, seasonNumber: n }));
                return res.json({ seasonNumber: n, episodes: bare });
            }
        }
    } catch { /* fall through to TMDB */ }
    try {
        const data = await tmdbGet(`/tv/${id}/season/${n}`, { language: langOf(req) });
        const episodes = (data.episodes || []).map((e: any) => ({
            id: e.id, name: e.name, overview: e.overview, stillUrl: tmdbImg(e.still_path, 'w300'),
            episodeNumber: e.episode_number, seasonNumber: e.season_number,
            voteAverage: e.vote_average || undefined, airDate: e.air_date,
        }));
        res.json({ seasonNumber: n, episodes });
    } catch (e: any) {
        res.status(404).json({ seasonNumber: n, episodes: [], error: e?.message });
    }
});

// ── /skip-times — AniSkip OP/ED intervals for an anime episode ────────────────
// Resolves the title's MAL id (via the cached anime resolver) then queries the
// AniSkip API (https://github.com/aniskip/aniskip-api). Returns opening/ending
// intervals in seconds, or nulls for non-anime / unknown episodes.
router.get('/skip-times', async (req, res) => {
    const empty = { opening: null as null | { start: number; end: number }, ending: null as null | { start: number; end: number } };
    try {
        const id = parseInt(req.query.id as string);
        const type = req.query.type as 'movie' | 'tv';
        const episode = parseInt(req.query.episode as string) || 1;
        const season = req.query.season ? parseInt(req.query.season as string) : undefined;
        const length = parseInt(req.query.length as string) || 0;
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
                const plan = await seasonPlan({ id, type, title: info.title, year: info.year, imdbId: info.imdbId, orgTitle: info.originalTitle, isAnime: true });
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
const KIND_OF = (id: string): string => {
    if (/sub|wyzie/i.test(id)) return 'subtitles';
    if (/anime|hianime|pahe|kick|reanime|anizone|animeworld|tosho/i.test(id)) return 'anime';
    if (/kisskh/i.test(id)) return 'asian';
    if (/castle|bolly|rog|hdhub|4khdhub|vega|movies4u|uhd|moviesmod|topmovies|multimovies/i.test(id)) return 'multi';
    return 'movie';
};
const hostFor = (id: string): string => {
    const d = providerDomains.find((p) => p.id === id);
    return d ? d.url.replace(/^https?:\/\//, '') : '';
};
router.get('/providers', (_req, res) => {
    const list = getProviders().map((p) => ({
        id: p.id, name: p.name, kind: KIND_OF(p.id), host: hostFor(p.id), needsToken: false,
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
// otherwise (personal use). The API key is never returned to the client.
const configAuthed = (req: any): boolean => !process.env.ADMIN_TOKEN || req.query.token === process.env.ADMIN_TOKEN || req.headers['x-admin-token'] === process.env.ADMIN_TOKEN;
router.get('/config', (_req, res) => {
    res.json({ torznab: torznabPublic(), adminLock: !!process.env.ADMIN_TOKEN });
});
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
interface SourceCacheEntry { at: number; events: { e: string; d: any }[] }
const SOURCE_CACHE_TTL = 8 * 60 * 1000;   // 8 minutes
const SOURCE_CACHE_MAX = 500;
const sourceCache = new Map<string, SourceCacheEntry>();
const sourceCacheKey = (type: string, id: number, season?: number, episode?: number) => `${type}:${id}:${season ?? ''}:${episode ?? ''}`;

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

// ── /debug/provider — run ONE provider and return its RAW output or error ─────
// Diagnoses why a specific provider yields nothing behind FlareSolverr/WARP, which
// the SSE stream can't show. Example:
//   /api/debug/provider?provider=allanime&type=tv&id=1234&season=1&episode=1&warp=all
// Optional: set DEBUG_TOKEN in the env to require ?token=… (locks this diagnostic
// down on a public instance without affecting the normal client).
router.get('/debug/provider', async (req, res) => {
    if (process.env.DEBUG_TOKEN && req.query.token !== process.env.DEBUG_TOKEN) return res.status(403).json({ error: 'forbidden' });
    const pid = req.query.provider as string;
    const type = req.query.type as 'movie' | 'tv';
    const id = parseInt(req.query.id as string);
    const season = req.query.season ? parseInt(req.query.season as string) : undefined;
    const episode = req.query.episode ? parseInt(req.query.episode as string) : undefined;
    const p = getProviders().find((x) => x.id === pid) || torrentProviders().find((x) => x.id === pid);
    if (!p) return res.status(404).json({ error: 'unknown provider', known: [...getProviders().map((x) => x.id), ...torrentProviders().map((x) => x.id)] });
    if ((type !== 'movie' && type !== 'tv') || !id) return res.status(400).json({ error: 'need type=movie|tv & id=<tmdbId>' });

    const trace: string[] = [];
    beginTrace(trace);
    const restore = () => endTrace(trace);

    try {
        const info = await getTMDBInfo(id, type);
        if (!info) { restore(); return res.json({ error: 'metadata not found for that id/type', trace }); }
        let animeIds;
        if (info.isAnime) animeIds = await resolveAnimeIds(id, type, info.title, info.year?.toString(), info.originalTitle);
        let seasonYear: number | undefined;
        if (type === 'tv' && season) {
            try { const sd = await tmdbGet(`/tv/${id}/season/${season}`, {}); const d = sd?.air_date || sd?.episodes?.[0]?.air_date; if (d) seasonYear = parseInt(String(d).slice(0, 4)) || undefined; } catch { /* */ }
        }
        const linkData: LinkData = { id, imdbId: info.imdbId, type, season, episode, title: info.title, year: info.year, seasonYear, orgTitle: info.originalTitle, isAnime: info.isAnime, isCartoon: info.isCartoon, isAsian: info.isAsian, isBollywood: info.isBollywood, animeIds };
        const warpMode: WarpMode = normalizeWarpMode(req.query.warp as string);
        const t = Date.now();
        const r = await runWithWarp({ mode: warpMode, requiresWarp: p.requiresWarp }, () => p.invoke(linkData));
        restore();
        res.json({
            provider: p.id, ms: Date.now() - t, warpMode, warpConfigured: warpConfigured(),
            resolved: { title: info.title, orgTitle: info.originalTitle, isAnime: info.isAnime, animeIds },
            streamCount: (r.streams || []).length, streams: r.streams, subtitles: r.subtitles, trace,
        });
    } catch (e: any) {
        restore();
        res.json({ provider: pid, error: String(e?.stack || e?.message || e).slice(0, 800), trace });
    }
});

// ── /sources/stream (SSE) ────────────────────────────────────────────────────
router.get('/sources/stream', async (req, res) => {
    const type = req.query.type as 'movie' | 'tv';
    const id = parseInt(req.query.id as string);
    const season = req.query.season ? parseInt(req.query.season as string) : undefined;
    const episode = req.query.episode ? parseInt(req.query.episode as string) : undefined;

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
    const cacheKey = sourceCacheKey(type, id, season, episode) + (torrentMode ? ':t' : '');
    const cached = sourceCache.get(cacheKey);
    if (cached && Date.now() - cached.at < SOURCE_CACHE_TTL && req.query.fresh !== '1' && !onlyProviders.length) {
        send('log', { msg: 'Loaded cached sources.' });
        for (const ev of cached.events) send(ev.e, ev.d);
        return res.end();
    }
    // Record the resolvable events (everything but transient logs) so we can cache them.
    const recorded: { e: string; d: any }[] = [];
    const rsend = (event: string, data: any) => { if (event !== 'log') recorded.push({ e: event, d: data }); send(event, data); };

    try {
        send('log', { msg: 'Resolving metadata…' });
        const info = await getTMDBInfo(id, type);
        if (!info) { send('log', { msg: 'Metadata not found.' }); send('done', {}); return res.end(); }

        let animeIds;
        if (info.isAnime) animeIds = await resolveAnimeIds(id, type, info.title, info.year?.toString(), info.originalTitle);

        // Air year of the SELECTED season — lets per-season providers pick the right
        // entry (a series' seasons are often separate entries on the upstream site).
        let seasonYear: number | undefined;
        if (type === 'tv' && season) {
            try {
                const sd = await tmdbGet(`/tv/${id}/season/${season}`, {});
                const d = sd?.air_date || sd?.episodes?.[0]?.air_date;
                if (d) seasonYear = parseInt(String(d).slice(0, 4)) || undefined;
            } catch { /* fall back to no season year */ }
        }

        // Anime S2+ handling (one place). The `season` param is the AniList cour index the
        // /title page returned — NOT a TMDB season number — so:
        //   • absoluteEpisode (for series-wide-numbered batch releases) = sum of PRIOR cours'
        //     episode counts + episode, taken from the AniList PLAN (not TMDB seasons);
        //   • a DISTINCT renamed cour (Solo Leveling S2 = "Arise from the Shadow") is handed to
        //     every anime provider as its exact title + per-cour episode, with seasonResolved
        //     so scrapers match by title instead of guessing "season N" from text.
        // Only when AniList is unavailable do we fall back to TMDB season counts (the /title
        // page is then showing TMDB seasons too, so the axes match).
        let absoluteEpisode: number | undefined;
        let animeSeasonTitles: string[] | undefined;
        let title = info.title;
        let orgTitle = info.originalTitle;
        let seasonResolved = false;
        if (info.isAnime && type === 'tv' && season && season > 1 && episode) {
            try {
                const plan = animeIds?.anilistId
                    ? await seasonPlan({ id, type, title: info.title, year: info.year, imdbId: info.imdbId, orgTitle: info.originalTitle, isAnime: true })
                    : { source: 'tmdb' as const, seasons: [] };
                if (plan.source === 'anilist') {
                    const prior = plan.seasons.filter((s) => s.seasonNumber < season).reduce((sum, s) => sum + (s.episodeCount || 0), 0);
                    if (prior > 0) absoluteEpisode = prior + episode;
                    const cour = plan.seasons.find((s) => s.seasonNumber === season);
                    const s1 = plan.seasons.find((s) => s.seasonNumber === 1);
                    if (cour?.titles?.length && cour.anilistId !== s1?.anilistId) {
                        animeSeasonTitles = cour.titles;
                        title = cour.titles[0];
                        orgTitle = cour.titles[1] || orgTitle;
                        seasonResolved = true;
                        animeIds = { ...animeIds, titles: cour.titles, malId: cour.malId ?? animeIds?.malId };
                    }
                } else {
                    const det = await tmdbGet(`/tv/${id}`, {});
                    const prior = (det?.seasons || [])
                        .filter((s: any) => s.season_number >= 1 && s.season_number < season)
                        .reduce((sum: number, s: any) => sum + (s.episode_count || 0), 0);
                    if (prior > 0) absoluteEpisode = prior + episode;
                }
            } catch { /* fall back to base title + season-scoring */ }
        }

        const linkData: LinkData = {
            id, imdbId: info.imdbId, type, season, episode, absoluteEpisode, animeSeasonTitles, seasonResolved,
            title, year: info.year, seasonYear, orgTitle,
            isAnime: info.isAnime, isCartoon: info.isCartoon, isAsian: info.isAsian, isBollywood: info.isBollywood, animeIds,
        };

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
        else providers = providers.filter((p) => providerShouldRun(p.id));
        send('log', { msg: torrentMode ? 'Searching torrents…' : `Fanning out across ${providers.length} ${kind} providers…` });

        // WARP proxy mode for this request (Settings → falls back to server default).
        const warpMode: WarpMode = normalizeWarpMode(req.query.warp as string);

        const TIMEOUT = Number(process.env.PROVIDER_TIMEOUT_MS) || 45000;
        const TIMED_OUT = Symbol('timeout');
        await Promise.all(providers.map(async (p) => {
            send('provider', { id: p.id, name: p.name, state: 'running', links: [], priorityScore: 0 });
            const t = Date.now();
            try {
                let r = await runWithSignal(ac.signal, () => runWithWarp(
                    { mode: warpMode, requiresWarp: p.requiresWarp },
                    () => withTimeout<any>(p.invoke(linkData), TIMEOUT, TIMED_OUT),
                ));
                const timedOut = r === TIMED_OUT;
                if (timedOut) r = { streams: [], subtitles: [] };
                // `fallback` mode: if a provider came back empty (not timed out), give
                // it one more go routed through WARP (a clean egress often unblocks it).
                if (warpMode === 'fallback' && warpConfigured() && !closed && !timedOut && !(r.streams || []).length) {
                    send('log', { msg: `${p.name}: retrying via WARP…` });
                    r = await runWithSignal(ac.signal, () => runWithWarp(
                        { mode: warpMode, forceWarp: true },
                        () => withTimeout(p.invoke(linkData), TIMEOUT, { streams: [], subtitles: [] }),
                    ));
                }
                const links = (r.streams || [])
                    .filter((s: Stream) => typeof s.link === 'string' && s.link)   // guard: a non-string link would crash proxify's Buffer.from
                    .map((s: Stream) => ({
                        providerId: p.id, name: s.server, url: proxify(s, (linkData.animeSeasonTitles?.length ? linkData.episode : linkData.absoluteEpisode) ?? linkData.episode), type: s.type,
                        quality: qualityNum(s) || undefined, playable: s.type !== 'iframe', host: hostOf(s.link),
                    }));
                links.forEach((l: any) => rsend('link', l));
                (r.subtitles || []).forEach((sub: any) => rsend('subtitle', { providerId: p.id, lang: sub.language, url: subProxy(sub.url) }));
                const best = links.reduce((m: number, l: any) => Math.max(m, l.quality || 0), 0);
                const durationMs = Date.now() - t;
                // A timeout is reported as `failed` with a reason so it's visible in the
                // UI (previously indistinguishable from a genuine "no sources").
                const state = links.length ? 'found' : timedOut ? 'failed' : 'empty';
                const note = timedOut ? `timed out after ${Math.round(durationMs / 1000)}s` : undefined;
                // Feed the health/circuit-breaker (skip aborted runs — a closed tab isn't a failure).
                if (!closed && !torrentMode) recordProvider(p.id, state, durationMs);
                rsend('provider', { id: p.id, name: p.name, state, durationMs, links, priorityScore: best, note });
                send('log', { msg: `${p.name}: ${timedOut ? 'timed out' : `${links.length} link${links.length === 1 ? '' : 's'}`} (${durationMs}ms)` });
            } catch (e: any) {
                if (!closed && !torrentMode) recordProvider(p.id, 'failed', Date.now() - t);
                rsend('provider', { id: p.id, name: p.name, state: 'failed', durationMs: Date.now() - t, links: [], priorityScore: 0, note: String(e?.message || e).slice(0, 80) });
            }
        }));

        rsend('done', {});
        // Cache a COMPLETE resolve that actually produced sources (skip aborted /
        // all-empty runs, and subset re-scans, so we never serve a bad/partial result).
        if (!closed && !onlyProviders.length && recorded.some((x) => x.e === 'link')) {
            if (sourceCache.size >= SOURCE_CACHE_MAX) {
                let oldestKey: string | undefined; let oldestAt = Infinity;
                for (const [k, v] of sourceCache) if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
                if (oldestKey) sourceCache.delete(oldestKey);
            }
            sourceCache.set(cacheKey, { at: Date.now(), events: recorded });
        }
        res.end();
    } catch (e: any) {
        send('log', { msg: `Resolver error: ${e?.message || e}` });
        send('done', {});
        res.end();
    }
});

export default router;
