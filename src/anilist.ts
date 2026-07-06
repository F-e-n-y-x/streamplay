import net from './utils/net';

/**
 * AniList franchise/episode metadata for ANIME.
 *
 * TMDB models a multi-cour anime as aired "seasons" that rarely line up with how the
 * streaming sites number episodes. AniList models each cour as its OWN entry linked by
 * PREQUEL/SEQUEL relations, and every cour restarts at episode 1 — which is EXACTLY how
 * AllAnime / AnimePahe / AnimeTosho index them. So we walk the AniList relation chain to
 * build the season list, and read per-episode titles/images from ani.zip.
 *
 * Everything here is best-effort: callers fall back to TMDB when a lookup returns null.
 */

const ANILIST = 'https://graphql.anilist.co';

// Mainline TV formats count as "seasons"; movies/OVAs/specials are franchise extras.
const MAINLINE = new Set(['TV', 'TV_SHORT', 'ONA']);

const RELATIONS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id idMal format episodes seasonYear status
    startDate { year }
    nextAiringEpisode { episode }
    title { romaji english native }
    relations {
      edges {
        relationType
        node {
          id idMal type format episodes seasonYear status
          startDate { year }
          nextAiringEpisode { episode }
          title { romaji english native }
        }
      }
    }
  }
}`;

export interface AniSeason {
    anilistId: number;
    malId?: number;
    title: string;
    titles: string[];
    episodeCount: number;
    year?: number;
}

interface AniNode {
    id: number; idMal?: number; type?: string; format?: string; episodes?: number;
    seasonYear?: number; status?: string; startDate?: { year?: number }; nextAiringEpisode?: { episode?: number };
    title?: { romaji?: string; english?: string; native?: string };
}

const titlesOf = (n: AniNode): string[] => {
    const seen = new Set<string>(); const out: string[] = [];
    for (const t of [n.title?.english, n.title?.romaji, n.title?.native]) {
        const s = (t || '').trim(); const k = s.toLowerCase();
        if (s && !seen.has(k)) { seen.add(k); out.push(s); }
    }
    return out;
};
const displayTitle = (n: AniNode): string => n.title?.english || n.title?.romaji || n.title?.native || `Season`;
const yearOf = (n: AniNode): number | undefined => n.seasonYear || n.startDate?.year || undefined;
// Episode count — for a currently-airing season AniList's `episodes` is null, so fall
// back to (nextAiringEpisode - 1) = the count already out. 0 = unreleased/unknown.
const epCountOf = (n: AniNode): number => n.episodes || (n.nextAiringEpisode?.episode ? n.nextAiringEpisode.episode - 1 : 0);
// A real season carries a season/part/number/final marker; a bare subtitle ("Junior
// High", "Diaries") is a spinoff, not a season — used to filter title-search hits.
const SEASONISH = /\b(season|part|cour|\d+(st|nd|rd|th)|2nd|3rd|final|ii|iii|iv|v)\b|\bs\d\b|\b[2-9]\b/i;

const cache = new Map<number, { at: number; seasons: AniSeason[] }>();
const TTL = 6 * 60 * 60 * 1000;

async function fetchMedia(id: number): Promise<{ node: AniNode; edges: { relationType: string; node: AniNode }[] } | null> {
    try {
        const res = await net.post(ANILIST, { query: RELATIONS_QUERY, variables: { id } },
            { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 12000 });
        const m = res.data?.data?.Media;
        if (!m) return null;
        return { node: m, edges: (m.relations?.edges || []) as any[] };
    } catch { return null; }
}

const norm = (s: string): string => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const FRANCHISE_SEARCH = `
query ($search: String) {
  Page(page: 1, perPage: 25) {
    media(search: $search, type: ANIME, format_in: [TV, TV_SHORT, ONA], sort: SEARCH_MATCH) {
      id idMal episodes seasonYear format status
      startDate { year }
      nextAiringEpisode { episode }
      title { romaji english native }
    }
  }
}`;

async function searchFranchise(title: string): Promise<AniNode[]> {
    try {
        const res = await net.post(ANILIST, { query: FRANCHISE_SEARCH, variables: { search: title } },
            { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 12000 });
        return (res.data?.data?.Page?.media || []) as AniNode[];
    } catch { return []; }
}

/**
 * Build the ordered mainline-season list for an anime franchise.
 *
 * Relation-walking ALONE is unreliable — AniList's SEQUEL/PREQUEL graph is often broken
 * (e.g. "Slime" S1's only sequel edge points to a later OVA, not S2). So we UNION two
 * signals: (1) walk SEQUEL/PREQUEL through any bridging entry, collecting mainline TV
 * nodes; (2) a title search, keeping same-franchise TV entries (prefix-matched titles).
 * Then order by air year. Returns [] if AniList can't be reached (caller uses TMDB).
 */
export async function animeFranchise(rootAnilistId: number, baseTitle?: string): Promise<AniSeason[]> {
    const cached = cache.get(rootAnilistId);
    if (cached && Date.now() - cached.at < TTL) return cached.seasons;

    const visited = new Set<number>();
    const nodes = new Map<number, AniNode>();
    const fromWalk = new Set<number>();   // nodes reached via the relation chain (trusted)

    // (1) Relation walk — follow the SEQUEL/PREQUEL edge through ANY format (OVAs often
    // bridge two seasons), collecting mainline TV entries. These are relation-VERIFIED
    // parts of the franchise, so a differently-named sequel (Haganai → "Haganai NEXT",
    // AoT → "The Final Season") is caught here even when its title doesn't match the base.
    const addNode = (n: AniNode, walked: boolean) => { if (MAINLINE.has(n.format || '')) { nodes.set(n.id, n); if (walked) fromWalk.add(n.id); } };
    const walk = async (startId: number, rel: 'PREQUEL' | 'SEQUEL') => {
        let currentId: number | undefined = startId;
        let guard = 0;
        while (currentId && guard++ < 16) {
            if (visited.has(currentId)) break;
            visited.add(currentId);
            const media = await fetchMedia(currentId);
            if (!media) break;
            addNode(media.node, true);
            const edge = media.edges.find((e) => e.relationType === rel);
            currentId = edge?.node.id;
        }
    };
    // Run BOTH chain directions and the title search CONCURRENTLY (they're independent;
    // shared maps are safe under single-threaded async). This avoids serializing a dozen
    // AniList round-trips on the title-page critical path.
    const root = await fetchMedia(rootAnilistId);
    const tasks: Promise<unknown>[] = [];
    if (root) {
        addNode(root.node, true);
        visited.add(rootAnilistId);
        const pre = root.edges.find((e) => e.relationType === 'PREQUEL');
        const seq = root.edges.find((e) => e.relationType === 'SEQUEL');
        if (pre) tasks.push(walk(pre.node.id, 'PREQUEL'));
        if (seq) tasks.push(walk(seq.node.id, 'SEQUEL'));
    }
    // (2) Title search — recovers seasons the relation graph misses (filtered below).
    if (baseTitle) tasks.push(searchFranchise(baseTitle).then((hits) => {
        for (const h of hits) if (MAINLINE.has(h.format || '')) nodes.set(h.id, h);
    }));
    await Promise.all(tasks);

    // Decide what's a genuine SEASON:
    //  - the resolved root: always;
    //  - a relation-walked node: trust it (it's a verified sequel/prequel), but drop a
    //    1-episode special linked by SEQUEL (One Piece → "MONSTERS", 1 ep) — real seasons
    //    have multiple episodes;
    //  - a SEARCH-only node: could be an unrelated same-keyword show, so require its title
    //    to prefix-match the base AND be the base (S1) or carry a season/part marker.
    // All must have a known, released episode count (drops empty upcoming seasons).
    const base = norm(baseTitle || '');
    const keep = (n: AniNode): boolean => {
        if (epCountOf(n) <= 0) return false;
        if (n.id === rootAnilistId) return true;
        if (fromWalk.has(n.id)) return epCountOf(n) >= 2;   // verified sequel; skip 1-ep specials
        if (!base) return true;
        const en = n.title?.english || '', ro = n.title?.romaji || '';
        const cand = [norm(en), norm(ro)].filter(Boolean);
        if (!cand.some((c) => c.startsWith(base) || base.startsWith(c))) return false;
        return cand.includes(base) || SEASONISH.test(en) || SEASONISH.test(ro);
    };
    let list = [...nodes.values()].filter(keep);
    if (!list.length) return [];
    // Order by air year (chronological ≈ season order); tie-break by id for stability.
    list = list.sort((a, b) => (yearOf(a) || 9999) - (yearOf(b) || 9999) || a.id - b.id);

    const seasons: AniSeason[] = list.map((n) => ({
        anilistId: n.id,
        malId: n.idMal,
        title: displayTitle(n),
        titles: titlesOf(n),
        episodeCount: epCountOf(n),
        year: yearOf(n),
    }));
    cache.set(rootAnilistId, { at: Date.now(), seasons });
    return seasons;
}

// ── Genre/tag discovery (the Anime browse page) ───────────────────────────────
// TMDB is a poor anime catalog: most "anime genres" have no TMDB genre and fall back
// to sparse keyword tagging, and TMDB dates a multi-cour show by its FIRST season so
// new/late cours never surface in Newest/Top-Rated. AniList is the canonical anime DB
// (free, no key), models each cour as its OWN entry (correct per-cour date + score),
// and carries proper multi-genres + tags. So the Anime page browses AniList directly.

/** Map the app's anime category keys → an AniList genre or tag(s) (exact names). */
const ANILIST_CATEGORY: Record<string, { genre?: string; tag?: string | string[] }> = {
    action: { genre: 'Action' }, adventure: { genre: 'Adventure' }, cars: { tag: 'Cars' },
    comedy: { genre: 'Comedy' }, dementia: { genre: 'Psychological' }, demons: { tag: 'Demons' },
    drama: { genre: 'Drama' }, ecchi: { genre: 'Ecchi' }, fantasy: { genre: 'Fantasy' },
    // AniList has no single "Harem" tag — it's split into gender-specific ones (OR them).
    game: { tag: 'Video Games' }, harem: { tag: ['Female Harem', 'Male Harem', 'Mixed Gender Harem'] }, historical: { tag: 'Historical' },
    horror: { genre: 'Horror' }, isekai: { tag: 'Isekai' }, josei: { tag: 'Josei' },
    kids: { tag: 'Kids' }, magic: { tag: 'Magic' }, mahoushoujo: { genre: 'Mahou Shoujo' },
    martialarts: { tag: 'Martial Arts' }, mecha: { genre: 'Mecha' }, military: { tag: 'Military' },
    music: { genre: 'Music' }, mystery: { genre: 'Mystery' }, parody: { tag: 'Parody' },
    police: { tag: 'Police' }, psychological: { genre: 'Psychological' }, romance: { genre: 'Romance' },
    samurai: { tag: 'Samurai' }, school: { tag: 'School' }, scifi: { genre: 'Sci-Fi' },
    seinen: { tag: 'Seinen' }, shoujo: { tag: 'Shoujo' }, shoujoai: { tag: 'Yuri' },
    shounen: { tag: 'Shounen' }, shounenai: { tag: "Boys' Love" }, sliceoflife: { genre: 'Slice of Life' },
    space: { tag: 'Space' }, sports: { genre: 'Sports' }, superpower: { tag: 'Super Power' },
    supernatural: { genre: 'Supernatural' }, suspense: { genre: 'Thriller' }, thriller: { genre: 'Thriller' },
    vampire: { tag: 'Vampire' },
};

const BROWSE_QUERY = `
query ($page: Int, $perPage: Int, $genres: [String], $tags: [String], $format: [MediaFormat], $sort: [MediaSort], $startGte: FuzzyDateInt, $startLte: FuzzyDateInt, $popGte: Int, $status: MediaStatus, $isAdult: Boolean) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { lastPage }
    media(type: ANIME, genre_in: $genres, tag_in: $tags, format_in: $format, sort: $sort, startDate_greater: $startGte, startDate_lesser: $startLte, popularity_greater: $popGte, status: $status, isAdult: $isAdult) {
      id idMal format seasonYear averageScore
      startDate { year }
      title { romaji english native }
      coverImage { large }
    }
  }
}`;

interface AniBrowseNode extends AniNode { averageScore?: number; coverImage?: { large?: string } }

export interface AniBrowseItem {
    anilistId: number; malId?: number;
    title: string; titles: string[];
    type: 'movie' | 'tv';
    year?: number; posterUrl?: string; score?: number;
}

export interface AniBrowseOpts {
    page?: number; perPage?: number;
    cats?: string[];                                   // app category keys (OR/AND per AniList semantics)
    type?: 'all' | 'tv' | 'movie';
    cat?: string;                                      // popular | trending | newest | toprated | random
    range?: string;                                    // day | week | month | year | all (for trending/toprated/newest)
    adult?: boolean;
}

// range → FuzzyDateInt (yyyymmdd) for AniList's startDate_greater.
const rangeToFuzzy = (range?: string): number | undefined => {
    const d = new Date();
    if (range === 'day') d.setDate(d.getDate() - 1);
    else if (range === 'week') d.setDate(d.getDate() - 7);
    else if (range === 'month') d.setMonth(d.getMonth() - 1);
    else if (range === 'year') d.setFullYear(d.getFullYear() - 1);
    else return undefined;
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
};
const todayFuzzy = (): number => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

// Browse results are cached to survive AniList's aggressive rate limit (~30–90
// req/min). Without this, every category click is a fresh AniList call, so rapid
// browsing / multiple users get 429'd and the grid goes empty ("categories broken").
// We cache successes, serve STALE on failure, and never cache an empty result.
const browseCache = new Map<string, { at: number; data: { items: AniBrowseItem[]; lastPage: number } }>();
const BROWSE_TTL = 15 * 60 * 1000;
const BROWSE_MAX = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
// One retry on a rate-limit / transient 5xx, honouring Retry-After (capped).
async function anilistPost(query: string, variables: Record<string, any>): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await net.post(ANILIST, { query, variables },
                { headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 12000 });
        } catch (e: any) {
            const st = e?.response?.status;
            if (attempt === 0 && (st === 429 || st === 500 || st === 502 || st === 503 || st === 504)) {
                const ra = Number(e?.response?.headers?.['retry-after']);
                await sleep(Math.min(5000, (Number.isFinite(ra) && ra > 0 ? ra : 1.2) * 1000));
                continue;
            }
            throw e;
        }
    }
    return null;
}

// "Latest Episode" (the default anime view, like anikototv's home): the most recently
// AIRED episodes across all currently-running anime, newest first — dedup'd to one card
// per show. This is why an ongoing show that aired ep 100 today ranks above a series that
// merely premiered this week (which is what the "Newest" tab shows instead).
const LATEST_QUERY = `
query ($page: Int, $perPage: Int, $now: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { lastPage }
    airingSchedules(airingAt_lesser: $now, sort: TIME_DESC) {
      media {
        id idMal format seasonYear averageScore isAdult
        startDate { year }
        title { romaji english native }
        coverImage { large }
      }
    }
  }
}`;

async function anilistLatest(o: AniBrowseOpts): Promise<{ items: AniBrowseItem[]; lastPage: number }> {
    const page = o.page || 1;
    const key = `latest:${JSON.stringify({ page, adult: !!o.adult, type: o.type || 'all' })}`;
    const cached = browseCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data;   // short TTL — new episodes air hourly
    const wantFmt = o.type === 'movie' ? ['MOVIE'] : o.type === 'tv' ? ['TV', 'TV_SHORT', 'ONA'] : null;
    try {
        // perPage 50: dedup by show collapses many airings, so over-fetch to fill a page.
        const res = await anilistPost(LATEST_QUERY, { page, perPage: 50, now: Math.floor(Date.now() / 1000) });
        const scheds: { media: AniBrowseNode & { isAdult?: boolean } }[] = res?.data?.data?.Page?.airingSchedules || [];
        const seen = new Set<number>();
        const items: AniBrowseItem[] = [];
        for (const s of scheds) {
            const n = s.media; if (!n?.id || seen.has(n.id)) continue;
            if (!o.adult && n.isAdult) continue;
            if (wantFmt && !wantFmt.includes(n.format || '')) continue;
            seen.add(n.id);
            items.push({
                anilistId: n.id, malId: n.idMal,
                title: displayTitle(n), titles: titlesOf(n),
                type: (n.format === 'MOVIE' ? 'movie' : 'tv') as 'movie' | 'tv',
                year: yearOf(n), posterUrl: n.coverImage?.large,
                score: n.averageScore ? Math.round(n.averageScore) / 10 : undefined,
            });
            if (items.length >= 24) break;
        }
        const out = { items, lastPage: Math.min(res?.data?.data?.Page?.pageInfo?.lastPage || 1, 50) };
        if (items.length) browseCache.set(key, { at: Date.now(), data: out });
        return (!items.length && cached) ? cached.data : out;
    } catch { return cached ? cached.data : { items: [], lastPage: 1 }; }
}

/** Browse the AniList anime catalog by category, returning per-cour entries. */
export async function anilistBrowse(o: AniBrowseOpts): Promise<{ items: AniBrowseItem[]; lastPage: number }> {
    if (o.cat === 'latest' && !(o.cats || []).length) return anilistLatest(o);
    const genres: string[] = [], tags: string[] = [];
    for (const c of o.cats || []) {
        const m = ANILIST_CATEGORY[c]; if (!m) continue;
        if (m.genre) genres.push(m.genre);
        if (m.tag) Array.isArray(m.tag) ? tags.push(...m.tag) : tags.push(m.tag);
    }

    const sort = o.cat === 'trending' ? ['TRENDING_DESC']
        : o.cat === 'newest' ? ['START_DATE_DESC']
        : o.cat === 'toprated' ? ['SCORE_DESC']
        : ['POPULARITY_DESC'];   // 'airing' + 'popular' both rank by popularity
    const format = o.type === 'movie' ? ['MOVIE'] : o.type === 'tv' ? ['TV', 'TV_SHORT', 'ONA'] : undefined;

    let page = o.page || 1;
    if (o.cat === 'random') page = 1 + Math.floor(Math.random() * 20);

    const variables: Record<string, any> = {
        page, perPage: o.perPage || 24,
        genres: genres.length ? genres : undefined,
        tags: tags.length ? tags : undefined,
        format, sort,
        startGte: (o.cat === 'newest' || o.cat === 'trending' || o.cat === 'toprated') ? rangeToFuzzy(o.range) : undefined,
        // Cap Newest/Trending/Top-Rated at today so unreleased/announced titles (which
        // AniList sorts to the very top by START_DATE_DESC) don't dominate the list.
        startLte: (o.cat === 'newest' || o.cat === 'trending' || o.cat === 'toprated') ? todayFuzzy() : undefined,
        // Top-Rated by raw score is dominated by tiny-sample outliers; require a real
        // popularity floor so it returns actual acclaimed titles.
        popGte: o.cat === 'toprated' ? 5000 : undefined,
        // 'airing' = the seasonal / currently-releasing view (anikototv's "Top Airing").
        status: o.cat === 'airing' ? 'RELEASING' : undefined,
        isAdult: o.adult ? undefined : false,
    };

    const useCache = o.cat !== 'random';
    const key = JSON.stringify(variables);
    const cached = browseCache.get(key);
    if (useCache && cached && Date.now() - cached.at < BROWSE_TTL) return cached.data;

    try {
        const res = await anilistPost(BROWSE_QUERY, variables);
        const p = res?.data?.data?.Page;
        const media: AniBrowseNode[] = p?.media || [];
        const items: AniBrowseItem[] = media.map((n) => ({
            anilistId: n.id, malId: n.idMal,
            title: displayTitle(n), titles: titlesOf(n),
            type: (n.format === 'MOVIE' ? 'movie' : 'tv') as 'movie' | 'tv',
            year: yearOf(n), posterUrl: n.coverImage?.large,
            score: n.averageScore ? Math.round(n.averageScore) / 10 : undefined,
        })).filter((x) => x.anilistId && x.title);
        const out = { items, lastPage: Math.min(p?.pageInfo?.lastPage || 1, 50) };
        // Cache only a real result; never cache an empty (a rate-limited/blank response
        // must not stick). Serve stale on the next failure instead.
        if (useCache && items.length) {
            if (browseCache.size >= BROWSE_MAX) { const oldest = browseCache.keys().next().value; if (oldest) browseCache.delete(oldest); }
            browseCache.set(key, { at: Date.now(), data: out });
        }
        // If the live call came back empty but we have a stale hit, prefer the stale data.
        if (!items.length && cached) return cached.data;
        return out;
    } catch {
        // Network/429 error — serve stale data if we have any, else empty.
        return cached ? cached.data : { items: [], lastPage: 1 };
    }
}

/** Title variants + year + format for ONE AniList id — used to resolve a browsed
 *  cour back to a TMDB entry when the client didn't pass the titles. */
export async function anilistTitleVariants(id: number): Promise<{ titles: string[]; year?: number; type: 'movie' | 'tv' } | null> {
    const m = await fetchMedia(id);
    if (!m) return null;
    return { titles: titlesOf(m.node), year: yearOf(m.node), type: m.node.format === 'MOVIE' ? 'movie' : 'tv' };
}

export interface AniEpisode {
    episodeNumber: number;
    name?: string;
    overview?: string;
    stillUrl?: string;
    airDate?: string;
}

/**
 * Per-episode metadata (titles/images) for ONE cour from ani.zip, which maps an
 * AniList/MAL id to episode data. Falls back to a bare numbered list of `count`
 * episodes when ani.zip has nothing.
 */
export async function animeEpisodes(anilistId: number, count: number): Promise<AniEpisode[]> {
    try {
        const r = await net.get(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, { timeout: 10000 });
        const epObj = r.data?.episodes || {};
        const eps: AniEpisode[] = Object.keys(epObj)
            .map((k) => ({ k, e: epObj[k] }))
            .filter((x) => /^\d+$/.test(x.k))                 // skip "S1" specials keys
            .map(({ k, e }) => ({
                episodeNumber: Number(k),
                name: e.title?.en || e.title?.['x-jat'] || e.title?.ja || undefined,
                overview: e.overview || e.summary || undefined,
                stillUrl: e.image || undefined,
                airDate: e.airDate || e.airdate || undefined,
            }))
            .sort((a, b) => a.episodeNumber - b.episodeNumber);
        if (eps.length) return eps;
    } catch { /* fall through to bare list */ }
    const n = count > 0 ? count : 0;
    return Array.from({ length: n }, (_v, i) => ({ episodeNumber: i + 1 }));
}
