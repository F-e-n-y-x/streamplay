import { Router } from 'express';
import axios from 'axios';
import { tmdbGet, tmdbImg, tmdbIsLive, getTMDBInfo } from '../tmdb';
import { getProviders } from '../extractors';
import { providerDomains } from '../providersList';
import { resolveAnimeIds } from '../anime';
import { LinkData, Stream } from '../types';
import { b64 } from './proxy';

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

// Belt-and-suspenders 18+ filter: TMDB include_adult only blocks pornographic
// titles, so also drop obvious adult markers when adult content is disabled.
const ADULT_RE = /(\b18\s*\+|\bhentai\b|\buncensored\b|\berotic\b|\bnsfw\b|\bporn|\bxxx\b|\becchi\b|\bsex\b)/i;
const isAdultItem = (it: any): boolean =>
    it.adult === true || ADULT_RE.test(it.title || it.name || '') || ADULT_RE.test(it.original_title || it.original_name || '');

// TMDB tags hentai/erotic content with keywords even when `adult` is false. Resolve
// those keyword ids once and exclude them from discovery when 18+ is off.
let adultKeywordIds: string | null = null;
const getAdultKeywordIds = async (): Promise<string> => {
    if (adultKeywordIds !== null) return adultKeywordIds;
    const terms = ['hentai', 'erotic', 'erotica', 'softcore', 'pornographic'];
    const ids = new Set<number>();
    await Promise.all(terms.map(async (t) => {
        try {
            const d = await tmdbGet('/search/keyword', { query: t });
            (d.results || []).forEach((k: any) => { if (new RegExp(t, 'i').test(k.name)) ids.add(k.id); });
        } catch { /* ignore */ }
    }));
    adultKeywordIds = [...ids].join('|'); // pipe = OR (exclude any)
    return adultKeywordIds;
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

const proxify = (s: Stream): string => {
    if (s.type === 'iframe') return s.link;
    const u = b64(s.link);
    const h = s.headers ? `&h=${b64(JSON.stringify(s.headers))}` : '';
    return `/api/proxy?url=${u}${h}${s.type === 'm3u8' ? '&m3u8=1' : ''}`;
};
const subProxy = (url: string): string => `/api/proxy/sub?url=${b64(url)}`;
const hostOf = (url: string): string => { try { return new URL(url).hostname; } catch { return ''; } };

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

// ── /health ──────────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => {
    res.json({ ok: true, tmdb: tmdbIsLive() ? 'live' : 'fallback', time: new Date().toISOString() });
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
        const exact = (d.results || []).find((k: any) => (k.name || '').toLowerCase() === term.toLowerCase());
        id = exact ? exact.id : (d.results && d.results[0] ? d.results[0].id : null);
    } catch { /* ignore */ }
    keywordCache.set(term, id);
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
    let langs: (string | undefined)[];
    if (!sec.langs) langs = [undefined];
    else if (region && region !== 'all') langs = [region];
    else langs = section === 'asian' ? ['ko', 'zh'] : sec.langs;

    const cats = ((req.query.genres as string) || '').split(',').map((s) => s.trim()).filter(Boolean);

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
        const seen = new Set<number>();
        const merged: any[] = [];
        results.forEach((r) => r.results.forEach((it: any) => {
            if (it.poster_path && !seen.has(it.id) && (showAdult || !isAdultItem(it))) { seen.add(it.id); merged.push({ ...it, __kind: r.kind }); }
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
            seasons: (d.seasons || []).filter((s: any) => s.season_number > 0).map((s: any) => ({
                seasonNumber: s.season_number, name: s.name, episodeCount: s.episode_count,
            })),
            classification: { isAnime, isAsian, isBollywood, isCartoon },
        });
    } catch (e: any) {
        res.status(404).json({ error: e?.message || 'not found' });
    }
});

// ── /title/tv/:id/season/:n ──────────────────────────────────────────────────
router.get('/title/tv/:id/season/:n', async (req, res) => {
    try {
        const data = await tmdbGet(`/tv/${req.params.id}/season/${req.params.n}`, { language: langOf(req) });
        const episodes = (data.episodes || []).map((e: any) => ({
            id: e.id, name: e.name, overview: e.overview, stillUrl: tmdbImg(e.still_path, 'w300'),
            episodeNumber: e.episode_number, seasonNumber: e.season_number,
            voteAverage: e.vote_average || undefined, airDate: e.air_date,
        }));
        res.json({ seasonNumber: Number(req.params.n), episodes });
    } catch (e: any) {
        res.status(404).json({ seasonNumber: Number(req.params.n), episodes: [], error: e?.message });
    }
});

// ── /providers + /providers/health ───────────────────────────────────────────
const KIND_OF = (id: string): string => {
    if (/sub|wyzie/i.test(id)) return 'subtitles';
    if (/anime|hianime|pahe|kick|reanime|anizone|tosho/i.test(id)) return 'anime';
    if (/kisskh/i.test(id)) return 'asian';
    if (/bolly|rog|hdhub|4khdhub|vega|movies4u|uhd|moviesmod|topmovies|multimovies/i.test(id)) return 'multi';
    return 'movie';
};
const hostFor = (id: string): string => {
    const d = providerDomains.find((p) => p.id === id);
    return d ? d.url.replace(/^https?:\/\//, '') : '';
};
router.get('/providers', (_req, res) => {
    const list = getProviders().map((p) => ({
        id: p.id, name: p.name, kind: KIND_OF(p.id), host: hostFor(p.id), needsToken: false,
        stats: { successRate: 1, avgTimeMs: 0, isCircuitBroken: false, successCount: 0, failureCount: 0, consecutiveFailures: 0 },
        priorityScore: 0,
    }));
    res.json(list);
});

router.get('/providers/health', async (_req, res) => {
    const results = await Promise.all(providerDomains.map(async (p) => {
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
    req.on('close', () => { closed = true; });
    const send = (event: string, data: any) => { if (!closed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    try {
        send('log', { msg: 'Resolving metadata…' });
        const info = await getTMDBInfo(id, type);
        if (!info) { send('log', { msg: 'Metadata not found.' }); send('done', {}); return res.end(); }

        let animeIds;
        if (info.isAnime) animeIds = await resolveAnimeIds(id, type, info.title, info.year?.toString());

        const linkData: LinkData = {
            id, imdbId: info.imdbId, type, season, episode,
            title: info.title, year: info.year, orgTitle: info.originalTitle,
            isAnime: info.isAnime, isAsian: info.isAsian, isBollywood: info.isBollywood, animeIds,
        };

        const providers = getProviders();
        send('log', { msg: `Fanning out across ${providers.length} providers…` });

        const TIMEOUT = Number(process.env.PROVIDER_TIMEOUT_MS) || 45000;
        await Promise.all(providers.map(async (p) => {
            send('provider', { id: p.id, name: p.name, state: 'running', links: [], priorityScore: 0 });
            const t = Date.now();
            try {
                const r = await withTimeout(p.invoke(linkData), TIMEOUT, { streams: [], subtitles: [] });
                const links = (r.streams || []).map((s) => ({
                    providerId: p.id, name: s.server, url: proxify(s), type: s.type,
                    quality: qualityNum(s) || undefined, playable: s.type !== 'iframe', host: hostOf(s.link),
                }));
                links.forEach((l) => send('link', l));
                (r.subtitles || []).forEach((sub) => send('subtitle', { providerId: p.id, lang: sub.language, url: subProxy(sub.url) }));
                const best = links.reduce((m, l) => Math.max(m, l.quality || 0), 0);
                send('provider', { id: p.id, name: p.name, state: links.length ? 'found' : 'empty', durationMs: Date.now() - t, links, priorityScore: best });
                send('log', { msg: `${p.name}: ${links.length} link${links.length === 1 ? '' : 's'} (${Date.now() - t}ms)` });
            } catch (e: any) {
                send('provider', { id: p.id, name: p.name, state: 'failed', durationMs: Date.now() - t, links: [], priorityScore: 0, note: String(e?.message || e).slice(0, 60) });
            }
        }));

        send('done', {});
        res.end();
    } catch (e: any) {
        send('log', { msg: `Resolver error: ${e?.message || e}` });
        send('done', {});
        res.end();
    }
});

export default router;
