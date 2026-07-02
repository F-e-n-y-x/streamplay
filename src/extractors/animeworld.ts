import * as cheerio from 'cheerio';
import axios from 'axios';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';
import { flareSolverrGetHtml } from '../utils/flaresolverr';

/**
 * AnimeWorld (watchanimeworld.net) — anime with **Indian dubs** (Hindi / Tamil /
 * Telugu) plus English + Japanese, as a single multi-audio HLS master.
 *
 * Flow: search by title (Cloudflare → FlareSolverr) → episode page → zephyrflick
 * iframe → POST zephyrflick `getVideo` (plain, no CF) → master m3u8 whose
 * EXT-X-MEDIA audio renditions are one-per-language. Each language is exposed as
 * its own source; the proxy re-defaults the chosen audio (same as AniZone).
 */

const BASE = 'https://watchanimeworld.net';
const ZEPHYR = 'https://play.zephyrflick.top';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const AnimeWorldProvider: Provider = {
    id: 'animeworld',
    name: 'AnimeWorld',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        const subtitles: Subtitle[] = [];
        if (!data.isAnime || !data.title) return { streams, subtitles };

        const season = data.type === 'movie' ? undefined : (data.season ?? 1);
        const episode = data.type === 'movie' ? undefined : (data.episode ?? 1);

        // 1) search → best-matching slug (Cloudflare-gated → FlareSolverr)
        const searchHtml = await flareSolverrGetHtml(`${BASE}/?s=${encodeURIComponent(data.title)}`);
        if (!searchHtml) return { streams, subtitles };
        const $s = cheerio.load(searchHtml);
        const results: { slug: string; title: string }[] = [];
        $s('a[href]').each((_i, el) => {
            const href = $s(el).attr('href') || '';
            const m = href.match(/\/(?:series|movies)\/([^/]+)\/?$/);
            if (!m) return;
            const slug = m[1];
            const title = ($s(el).attr('title') || $s(el).text() || '').trim();
            const existing = results.find((r) => r.slug === slug);
            if (existing) { if (title && !existing.title) existing.title = title; }
            else results.push({ slug, title });
        });
        if (!results.length) return { streams, subtitles };
        // Match on the title, falling back to the slug (posters often have no title text).
        const want = norm(data.title);
        const nameOf = (r: { slug: string; title: string }) => norm(r.title || r.slug.replace(/-/g, ' '));
        const best = results.find((r) => nameOf(r) === want)
            || results.find((r) => nameOf(r).includes(want) || want.includes(nameOf(r)))
            || results[0];

        // 2) episode/movie page → zephyrflick embed
        const epUrl = (season != null && episode != null)
            ? `${BASE}/episode/${best.slug}-${season}x${episode}/`
            : `${BASE}/movies/${best.slug}/`;
        const epHtml = await flareSolverrGetHtml(epUrl);
        if (!epHtml) return { streams, subtitles };
        const $e = cheerio.load(epHtml);
        let zf = '';
        $e('iframe').each((_i, el) => {
            const s = $e(el).attr('src') || $e(el).attr('data-src') || '';
            if (/zephyrflick/i.test(s)) zf = s.startsWith('http') ? s : `${BASE}${s}`;
        });
        const vid = (zf.match(/\/video\/([a-f0-9]+)/) || [])[1];
        if (!vid) return { streams, subtitles };

        // 3) resolve zephyrflick → master m3u8 (plain POST, no Cloudflare)
        let videoSource = '';
        try {
            const r = await axios.post(`${ZEPHYR}/player/index.php?data=${vid}&do=getVideo`, null,
                { headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest', Referer: zf }, timeout: 25000 });
            videoSource = r.data?.videoSource || '';
        } catch { /* */ }
        if (!videoSource) return { streams, subtitles };

        // 3b) subtitles from the player page (playerjsSubtitle = "[Lang]url\n...")
        try {
            const p = await axios.get(zf, { headers: { 'User-Agent': UA }, timeout: 20000 });
            const sm = String(p.data).match(/var playerjsSubtitle\s*=\s*"([^"]+)"/);
            if (sm) {
                for (const line of sm[1].split(/\\n|\r?\n/)) {
                    const mm = line.match(/\[([^\]]+)\](.+)/);
                    if (mm) subtitles.push({ language: mm[1].trim(), url: mm[2].trim() });
                }
            }
        } catch { /* */ }

        // Single source — the master carries all language audio tracks (Hindi/Tamil/
        // Telugu/Eng/Jap); the player lists them from the manifest and switches audio.
        streams.push({ server: 'AnimeWorld', link: videoSource, type: 'm3u8', headers: { Referer: `${ZEPHYR}/` } });
        return { streams, subtitles };
    },
};
