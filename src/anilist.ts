import net from './utils/net';
import { getDubSet } from './dublist';

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

// Mainline TV formats count as "seasons"; movies/OVAs/specials are franchise extras.
const MAINLINE = new Set(['TV', 'TV_SHORT', 'ONA']);

const RELATIONS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id idMal format episodes duration seasonYear status
    startDate { year }
    nextAiringEpisode { episode }
    title { romaji english native }
    relations {
      edges {
        relationType
        node {
          id idMal type format episodes duration seasonYear status
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
    runtime?: number;   // typical episode length (min)
}

interface AniNode {
    id: number; idMal?: number; type?: string; format?: string; episodes?: number; duration?: number;
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
const CACHE_MAX = 2000;

// null = AniList has no such id (it answers 404); network/429 errors THROW so a
// franchise walk never mistakes a rate-limit for "end of chain".
async function fetchMedia(id: number): Promise<{ node: AniNode; edges: { relationType: string; node: AniNode }[] } | null> {
    let res: any;
    try { res = await anilistPost(RELATIONS_QUERY, { id }); } catch (e: any) { if (e?.response?.status === 404) return null; throw e; }
    const m = res?.data?.data?.Media;
    return m ? { node: m, edges: (m.relations?.edges || []) as any[] } : null;
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
    const res = await anilistPost(FRANCHISE_SEARCH, { search: title });
    return (res?.data?.data?.Page?.media || []) as AniNode[];
}

/**
 * Build the ordered mainline-season list for an anime franchise.
 *
 * Relation-walking ALONE is unreliable — AniList's SEQUEL/PREQUEL graph is often broken
 * (e.g. "Slime" S1's only sequel edge points to a later OVA, not S2). So we UNION two
 * signals: (1) walk SEQUEL/PREQUEL through any bridging entry, collecting mainline TV
 * nodes; (2) a title search, keeping same-franchise TV entries (prefix-matched titles).
 * Then order by air year. THROWS if any AniList call fails (429 after retry, network):
 * a partial walk would silently drop a season and shift every later one, so the caller
 * falls back to TMDB instead and nothing partial is cached.
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
        runtime: n.duration || undefined,
    }));
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
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
      coverImage { large extraLarge }
    }
  }
}`;

interface AniBrowseNode extends AniNode { averageScore?: number; coverImage?: { large?: string; extraLarge?: string } }
const toBrowseItem = (n: AniBrowseNode): AniBrowseItem => ({
    anilistId: n.id, malId: n.idMal,
    title: displayTitle(n), titles: titlesOf(n),
    type: n.format === 'MOVIE' ? 'movie' : 'tv',
    year: yearOf(n), posterUrl: n.coverImage?.extraLarge ?? n.coverImage?.large,
    score: n.averageScore ? Math.round(n.averageScore) / 10 : undefined,
});

export interface AniBrowseItem {
    anilistId: number; malId?: number;
    title: string; titles: string[];
    type: 'movie' | 'tv';
    year?: number; posterUrl?: string; score?: number;
}

export interface AniBrowseOpts {
    page?: number;
    cats?: string[];                                   // app category keys (OR/AND per AniList semantics)
    type?: 'all' | 'tv' | 'movie';
    cat?: string;                                      // popular | trending | newest | toprated | random
    range?: string;                                    // day | week | month | year | all (for trending/toprated/newest)
    adult?: boolean;
    audio?: string;                                    // 'dub' → only titles with a known dub (best-effort, see dublist.ts)
}

/** Start of a browse range as yyyy-mm-dd (UTC), undefined for all-time. Shared with the TMDB browse. */
export const rangeStart = (range?: string, now = new Date()): string | undefined => {
    const d = new Date(now);
    if (range === 'day') d.setUTCDate(d.getUTCDate() - 1);
    else if (range === 'week') d.setUTCDate(d.getUTCDate() - 7);
    else if (range === 'month') d.setUTCMonth(d.getUTCMonth() - 1);
    else if (range === 'year') d.setUTCFullYear(d.getUTCFullYear() - 1);
    else return undefined;
    return d.toISOString().slice(0, 10);
};
// yyyy-mm-dd → AniList FuzzyDateInt (yyyymmdd).
export const toFuzzy = (iso?: string): number | undefined => (iso ? Number(iso.replace(/-/g, '')) : undefined);

// Browse results are cached to survive AniList's aggressive rate limit (~30–90
// req/min). Without this, every category click is a fresh AniList call, so rapid
// browsing / multiple users get 429'd and the grid goes empty ("categories broken").
// We cache successes, serve STALE on failure, and never cache an empty result.
const browseCache = new Map<string, { at: number; data: { items: AniBrowseItem[]; lastPage: number } }>();
const BROWSE_TTL = 15 * 60 * 1000;
const BROWSE_MAX = 500;
type AniPage = { items: AniBrowseItem[]; lastPage: number };
const cacheSet = (key: string, data: AniPage) => {
    if (browseCache.size >= BROWSE_MAX) browseCache.delete(browseCache.keys().next().value!);
    browseCache.set(key, { at: Date.now(), data });
};
// Raw AniList pages are cached individually so dub display page N reuses pages 1..N-1's
// fetches instead of re-walking from AniList page 1 (that walk was what tripped 429s).
const cachedPage = async (key: string, ttl: number, fetch: () => Promise<AniPage>): Promise<AniPage> => {
    const c = browseCache.get(key);
    if (c && Date.now() - c.at < ttl) return c.data;
    const data = await fetch();
    if (data.items.length) cacheSet(key, data);
    return data;
};

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
        coverImage { large extraLarge }
      }
    }
  }
}`;

/**
 * Consistent pagination for a POST-filtered (dub) list. AniList can't filter by
 * dub, so we accumulate whole AniList pages, keep only dubbed entries, and slice
 * out a FIXED-size display page — otherwise every page shows a different count.
 * `fetchAniPage(n)` returns one AniList page's mapped items + its lastPage.
 */
export async function paginateDubbed(
    fetchAniPage: (aniPage: number) => Promise<AniPage>,
    displayPage: number, pageSize: number, dubSet: Set<number> | null,
): Promise<AniPage> {
    const collected: AniBrowseItem[] = [];
    const seen = new Set<number>();
    let aniPage = 1, aniLast = 1;
    const need = displayPage * pageSize + 1;   // +1 so we can tell if a further page exists
    while (collected.length < need && aniPage <= aniLast && aniPage <= 25) {
        const r = await fetchAniPage(aniPage);
        aniLast = r.lastPage;
        for (const it of r.items) {
            if (!it.anilistId || seen.has(it.anilistId)) continue;
            if (dubSet && dubSet.size && !(it.malId && dubSet.has(it.malId))) continue;
            seen.add(it.anilistId);
            collected.push(it);
        }
        aniPage++;
    }
    const items = collected.slice((displayPage - 1) * pageSize, displayPage * pageSize);
    // Another page exists only if we actually collected past this one — "AniList has more
    // pages" isn't enough once the 25-page cap is hit (that produced endless empty pages).
    const lastPage = collected.length > displayPage * pageSize ? displayPage + 1 : Math.max(1, Math.ceil(collected.length / pageSize));
    return { items, lastPage };
}

const PAGE_SIZE = 24;

async function anilistLatest(o: AniBrowseOpts): Promise<{ items: AniBrowseItem[]; lastPage: number }> {
    const page = o.page || 1;
    const dubOnly = o.audio === 'dub';
    const key = `latest:${JSON.stringify({ page, adult: !!o.adult, type: o.type || 'all', dub: dubOnly })}`;
    const cached = browseCache.get(key);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.data;   // short TTL — new episodes air hourly
    const wantFmt = o.type === 'movie' ? ['MOVIE'] : o.type === 'tv' ? ['TV', 'TV_SHORT', 'ONA'] : null;

    // One AniList airing page → deduped, format/adult-filtered items (perPage 50: dedup
    // by show collapses many airings, so over-fetch to fill a page).
    const fetchAniPage = (aniPage: number) => cachedPage(`latestraw:${!!o.adult}:${o.type || 'all'}:${aniPage}`, 5 * 60 * 1000, async () => {
        const res = await anilistPost(LATEST_QUERY, { page: aniPage, perPage: 50, now: Math.floor(Date.now() / 1000) });
        const scheds: { media: AniBrowseNode & { isAdult?: boolean } }[] = res?.data?.data?.Page?.airingSchedules || [];
        const seen = new Set<number>();
        const items: AniBrowseItem[] = [];
        for (const s of scheds) {
            const n = s.media; if (!n?.id || seen.has(n.id)) continue;
            if (!o.adult && n.isAdult) continue;
            if (wantFmt && !wantFmt.includes(n.format || '')) continue;
            seen.add(n.id);
            items.push(toBrowseItem(n));
        }
        return { items, lastPage: Math.min(res?.data?.data?.Page?.pageInfo?.lastPage || 1, 50) };
    });

    try {
        let out: AniPage;
        if (dubOnly) {
            out = await paginateDubbed(fetchAniPage, page, PAGE_SIZE, await getDubSet());
        } else {
            const r = await fetchAniPage(page);
            out = { items: r.items.slice(0, PAGE_SIZE), lastPage: r.lastPage };
        }
        if (out.items.length) cacheSet(key, out);
        return (!out.items.length && cached) ? cached.data : out;
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
    const dubOnly = o.audio === 'dub';
    // Trending is already "what's hot now" (TRENDING_DESC); a premiere-date window on top
    // of it kept only shows that STARTED this week → a near-empty list. Range applies to
    // Newest / Top-Rated only.
    const ranged = o.cat === 'newest' || o.cat === 'toprated';

    const buildVars = (aniPage: number, perPage: number): Record<string, any> => ({
        page: aniPage, perPage,
        genres: genres.length ? genres : undefined,
        tags: tags.length ? tags : undefined,
        format, sort,
        startGte: ranged ? toFuzzy(rangeStart(o.range)) : undefined,
        // Cap Newest/Trending/Top-Rated at today so unreleased/announced titles (which
        // AniList sorts to the very top by START_DATE_DESC) don't dominate the list.
        startLte: ranged || o.cat === 'trending' ? toFuzzy(new Date().toISOString().slice(0, 10)) : undefined,
        // Top-Rated by raw score is dominated by tiny-sample outliers; require a real
        // popularity floor so it returns actual acclaimed titles.
        popGte: o.cat === 'toprated' ? 5000 : undefined,
        // 'airing' = the seasonal / currently-releasing view (anikototv's "Top Airing").
        status: o.cat === 'airing' ? 'RELEASING' : undefined,
        isAdult: o.adult ? undefined : false,
    });

    const fetchAniPage = async (aniPage: number, perPage = 50): Promise<AniPage> => {
        const res = await anilistPost(BROWSE_QUERY, buildVars(aniPage, perPage));
        const p = res?.data?.data?.Page;
        return { items: ((p?.media || []) as AniBrowseNode[]).map(toBrowseItem).filter((x) => x.anilistId && x.title), lastPage: Math.min(p?.pageInfo?.lastPage || 1, 50) };
    };

    const useCache = o.cat !== 'random';
    const key = JSON.stringify(buildVars(page, PAGE_SIZE)) + (dubOnly ? '|dub' : '');
    const cached = browseCache.get(key);
    if (useCache && cached && Date.now() - cached.at < BROWSE_TTL) return cached.data;

    try {
        let out: AniPage;
        if (dubOnly && useCache) {
            // Accumulate across AniList pages so each display page is a full 24.
            out = await paginateDubbed((n) => cachedPage(JSON.stringify(buildVars(n, 50)), BROWSE_TTL, () => fetchAniPage(n)), page, PAGE_SIZE, await getDubSet());
        } else {
            out = await fetchAniPage(page, dubOnly ? 50 : PAGE_SIZE);
            if (dubOnly) { const ds = await getDubSet(); out.items = out.items.filter((x) => !ds.size || (x.malId && ds.has(x.malId))).slice(0, PAGE_SIZE); }
        }
        // Cache only a real result; never cache an empty (a rate-limited/blank response
        // must not stick). Serve stale on the next failure instead.
        if (useCache && out.items.length) cacheSet(key, out);
        if (!out.items.length && cached) return cached.data;
        return out;
    } catch {
        // Network/429 error — serve stale data if we have any, else empty.
        return cached ? cached.data : { items: [], lastPage: 1 };
    }
}

/** Title variants + year + format for ONE AniList id — used to resolve a browsed
 *  cour back to a TMDB entry when the client didn't pass the titles. */
export async function anilistTitleVariants(id: number): Promise<{ titles: string[]; year?: number; type: 'movie' | 'tv' } | null> {   // throws on network error
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
    runtime?: number;   // minutes
}

/**
 * Episode titles for one cour from Jikan (the free MyAnimeList API), keyed by the
 * cour's MAL id. Used to FILL episode names that ani.zip is missing — combining the
 * two sources so a gap in one doesn't leave the episode nameless. Cached (Jikan
 * rate-limits) and fully best-effort: any failure returns an empty map.
 */
const jikanCache = new Map<number, { at: number; titles: Map<number, string> }>();
const JIKAN_TTL = 60 * 60 * 1000;
async function jikanEpisodeTitles(malId: number): Promise<Map<number, string>> {
    const c = jikanCache.get(malId);
    if (c && Date.now() - c.at < JIKAN_TTL) return c.titles;
    const titles = new Map<number, string>();
    try {
        for (let page = 1; page <= 3; page++) {   // up to 300 eps — covers a cour with room to spare
            const r = await net.get(`https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`, { timeout: 10000 });
            for (const e of (r.data?.data || [])) {
                const num = Number(e.mal_id);
                const title = e.title || e.title_romanji || e.title_english || undefined;
                if (Number.isFinite(num) && title) titles.set(num, String(title).trim());
            }
            if (!r.data?.pagination?.has_next_page) break;
        }
    } catch { /* best-effort enrichment */ }
    if (jikanCache.size >= CACHE_MAX) jikanCache.delete(jikanCache.keys().next().value!);
    jikanCache.set(malId, { at: Date.now(), titles });
    return titles;
}

/**
 * Per-episode metadata (titles/images) for ONE cour. ani.zip (AniDB/TVDB merge) is
 * the primary source; when it's missing episode titles — or returns nothing — we
 * fill from Jikan/MAL (via the cour's `malId`), combining two providers so episodes
 * don't render nameless. Falls back to a bare numbered list of `count` episodes.
 */
export async function animeEpisodes(anilistId: number, count: number, malId?: number): Promise<AniEpisode[]> {
    let eps: AniEpisode[] = [];
    try {
        const r = await net.get(`https://api.ani.zip/mappings?anilist_id=${anilistId}`, { timeout: 10000 });
        const epObj = r.data?.episodes || {};
        eps = Object.keys(epObj)
            .map((k) => ({ k, e: epObj[k] }))
            .filter((x) => /^\d+$/.test(x.k))                 // skip "S1" specials keys
            .map(({ k, e }) => ({
                episodeNumber: Number(k),
                name: e.title?.en || e.title?.['x-jat'] || e.title?.ja || undefined,
                overview: e.overview || e.summary || undefined,
                stillUrl: e.image || undefined,
                airDate: e.airDate || e.airdate || undefined,
                runtime: Number(e.runtime || e.length) || undefined,
            }))
            .sort((a, b) => a.episodeNumber - b.episodeNumber);
    } catch { /* fall through to Jikan / bare list */ }

    // Combine with Jikan/MAL when ani.zip has gaps (missing titles) or nothing at all.
    if (malId && (!eps.length || eps.some((e) => !e.name))) {
        const titles = await jikanEpisodeTitles(malId);
        if (titles.size) {
            if (!eps.length) {
                const n = count > 0 ? count : titles.size;
                eps = Array.from({ length: n }, (_v, i) => ({ episodeNumber: i + 1, name: titles.get(i + 1) }));
            } else {
                eps = eps.map((e) => (e.name ? e : { ...e, name: titles.get(e.episodeNumber) }));
            }
        }
    }
    if (eps.length) return eps;
    const n = count > 0 ? count : 0;
    return Array.from({ length: n }, (_v, i) => ({ episodeNumber: i + 1 }));
}
