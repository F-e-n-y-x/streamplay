import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult, Stream } from '../types';
import { app } from '../utils/http';
import { flareSolverrGetHtml } from '../utils/flaresolverr';
import { getPacked, getAndUnpack } from '../utils/hostextractors';

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

async function resolveKwik(kwikUrl: string): Promise<string | null> {
    try {
        const res = await app.get(kwikUrl, { referer: `${BASE}/`, timeout: 15000 });
        const packed = getPacked(res.text);
        const src = packed ? getAndUnpack(packed) : res.text;
        const m = /source\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/.exec(src) || /(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/.exec(src);
        return m ? (m[1] || m[0]) : null;
    } catch { return null; }
}

export const AnimePaheProvider: Provider = {
    id: 'animepahe',
    name: 'AnimePahe',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        if (!data.isAnime || !data.title) return { streams, subtitles: [] };
        const episode = data.type === 'movie' ? 1 : (data.episode ?? 1);

        // 1) search → anime session id
        const searchHtml = await flareSolverrGetHtml(`${BASE}/api?m=search&q=${encodeURIComponent(data.title)}`);
        const search = searchHtml && extractJson(searchHtml);
        const list: any[] = search?.data || [];
        if (!list.length) return { streams, subtitles: [] };
        const want = norm(data.title);
        const pick = list.find((a) => norm(a.title) === want)
            || (data.year ? list.find((a) => a.year === data.year) : undefined)
            || list[0];
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
        if (!epSession) return { streams, subtitles: [] };

        // 3) play page → resolution buttons (kwik links tagged with audio + quality)
        const playHtml = await flareSolverrGetHtml(`${BASE}/play/${animeId}/${epSession}`);
        if (!playHtml) return { streams, subtitles: [] };
        const $ = cheerio.load(playHtml);
        const buttons = $('#resolutionMenu > button').toArray();

        // NATIVE ONLY. Kwik (the video host) blocks server-side extraction from
        // some networks; we resolve the real .m3u8 and emit that so it plays in the
        // native player through our proxy. If Kwik can't be resolved from our egress
        // IP we emit nothing for that button — we never fall back to an iframe or any
        // other player.
        await Promise.all(buttons.map(async (b) => {
            const el = $(b);
            const track = /eng/i.test(el.attr('data-audio') || el.find('span').text()) ? 'DUB' : 'SUB';
            const q = el.attr('data-resolution');
            const quality = q ? `${q}p` : undefined;
            const href = el.attr('data-src') || el.attr('data-kwik') || '';
            if (!/kwik/i.test(href)) return;
            const label = `AnimePahe ${quality ?? ''} · ${track}`.replace(/\s+/g, ' ').trim();
            const m3u8 = await resolveKwik(href);
            if (m3u8) {
                streams.push({ server: label, link: m3u8, type: 'm3u8', quality, headers: { Referer: 'https://kwik.cx/', Origin: 'https://kwik.cx' } });
            }
        }));

        return { streams, subtitles: [] };
    },
};
