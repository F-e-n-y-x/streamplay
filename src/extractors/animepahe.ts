import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult, Stream } from '../types';
import { app } from '../utils/http';
import { flareSolverrGetHtml } from '../utils/flaresolverr';
import { getPacked, getAndUnpack } from '../utils/hostextractors';
import { seasonScore } from '../utils/season';
import { animeSearchTitles } from '../anime';

/**
 * AnimePahe — anime provider with real SUB (jpn) / DUB (eng) tracks per quality.
 *
 * Flow (all site pages via the persistent FlareSolverr session — DDoS-Guard):
 *   search `/api?m=search` → anime session → `/api?m=release` → episode session
 *   → `/play/<id>/<ep>` → #resolutionMenu buttons (data-audio jpn/eng, data-src
 *   kwik) → Kwik page unpack → .m3u8.
 *
 * STATUS: search/episodes/play work; the final Kwik host (kwik.cx) is currently
 * Cloudflare-IP-blocked from our FlareSolverr egress, so this is parked in
 * `disabledProviders` until that clears. The code is otherwise complete.
 */

const BASE = (process.env.ANIMEPAHE_BASE_URL || 'https://animepahe.pw').replace(/\/+$/, '');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function extractJson(html: string): any {
    const m = html.match(/>(\{[\s\S]*\}|\[[\s\S]*\])<\/pre>/) || html.match(/>(\{[\s\S]*\})<\/body>/);
    if (m && m[1]) { try { return JSON.parse(m[1]); } catch { /* */ } }
    try { return JSON.parse(html); } catch { return null; }
}

/**
 * Resolve a Kwik `/e/<id>` embed to its master m3u8. Kwik is Cloudflare-gated
 * (and IP-bans datacenter egress), so we go through safeGet: it tries a plain
 * request first and only falls back to FlareSolverr when it hits the challenge —
 * which, from a residential egress that isn't Kwik-banned, is fast. The embed
 * carries a Dean-Edwards packed `const source='...m3u8'`.
 */
const KWIK_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
async function resolveKwik(kwikUrl: string, referer: string): Promise<string | null> {
    try {
        // Kwik serves the Dean-Edwards packed `source='...m3u8'` DIRECTLY to a plain
        // request that carries a browser UA + the animepahe referer — exactly what the
        // CloudStream plugin does. We must NOT route this through FlareSolverr: its
        // headless browser 500s on kwik's autoplay embed (the failure the trace showed).
        // In WARP mode this app.get still egresses via the WARP SOCKS, so it gets the
        // clean IP; a Kwik IP-ban just yields no packed script → null (not a 500).
        const res = await app.get(kwikUrl, { referer, headers: { 'User-Agent': KWIK_UA, Referer: referer }, timeout: 15000 });
        const packed = getPacked(res.text);
        const src = packed ? getAndUnpack(packed) : res.text;
        const m = /source\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/.exec(src) || /(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/.exec(src);
        return m ? (m[1] || m[0]) : null;
    } catch { return null; }
}

export const AnimePaheProvider: Provider = {
    id: 'animepahe',
    name: 'AnimePahe',
    // Kwik (its CDN) IP-bans most egresses — it only resolves through WARP.
    requiresWarp: true,
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        if (!data.isAnime || !data.title) return { streams, subtitles: [] };
        const episode = data.type === 'movie' ? 1 : (data.episode ?? 1);

        // 1) search → anime session id. Try each title variant (TMDB English name,
        //    original, AniList romaji/synonyms) until one returns results — animepahe
        //    indexes by romaji/short title, so the TMDB English name often finds nothing.
        let list: any[] = [];
        for (const q of animeSearchTitles(data)) {
            const searchHtml = await flareSolverrGetHtml(`${BASE}/api?m=search&q=${encodeURIComponent(q)}`);
            const search = searchHtml && extractJson(searchHtml);
            list = search?.data || [];
            if (process.env.ANIME_DEBUG) console.error(`[AP] search "${q}":`, list.length);
            if (list.length) break;
        }
        if (!list.length) return { streams, subtitles: [] };
        // AnimePahe splits a show into one entry per season, so match the requested
        // SEASON (via seasonScore), not just the title — otherwise S4E2 resolves to
        // the S1 entry's episode 2. Falls back to the top title match.
        const want = norm(data.title);
        const wantSeason = (data.type === 'movie' || data.seasonResolved) ? undefined : (data.season ?? 1);
        const scored = list.map((a) => {
            const t = norm(a.title || '');
            let s = t === want ? 3 : (t.includes(want) || want.includes(t)) ? 1 : 0;
            if (wantSeason) s += seasonScore(a.title || '', wantSeason, data.seasonYear);
            return { a, s };
        }).sort((x, y) => y.s - x.s);
        const pick = scored[0]?.a;
        if (!pick) return { streams, subtitles: [] };
        const animeId = pick.session;

        // 2) find the episode session (paginate)
        let epSession: string | undefined;
        let lastPage = 1;
        for (let p = 1; p <= lastPage && p <= 30 && !epSession; p++) {
            const relHtml = await flareSolverrGetHtml(`${BASE}/api?m=release&id=${animeId}&sort=episode_asc&page=${p}`);
            const rel = relHtml && extractJson(relHtml);
            if (!rel?.data?.length) break;
            lastPage = rel.last_page ?? 1;
            const m = rel.data.find((e: any) => Number(e.episode) === episode);
            if (m) epSession = m.session;
        }
        if (process.env.ANIME_DEBUG) console.error('[AP] animeId(session):', animeId, 'epSession:', epSession);
        if (!epSession) return { streams, subtitles: [] };

        // 3) play page → resolution buttons (kwik links tagged with audio + quality)
        const playUrl = `${BASE}/play/${animeId}/${epSession}`;
        const playHtml = await flareSolverrGetHtml(playUrl);
        if (!playHtml) return { streams, subtitles: [] };
        const $ = cheerio.load(playHtml);

        // Parse every resolution button, then keep only the BEST quality per audio
        // track (one SUB + one DUB). Each Kwik resolve is an expensive Cloudflare
        // solve, so resolving all 6 buttons floods the FlareSolverr pool (and starves
        // the other anime providers) for near-duplicate streams. ≤2 solves is plenty.
        interface Cand { track: 'SUB' | 'DUB'; quality?: string; qnum: number; href: string; }
        const cands: Cand[] = [];
        $('#resolutionMenu > button').each((_i, b) => {
            const el = $(b);
            // Skip AV1 renditions — hls.js/browsers play them poorly (animepahe-dl
            // filters these out too); the h264 buttons are data-av1="0".
            if (el.attr('data-av1') === '1') return;
            const track: 'SUB' | 'DUB' = /eng/i.test(el.attr('data-audio') || el.find('span').text()) ? 'DUB' : 'SUB';
            const q = el.attr('data-resolution') || (/(\d{3,4})p/.exec(el.text())?.[1]);
            const href = el.attr('data-src') || el.attr('data-kwik') || '';
            if (!/kwik/i.test(href)) return;
            cands.push({ track, quality: q ? `${q}p` : undefined, qnum: Number(q) || 0, href });
        });
        const bestPer = (t: 'SUB' | 'DUB') => cands.filter((c) => c.track === t).sort((a, b) => b.qnum - a.qnum)[0];
        const chosen = [bestPer('SUB'), bestPer('DUB')].filter(Boolean) as Cand[];
        if (process.env.ANIME_DEBUG) console.error('[AP] buttons:', cands.length, 'chosen:', chosen.map(c => `${c.track} ${c.quality}`));

        // NATIVE ONLY. Kwik blocks server-side extraction from some networks; we
        // resolve the real .m3u8 and emit that so it plays natively through our proxy.
        // If Kwik can't be resolved from our egress IP we emit nothing (never an iframe).
        await Promise.all(chosen.map(async (c) => {
            const label = `AnimePahe ${c.quality ?? ''} · ${c.track}`.replace(/\s+/g, ' ').trim();
            const m3u8 = await resolveKwik(c.href, playUrl);
            if (process.env.ANIME_DEBUG) console.error('[AP] kwik', c.href.slice(0, 50), '=>', m3u8 ? m3u8.slice(0, 60) : 'NULL');
            if (m3u8) {
                streams.push({ server: label, link: m3u8, type: 'm3u8', quality: c.quality, headers: { Referer: 'https://kwik.cx/', Origin: 'https://kwik.cx' } });
            }
        }));

        return { streams, subtitles: [] };
    },
};
