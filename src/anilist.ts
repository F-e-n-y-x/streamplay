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
