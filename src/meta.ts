import { resolveAnimeIds } from './anime';
import { animeFranchise, animeEpisodes } from './anilist';
import { tvdbEnabled, tvdbFindSeries, tvdbFromRemoteId, tvdbEpisodes, tvdbSeasons, TvdbOrder } from './utils/tvdb';
import { castleEpisodes } from './extractors/castle';

/**
 * Unified season/episode plan for a title.
 *
 * TMDB's aired seasons don't match how anime sources number episodes, and it orders
 * cartoons (Ben 10) by air date with thin Indian/international coverage. So for those
 * kinds we build the season list from a BETTER source and expose it through ONE plan
 * that `/title`, `/title/.../season/:n` AND the SSE resolver all read — otherwise the
 * detail page and the source lookup would disagree and play the wrong episode.
 *
 *   - anime  → AniList franchise chain (each cour = a season, episodes restart at 1)
 *   - cartoon / non-anime series (when TVDB_API_KEY set) → TheTVDB (correct order + coverage)
 *   - everything else → TMDB (source: 'tmdb', caller keeps its existing TMDB path)
 */

export interface PlanSeason {
    seasonNumber: number;
    name: string;
    episodeCount: number;
    // anime-only: the AniList/MAL ids + titles for THIS cour, used by the resolver.
    anilistId?: number;
    malId?: number;
    titles?: string[];
    year?: number;
}
export interface PlanEpisode {
    episodeNumber: number;
    seasonNumber: number;
    name?: string;
    overview?: string;
    stillUrl?: string;
    airDate?: string;
}
export interface SeasonPlan {
    source: 'anilist' | 'tvdb' | 'castle' | 'tmdb';
    seasons: PlanSeason[];
    tvdbId?: number;
    tvdbOrder?: TvdbOrder;
    // 'castle' carries its episode list inline (single season) — see buildCastlePlan.
    episodes?: PlanEpisode[];
}

export interface MetaInput {
    id: number;
    type: 'movie' | 'tv';
    title: string;
    year?: number;
    imdbId?: string;
    orgTitle?: string;
    isAnime?: boolean;
    isCartoon?: boolean;
    /** Indian-origin series (Bollywood/regional). TVDB has far better coverage/ordering
     *  than TMDB for these — but we DON'T route well-covered Hollywood series through
     *  TVDB (that risks changing a correct TMDB structure), so this gates TVDB use. */
    indian?: boolean;
}

const cache = new Map<string, { at: number; plan: SeasonPlan }>();
const TTL = 15 * 60 * 1000;
// A 'tmdb' plan can mean "no better source EXISTS" or "AniList/TVDB was briefly down".
// Cache it only briefly so a transient upstream failure doesn't pin a title to the
// degraded TMDB structure for the full TTL (cache-poisoning).
const NEG_TTL = 60 * 1000;
const keyOf = (i: MetaInput) => `${i.type}:${i.id}`;

async function buildAnimePlan(i: MetaInput): Promise<SeasonPlan | null> {
    const ids = await resolveAnimeIds(i.id, i.type, i.title, i.year?.toString(), i.orgTitle);
    if (!ids.anilistId) return null;
    const fr = await animeFranchise(ids.anilistId, i.title);
    if (!fr.length) return null;
    // Short tab labels: the AniList titles repeat the show name ("…Slime Season 2 Part 2"),
    // which overflows the tab. Strip the shared S1 name to leave just "Season 2 Part 2";
    // S1 (or the only cour) becomes "Season 1" / "Episodes".
    const baseName = fr[0].title.toLowerCase();
    const label = (full: string, idx: number): string => {
        if (idx === 0) return fr.length > 1 ? 'Season 1' : 'Episodes';
        const tail = full.toLowerCase().startsWith(baseName)
            ? full.slice(fr[0].title.length).replace(/^[\s:–—-]+/, '').trim()
            : '';
        return tail || `Season ${idx + 1}`;
    };
    const seasons: PlanSeason[] = fr.map((s, idx) => ({
        seasonNumber: idx + 1,
        name: label(s.title, idx),
        episodeCount: s.episodeCount,
        anilistId: s.anilistId,
        malId: s.malId,
        titles: s.titles,       // full cour titles kept for the source search
        year: s.year,
    }));
    return { source: 'anilist', seasons };
}

async function buildTvdbPlan(i: MetaInput): Promise<SeasonPlan | null> {
    // Only cartoons + Indian series — leave well-covered Hollywood series on TMDB.
    if (!tvdbEnabled() || i.type !== 'tv' || !(i.isCartoon || i.indian)) return null;
    let seriesId: number | null = null;
    if (i.imdbId) seriesId = await tvdbFromRemoteId(i.imdbId);
    if (!seriesId) seriesId = await tvdbFindSeries(i.title, i.year);
    if (!seriesId) return null;
    // Cartoons: production/DVD order fixes the Ben-10-style split; fall back to aired.
    const order: TvdbOrder = i.isCartoon ? 'official' : 'default';
    let seasons = await tvdbSeasons(seriesId, order);
    let used = order;
    if (i.isCartoon && seasons.length <= 1) { seasons = await tvdbSeasons(seriesId, 'default'); used = 'default'; }
    if (!seasons.length) return null;
    return {
        source: 'tvdb',
        tvdbId: seriesId,
        tvdbOrder: used,
        seasons: seasons.map((s) => ({ seasonNumber: s.seasonNumber, name: `Season ${s.seasonNumber}`, episodeCount: s.episodeCount })),
    };
}

/**
 * CastleTV fallback for Indian series that TMDB/TVDB haven't episode-catalogued
 * (daily soaps). CastleTV carries the full episode list, so we surface it as a single
 * season. Only used when it actually adds episodes over TMDB (>1).
 */
async function buildCastlePlan(i: MetaInput): Promise<SeasonPlan | null> {
    if (!process.env.CASTLE_SUFFIX || i.type !== 'tv' || !i.indian) return null;
    const eps = await castleEpisodes(i.title, i.year);
    if (eps.length <= 1) return null;
    const episodes: PlanEpisode[] = eps.map((e) => ({ episodeNumber: e.number, seasonNumber: 1, name: e.title }));
    return { source: 'castle', seasons: [{ seasonNumber: 1, name: 'Episodes', episodeCount: eps.length }], episodes };
}

/** Build (or reuse) the season plan for a title. Never throws — returns a tmdb plan on failure. */
export async function seasonPlan(i: MetaInput): Promise<SeasonPlan> {
    const k = keyOf(i);
    const c = cache.get(k);
    if (c && Date.now() - c.at < (c.plan.source === 'tmdb' ? NEG_TTL : TTL)) return c.plan;
    let plan: SeasonPlan | null = null;
    try {
        if (i.isAnime) plan = await buildAnimePlan(i);
        else if (i.type === 'tv') {
            plan = await buildTvdbPlan(i);                    // cartoons + Indian series (gated inside)
            if (!plan) plan = await buildCastlePlan(i);       // daily-soap fallback when TVDB is thin
        }
    } catch { plan = null; }
    const finalPlan = plan || { source: 'tmdb', seasons: [] };   // short-TTL cached (see NEG_TTL)
    cache.set(k, { at: Date.now(), plan: finalPlan });
    return finalPlan;
}

/** Episodes for one season of a plan. Returns null when the caller should use TMDB. */
export async function planEpisodes(plan: SeasonPlan, seasonNumber: number): Promise<PlanEpisode[] | null> {
    if (plan.source === 'castle') return (plan.episodes || []).filter((e) => e.seasonNumber === seasonNumber);
    if (plan.source === 'anilist') {
        const s = plan.seasons.find((x) => x.seasonNumber === seasonNumber);
        if (!s?.anilistId) return null;
        const eps = await animeEpisodes(s.anilistId, s.episodeCount, s.malId);
        return eps.map((e) => ({ ...e, seasonNumber }));
    }
    if (plan.source === 'tvdb' && plan.tvdbId) {
        try {
            const all = await tvdbEpisodes(plan.tvdbId, plan.tvdbOrder);
            return all.filter((e) => e.seasonNumber === seasonNumber)
                .map((e) => ({ episodeNumber: e.episodeNumber, seasonNumber, name: e.name, overview: e.overview, stillUrl: e.still, airDate: e.aired }));
        } catch {
            // A TVDB error (expired token, rate-limit) must NOT bubble to the caller:
            // for a tvdb plan `seasonNumber` is a production-order index, not a TMDB
            // season number, so the caller's outer catch would fall back to
            // tmdbGet(/season/<index>) and serve the WRONG season. Return null so the
            // caller's bare-numbered-list fallback runs instead.
            return null;
        }
    }
    return null;
}
