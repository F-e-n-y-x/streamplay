import net from './utils/net';

/**
 * Best-effort "has a dub" dataset for the anime Sub/Dub catalog filter.
 *
 * AniList records NO dub-availability, so we source it from MyDubList
 * (https://github.com/Joelis57/MyDubList, CC BY 4.0) — per-language lists of MAL
 * ids that have a dub, updated daily. We union the languages this app actually
 * serves (English + the Indian dubs CastleTV/AnimeWorld carry) into one "dubbed"
 * set keyed by MAL id.
 *
 * Fetched lazily and cached 24h; serves stale on failure. If the dataset is
 * unavailable the set is empty and callers treat the filter as a no-op (show
 * everything) rather than hiding the whole catalog — a safe degradation.
 *
 * The confidence tier + languages are overridable via env for easy tuning:
 *   DUB_LIST_CONFIDENCE = very-high | high | normal | low   (default: normal)
 *   DUB_LIST_LANGS      = comma-separated (default: english,hindi — the tiers
 *                         MyDubList currently publishes; add more when available)
 */
const CONFIDENCE = (process.env.DUB_LIST_CONFIDENCE || 'very-high').replace(/[^a-z-]/gi, '');
const LANGS = (process.env.DUB_LIST_LANGS || 'english,hindi')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const BASE = `https://raw.githubusercontent.com/Joelis57/MyDubList/main/dubs/confidence/${CONFIDENCE}`;
const TTL = 24 * 60 * 60 * 1000;

let cache: { at: number; set: Set<number> } | null = null;
let inflight: Promise<Set<number>> | null = null;

async function fetchDubSet(): Promise<Set<number>> {
    const set = new Set<number>();
    await Promise.all(LANGS.map(async (lang) => {
        try {
            // GitHub raw serves .json as text/plain, so axios does NOT auto-parse it —
            // r.data comes back as a STRING; parse it ourselves. The payload is an
            // object { language, dubbed:[malIds], partial:[malIds], ... } (not a bare
            // array). We take ONLY `dubbed` (fully-dubbed) — `partial` (a few episodes
            // dubbed / announced) produced false positives in the catalog filter.
            const r = await net.get(`${BASE}/dubbed_${lang}.json`, { timeout: 15000 });
            let data: any = r.data;
            if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = null; } }
            const ids: unknown[] = Array.isArray(data) ? data : (Array.isArray(data?.dubbed) ? data.dubbed : []);
            for (const id of ids) { const n = Number(id); if (Number.isFinite(n)) set.add(n); }
        } catch { /* one language failing shouldn't sink the whole set */ }
    }));
    return set;
}

/**
 * The set of MAL ids that have a dub (English/Hindi/Tamil/Telugu). Empty if the
 * dataset couldn't be loaded and nothing was cached — callers must treat an empty
 * set as "don't filter" so a fetch outage never blanks the anime catalog.
 */
export async function getDubSet(): Promise<Set<number>> {
    if (cache && Date.now() - cache.at < TTL) return cache.set;
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const set = await fetchDubSet();
            if (set.size) { cache = { at: Date.now(), set }; return set; }
            return cache?.set || set;                 // fetch was empty → prefer stale
        } catch {
            return cache?.set || new Set<number>();
        } finally { inflight = null; }
    })();
    return inflight;
}
