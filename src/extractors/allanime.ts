import crypto from 'crypto';
import { Provider, LinkData, ExtractorResult } from '../types';
import { app, safeGet } from '../utils/http';
import { isFlareSolverrConfigured } from '../utils/flaresolverr';
import { seasonScore } from '../utils/season';
import { animeSearchTitles } from '../anime';

/**
 * AllAnime (allanime.day) — the backend behind `ani-cli`.
 *
 * WHY THIS PROVIDER: as of 2026 the big anime sources (HiAnime/Zoro, AnimeKai,
 * 9anime, Gogoanime) are dead/frozen, which is why scraper-based dub providers
 * "work one episode then die". AllAnime is actively maintained, needs NO
 * FlareSolverr and NO API key, and — crucially — exposes SUB and DUB as a first
 * class GraphQL parameter (`translationType`), so English dub is a clean, indexed
 * track rather than a guessed server. We resolve BOTH sub and dub in one pass and
 * return them as separate sources so the player/user picks.
 *
 * Flow (ported from ani-cli): GraphQL search (by title) → showId → episode
 * `sourceUrls` → decrypt the internal `--…` source ids (a simple per-byte XOR 0x38
 * hex cipher) → GET the `…/clock.json` endpoint → real HLS/MP4 links + qualities.
 */

const BASE = 'allanime.day';
const API = `https://api.${BASE}/api`;
// ani-cli uses this exact referer/origin + Firefox UA; the API rejects/derails other
// referers, and this is what lets a plain request succeed without a browser solve.
const REFERER = 'https://youtu-chan.com';
const AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0';
const HDRS = { 'User-Agent': AGENT, Referer: REFERER };
const POST_HDRS = { ...HDRS, 'Content-Type': 'application/json', Origin: REFERER };

const SEARCH_GQL = 'query( $search: SearchInput $limit: Int $page: Int $translationType: VaildTranslationTypeEnumType $countryOrigin: VaildCountryOriginEnumType ) { shows( search: $search limit: $limit page: $page translationType: $translationType countryOrigin: $countryOrigin ) { edges { _id name availableEpisodes __typename } }}';
// Episode SOURCES must use the PERSISTED query (by hash) — the inline query returns a
// server error + a decoy. This is ani-cli's hash; update if AllAnime rotates it.
const EPISODE_HASH = 'd405d0edd690624b66baba3068e0edc3ac90f1597d898a1ec8db4e5c43c00fec';
// The episode response hides sourceUrls in a `tobeparsed` blob, AES-256-CTR encrypted
// with SHA-256("Xot36i3lK3:v1"); the 12-byte IV is embedded (bytes 1..13), counter
// suffix 0x00000002, and the last 16 bytes (auth tag) are dropped for the CTR decrypt.
const ALLANIME_KEY = crypto.createHash('sha256').update('Xot36i3lK3:v1').digest();
function decryptTobeparsed(b64: string): string | null {
    try {
        const buf = Buffer.from(b64, 'base64');
        if (buf.length < 13 + 16) return null;
        const iv = buf.subarray(1, 13);
        const counter = Buffer.concat([iv, Buffer.from([0, 0, 0, 2])]);
        const ct = buf.subarray(13, buf.length - 16);
        const d = crypto.createDecipheriv('aes-256-ctr', ALLANIME_KEY, counter);
        return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch { return null; }
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Significant-token overlap so "Frieren: Beyond…" matches "Sousou no Frieren". */
function overlaps(a: string, b: string): boolean {
    const ta = new Set(norm(a).split(' ').filter((w) => w.length >= 3));
    const tb = new Set(norm(b).split(' ').filter((w) => w.length >= 3));
    for (const w of ta) if (tb.has(w)) return true;
    return false;
}

/**
 * Decrypt an AllAnime internal source id. The `sourceUrl` for the good providers
 * begins with `--` followed by a hex string where every byte is the real ASCII
 * char XOR 0x38 (verified: 0x79^0x38='A', 0x17^0x38='/'). We then swap `/clock`
 * for `/clock.json` — the JSON endpoint that returns the actual media links.
 */
function decodeSourceUrl(raw: string): string | null {
    if (!raw.startsWith('--')) return null;
    const hex = raw.slice(2);
    const pairs = hex.match(/../g);
    if (!pairs) return null;
    const dec = pairs.map((h) => String.fromCharCode(parseInt(h, 16) ^ 0x38)).join('');
    if (!dec.startsWith('/')) return null;
    return dec.replace('/clock', '/clock.json');
}

/** Pull a JSON object out of a page body (FlareSolverr's solved HTML, worst case). */
function extractJson(html: string): any {
    if (!html) return null;
    const a = html.indexOf('{'), b = html.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(html.slice(a, b + 1)); } catch { /* */ } }
    return null;
}

/**
 * POST an inline GraphQL query to the AllAnime API — the way ani-cli does it (search
 * AND episode-sources both work as a POST with the inline query). We do NOT route the
 * JSON API through FlareSolverr: its headless browser 500s on a JSON response (the
 * failure the trace showed). Instead we solve the Cloudflare challenge ONCE via a GET
 * (which primes the cf_clearance cookie in the shared jar), then every POST replays
 * that clearance and gets clean JSON directly.
 */
async function apiPost(body: Record<string, any>): Promise<any> {
    const doPost = () => app.post(API, JSON.stringify(body), { headers: POST_HDRS, timeout: 20000 });
    let r = await doPost();
    let j = r.json<any>();
    if (j) return j;   // parseable JSON (clearance already good) — done
    // Challenged (got HTML, not JSON): prime cf_clearance with a single GET solve, retry.
    if (isFlareSolverrConfigured()) {
        await safeGet(API, { headers: HDRS, flareTimeout: 60000 }).catch(() => { /* */ });
        r = await doPost();
        j = r.json<any>() ?? extractJson(r.text);
    }
    return j;
}

/** GET a JSON endpoint (the clock.json media list) with the primed cf_clearance. */
async function apiGet(url: string): Promise<any> {
    let r = await app.get(url, { headers: HDRS, timeout: 15000 });
    let j = r.json<any>();
    if (j) return j;
    if (isFlareSolverrConfigured()) {
        await safeGet(url, { headers: HDRS, flareTimeout: 60000 }).catch(() => { /* */ });
        r = await app.get(url, { headers: HDRS, timeout: 15000 });
        j = r.json<any>() ?? extractJson(r.text);
    }
    return j;
}

interface Edge { _id: string; name: string; availableEpisodes?: { sub?: number; dub?: number } }

/**
 * Episode sources via the PERSISTED query (GET + extensions hash), then decrypt the
 * `tobeparsed` blob → the sourceUrls array. Plain GET (no FlareSolverr on the JSON);
 * a challenged egress is handled by priming cf_clearance once via a GET solve.
 */
async function getEpisodeSources(showId: string, mode: 'sub' | 'dub', episodeString: string): Promise<any[]> {
    const variables = { showId, translationType: mode, episodeString };
    const ext = { persistedQuery: { version: 1, sha256Hash: EPISODE_HASH } };
    const url = `${API}?variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(ext))}`;
    const hdrs = { ...HDRS, Origin: REFERER };
    let text = (await app.get(url, { headers: hdrs, timeout: 20000 })).text;
    if (!/tobeparsed|sourceUrl/.test(text) && isFlareSolverrConfigured()) {
        await safeGet(API, { headers: HDRS, flareTimeout: 60000 }).catch(() => { /* */ });
        text = (await app.get(url, { headers: hdrs, timeout: 20000 })).text;
    }
    const tobe = (text.match(/"tobeparsed":"([^"]*)"/) || [])[1];
    if (tobe) {
        const dec = decryptTobeparsed(tobe);
        if (dec) {
            try { const dj = JSON.parse(dec); const arr = Array.isArray(dj) ? dj : (dj.sourceUrls || dj.episode?.sourceUrls); if (Array.isArray(arr)) return arr; } catch { /* fall through to regex */ }
            const out: any[] = [];
            const re = /"sourceUrl":"([^"]*)"[^}]*?"sourceName":"([^"]*)"/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(dec))) out.push({ sourceUrl: m[1].replace(/\\u002F/g, '/'), sourceName: m[2] });
            if (out.length) return out;
        }
    }
    try { return JSON.parse(text)?.data?.episode?.sourceUrls || []; } catch { return []; }
}

/** Resolve the media links for one show + episode + translation mode. */
async function resolveMode(showId: string, episodeString: string, mode: 'sub' | 'dub', out: ExtractorResult): Promise<void> {
    let sources: any[] = [];
    try {
        sources = await getEpisodeSources(showId, mode, episodeString);
    } catch (e: any) { if (process.env.ANIME_DEBUG) console.error(`[AllAnime] ${mode} episode fetch FAILED`, e?.message); return; }
    if (process.env.ANIME_DEBUG && !sources.length) console.error(`[AllAnime] ${mode} ep="${episodeString}" show=${showId} 0 sources`);
    // Only the internal `--…` sources resolve to clean direct links via clock.json.
    const internal = sources
        .filter((s) => typeof s.sourceUrl === 'string' && s.sourceUrl.startsWith('--'))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));
    if (process.env.ANIME_DEBUG) console.error(`[AllAnime] ${mode} sourceUrls=${sources.length} internal=${internal.length}`, sources.map((s) => s.sourceName));

    const seen = new Set<string>();
    await Promise.all(internal.slice(0, 6).map(async (s) => {
        const path = decodeSourceUrl(s.sourceUrl);
        if (!path) return;
        let clock: any;
        try {
            clock = await apiGet(`https://${BASE}${path}`);
        } catch (e: any) { if (process.env.ANIME_DEBUG) console.error(`[AllAnime] clock ${s.sourceName} FAILED`, e?.message); return; }
        const links: any[] = clock?.links || [];
        if (process.env.ANIME_DEBUG) console.error(`[AllAnime] clock ${s.sourceName} -> ${links.length} links`, links[0] ? JSON.stringify(links[0]).slice(0, 160) : '');
        for (const l of links) {
            // The URL lives under .link, .url (the hls shape), or .src. NOT .mp4 —
            // that's a boolean flag (`{"mp4":true}`), and pushing it made link=true,
            // which later crashed proxify's Buffer.from(). Require a real string URL.
            const link: unknown = l.link || l.url || l.src;
            if (typeof link !== 'string' || !link || seen.has(link)) continue;
            seen.add(link);
            const isHls = /\.m3u8(\?|$)/i.test(link) || l.hls === true;
            const res = String(l.resolutionStr || l.resolution || '').replace(/[^\d]/g, '');
            // Put the audio LANGUAGE in the server name so the sources panel shows a
            // filterable "English"/"Japanese" tag (this is how the user filters for dubs).
            const audioWord = mode === 'dub' ? 'English' : 'Japanese';
            out.streams.push({
                server: `AllAnime · ${audioWord} (${mode === 'dub' ? 'Dub' : 'Sub'})${s.sourceName ? ` · ${s.sourceName}` : ''}`,
                link,
                type: isHls ? 'm3u8' : 'mp4',
                quality: res ? `${res}p` : undefined,
                audioName: audioWord,
            });
            // Some clock.json entries carry subtitle tracks alongside the video.
            for (const sub of l.subtitles || []) {
                if (sub?.src && !out.subtitles.find((x) => x.url === sub.src)) {
                    out.subtitles.push({ language: sub.label || sub.lang || 'Sub', url: sub.src });
                }
            }
        }
    }));
}

export const AllAnimeProvider: Provider = {
    id: 'allanime',
    name: 'AllAnime',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const out: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.isAnime || !data.title) return out;

        const episode = data.type === 'movie' ? 1 : (data.episode ?? 1);
        const wantSeason = (data.type === 'movie' || data.seasonResolved) ? undefined : (data.season ?? 1);
        const episodeString = String(episode);

        // 1) Search by title — TMDB name, original, AND the AniList romaji/synonyms,
        //    since AllAnime indexes by romaji/short title, not TMDB's English name.
        // ACCUMULATE across all title variants — don't stop at the first non-empty
        // result. The English title often returns only OVAs/specials while the romaji
        // ("Boku wa Tomodachi ga Sukunai") returns the actual series; we need both in
        // the candidate pool so scoring can pick the real season.
        const queries = animeSearchTitles(data);
        const byId = new Map<string, Edge>();
        for (const q of queries) {
            let d: any;
            try {
                d = await apiPost({ variables: { search: { allowAdult: false, allowUnknown: false, query: q }, limit: 40, page: 1, translationType: 'sub', countryOrigin: 'ALL' }, query: SEARCH_GQL });
            } catch { continue; }
            const es = (d?.data?.shows?.edges || []) as Edge[];
            if (process.env.ANIME_DEBUG) console.error(`[AllAnime] search "${q}" -> ${es.length} edges`, es.slice(0, 3).map((e) => e.name));
            for (const e of es) if (e?._id && !byId.has(e._id)) byId.set(e._id, e);
            // Stop once we hold a candidate that actually has enough episodes (a real
            // series match) so we don't keep querying every variant needlessly.
            if ([...byId.values()].some((e) => Math.max(e.availableEpisodes?.sub || 0, e.availableEpisodes?.dub || 0) >= episode)) break;
        }
        const edges = [...byId.values()];
        if (!edges.length) return out;

        // 2) Pick the best-matching show that actually has this episode: season match
        //    (for split-season entries) + title-token overlap + enough episodes.
        const want = `${data.title} ${data.orgTitle || ''}`;
        const scored = edges
            .map((e) => {
                const subEps = e.availableEpisodes?.sub || 0;
                const dubEps = e.availableEpisodes?.dub || 0;
                const maxEps = Math.max(subEps, dubEps);
                let score = wantSeason ? seasonScore(e.name, wantSeason, data.seasonYear) : 0;
                if (overlaps(e.name, want)) score += 3;
                if (maxEps >= episode) score += 2; else score -= 5;
                // Prefer the full season over a same-titled OVA/side-story: a fuller
                // episode count wins ties, and a colon-subtitle entry that isn't a
                // "Season N" is usually an OVA ("… : Coleus no Yume") → penalize it.
                score += Math.min(maxEps, 26) * 0.1;
                if (/[:：]/.test(e.name) && !/\b(season|part)\b/i.test(e.name)) score -= 3;
                return { e, score, subEps, dubEps };
            })
            .sort((a, b) => b.score - a.score);
        const best = scored[0];
        if (process.env.ANIME_DEBUG) console.error('[AllAnime] best:', best?.e?.name, 'score', best?.score, 'sub', best?.subEps, 'dub', best?.dubEps, 'ep', episode);
        if (!best || best.score <= 0) return out;

        // 3) Resolve sub, and dub too when the show actually has dubbed episodes.
        const modes: ('sub' | 'dub')[] = ['sub'];
        if (best.dubEps >= episode) modes.push('dub');
        await Promise.all(modes.map((m) => resolveMode(best.e._id, episodeString, m, out)));
        if (process.env.ANIME_DEBUG) console.error('[AllAnime] resolved streams:', out.streams.length);

        return out;
    },
};
