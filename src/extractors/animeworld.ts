import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';
import { flareSolverrGetHtml } from '../utils/flaresolverr';
import { app, safeGet } from '../utils/http';
import { loadExtractor, findMediaUrl } from '../utils/hostextractors';
import { norm } from '../utils/season';
import { animeSearchTitles } from '../anime';

/**
 * Resolve an AnimeWorld player1.php source `link` to a playable m3u8/mp4. These links
 * are short.icu shorteners that hop (server redirect → meta/JS redirect → embed page
 * like pixdrive) before reaching the media. Follow up to 3 hops, unpack any Dean-
 * Edwards packed player JS, and pull the first m3u8/mp4 out of the final page.
 */
async function resolveAWSource(url: string, base: string, ua: string): Promise<{ link: string; type: 'm3u8' | 'mp4' } | null> {
    let html = '';
    let cur = url;
    for (let i = 0; i < 3 && cur; i++) {
        let res;
        try {
            res = await app.get(cur, { referer: `${base}/`, maxRedirects: 5, headers: { 'User-Agent': ua, Referer: `${base}/` }, timeout: 15000 });
        } catch (e: any) { if (process.env.ANIME_DEBUG) console.error('[AW] hop', i, cur.slice(0, 45), 'ERR', e?.message); break; }
        html = res.text || '';
        if (process.env.ANIME_DEBUG) console.error('[AW] hop', i, cur.slice(0, 45), 'status', res.status, 'len', html.length, 'loc', (res.responseHeaders && res.responseHeaders.location) || '');
        const media = findMediaUrl(html, ['m3u8', 'mp4']);
        if (media) return { link: media, type: /\.m3u8/i.test(media) ? 'm3u8' : 'mp4' };
        // No media yet — follow a client-side redirect / embed to the next hop.
        const next = (html.match(/http-equiv=["']refresh["'][^>]*url=([^"'>\s]+)/i) || [])[1]
            || (html.match(/(?:window\.location(?:\.href)?\s*=|location\.replace\(|location\.href\s*=)\s*["']([^"']+)["']/) || [])[1]
            || (html.match(/<iframe[^>]+(?:src|data-src)=["']([^"']+)["']/i) || [])[1];
        if (!next) break;
        try { cur = next.startsWith('http') ? next : new URL(next, cur).href; } catch { break; }
    }
    if (process.env.ANIME_DEBUG) console.error('[AW] resolveAWSource', url.slice(0, 50), '-> none; finalLen', html.length, 'head', html.slice(0, 140).replace(/\s+/g, ' '));
    return null;
}

/**
 * AnimeWorld (watchanimeworld.net) — anime with **Indian dubs** (Hindi / Tamil /
 * Telugu) plus English + Japanese, as a single multi-audio HLS master.
 *
 * Flow: search (Cloudflare → FlareSolverr) → episode/movie page → enumerate the
 * server <iframe>s and pick the zephyrflick one → resolve zephyrflick to a master
 * m3u8. Both hosts are Cloudflare-challenge-gated now, so the zephyrflick step is
 * done via safeGet (which solves the challenge and primes the shared cookie jar)
 * followed by app.post/app.get, which replay that cf_clearance for the host — the
 * same proven path the Indian scrapers use.
 */

const BASE = (process.env.ANIMEWORLD_BASE_URL || 'https://watchanimeworld.net').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const stripSeason = (t: string) => t.replace(/\s*[:\-–]?\s*(the\s+)?(final\s+season|season\s*\S+|\d+(?:st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+)\s*$/i, '').trim();

export interface AWHit { slug: string; title: string; movie: boolean }
/** Pick the search hit of the right medium whose title (or slug) matches a wanted title. */
export function pickAWHit(hits: AWHit[], titles: string[], movie: boolean): AWHit | undefined {
    const wants = titles.map(norm).filter((w) => w.length >= 3);
    const pool = hits.filter((h) => h.movie === movie);
    const names = (h: AWHit) => [norm(h.title), norm(h.slug.replace(/-/g, ' '))].filter(Boolean);
    return pool.find((h) => names(h).some((n) => wants.includes(n)))
        || pool.find((h) => names(h).some((n) => n.length >= 4 && wants.some((w) => n.includes(w) || w.includes(n))));
}

export const AnimeWorldProvider: Provider = {
    id: 'animeworld',
    name: 'AnimeWorld',
    // Cloudflare-gated AND reuses the solved clearance on a direct follow-up
    // (getVideo), so its solve + follow-up must share one egress IP — route it
    // through WARP so the pinned pair keeps them consistent (in `required` mode).
    requiresWarp: true,
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        const subtitles: Subtitle[] = [];
        // watchanimeworld.net carries anime, Western cartoons (Ben 10), AND series/movies,
        // so try any title — the search simply returns nothing for titles it doesn't have.
        if (!data.title) return { streams, subtitles };

        // TV always uses the /episode/<slug>-<S>x<E>/ page — also when `seasonResolved`
        // (season is still the selected season number; only the title is per-cour).
        const isMovie = data.type === 'movie';
        const season = isMovie ? undefined : (data.season ?? 1);
        const episode = isMovie ? undefined : (data.episode ?? 1);
        // AnimeWorld lists ONE series entry (seasons live in the episode URL), so also try
        // the cour titles with their "Season N"/"Part N" suffix stripped.
        const titles = animeSearchTitles(data);
        const queries = [...new Set([...titles, ...titles.map(stripSeason).filter(Boolean)])];

        // 1) search → best-matching slug (Cloudflare-gated → FlareSolverr). Try each
        //    title variant (TMDB name, original, AniList romaji/synonyms) until one hits.
        let results: AWHit[] = [];
        for (const q of queries) {
            const searchHtml = await flareSolverrGetHtml(`${BASE}/?s=${encodeURIComponent(q)}`);
            if (!searchHtml) continue;
            const $s = cheerio.load(searchHtml);
            const found: AWHit[] = [];
            $s('a[href]').each((_i, el) => {
                const href = $s(el).attr('href') || '';
                const m = href.match(/\/(series|movies)\/([^/]+)\/?$/);
                if (!m) return;
                const slug = m[2];
                const title = ($s(el).attr('title') || $s(el).text() || '').trim();
                const existing = found.find((r) => r.slug === slug);
                if (existing) { if (title && !existing.title) existing.title = title; }
                else found.push({ slug, title, movie: m[1] === 'movies' });
            });
            if (process.env.ANIME_DEBUG) console.error(`[AW] search "${q}":`, found.length);
            if (found.length) { results = found; break; }
        }
        // Right medium + a real title match against ANY variant — never a blind first hit.
        const best = pickAWHit(results, queries, isMovie);
        if (!best) return { streams, subtitles };

        // 2) episode/movie page → find the zephyrflick embed among the server iframes
        const epUrl = (season != null && episode != null)
            ? `${BASE}/episode/${best.slug}-${season}x${episode}/`
            : `${BASE}/movies/${best.slug}/`;
        const epHtml = await flareSolverrGetHtml(epUrl);
        if (!epHtml) return { streams, subtitles };
        const $e = cheerio.load(epHtml);
        let zf = '';
        // The page exposes multiple servers as div[id^="options-"] iframes; pick the
        // zephyrflick one (src or lazy data-src).
        const iframeSrcs: string[] = [];
        $e('iframe').each((_i, el) => {
            const src = $e(el).attr('src') || $e(el).attr('data-src') || '';
            if (src) iframeSrcs.push(src);
            if (!zf && /zephyr(?:flick|ix)/i.test(src)) zf = new URL(src, `${BASE}/`).href;   // host rotates (.top → zephyrix.org)
        });
        const vid = (zf.match(/\/video\/([a-f0-9]+)/) || [])[1];
        if (process.env.ANIME_DEBUG) console.error('[AW] epUrl:', epUrl, 'htmlLen:', epHtml.length, 'iframes:', iframeSrcs.map((s) => s.slice(0, 70)), 'zf:', zf.slice(0, 50), 'vid:', vid);

        // No zephyrflick? AnimeWorld also serves via its OWN multi-language player
        // (player1.php?data=<base64 JSON of {langueage,url}>) — this is what cartoons
        // (Ben 10) and Hindi/Eng dubs use. Decode it and resolve each language's source.
        if (!vid) {
            const pm = epHtml.match(/player1\.php\?data=([A-Za-z0-9+/=_-]+)/i);
            if (pm) {
                let arr: any[] = [];
                try { arr = JSON.parse(Buffer.from(pm[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { /* */ }
                if (process.env.ANIME_DEBUG) console.error('[AW] player1 raw:', JSON.stringify(arr).slice(0, 500));
                for (const item of Array.isArray(arr) ? arr : []) {
                    // The URL field varies by site build — check every plausible key.
                    const url: string = item.url || item.file || item.src || item.link || item.embed || item.server || item.iframe || '';
                    const lang: string = item.langueage || item.language || item.lang || 'Original';
                    if (!url) continue;
                    if (/\.m3u8(\?|$)/i.test(url)) streams.push({ server: `AnimeWorld · ${lang}`, link: url, type: 'm3u8', headers: { Referer: `${BASE}/` } });
                    else if (/\.mp4(\?|$)/i.test(url)) streams.push({ server: `AnimeWorld · ${lang}`, link: url, type: 'mp4', headers: { Referer: `${BASE}/` } });
                    else {
                        // A short.icu/embed link — follow it to the real media, then fall
                        // back to the shared host resolver for known embed hosts.
                        const resolved = await resolveAWSource(url, BASE, UA);
                        if (resolved) {
                            streams.push({ server: `AnimeWorld · ${lang}`, link: resolved.link, type: resolved.type, headers: { Referer: `${BASE}/` } });
                        } else {
                            try {
                                const r = await loadExtractor(url, `${BASE}/`);
                                for (const s of r.streams) streams.push({ ...s, server: `AnimeWorld · ${lang} · ${s.server}` });
                                for (const su of r.subtitles) if (!subtitles.find((x) => x.url === su.url)) subtitles.push(su);
                            } catch { /* unsupported host */ }
                        }
                    }
                }
            }
            if (process.env.ANIME_DEBUG) console.error('[AW] player1 resolved streams:', streams.length);
            return { streams, subtitles };
        }

        // 3) solve zephyrflick's Cloudflare challenge once (primes the cookie jar for
        //    this host), which also gives us the iframe page for subtitle scraping.
        const ZEPHYR = new URL(zf).origin;
        const iframePage = await safeGet(zf, { cloudflare: true, headers: { 'User-Agent': UA } });

        // 3a) master m3u8 via the getVideo XHR (now carries the primed cf_clearance)
        let videoSource = '';
        try {
            const r = await app.post(`${ZEPHYR}/player/index.php?data=${vid}&do=getVideo`, `data=${vid}&do=getVideo`, {
                referer: zf,
                headers: {
                    'User-Agent': UA,
                    'X-Requested-With': 'XMLHttpRequest',
                    Origin: ZEPHYR,
                    Accept: 'application/json, text/plain, */*',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                timeout: 25000,
            });
            const json = r.json<any>();
            videoSource = json?.videoSource || json?.securedLink || '';
            if (process.env.ANIME_DEBUG) console.error('[AW] getVideo status:', r.status, 'bodyHead:', (r.text || '').slice(0, 120), 'src:', videoSource.slice(0, 60));
        } catch (e: any) { if (process.env.ANIME_DEBUG) console.error('[AW] getVideo err', e?.message); }
        if (!videoSource) return { streams, subtitles };

        // 3b) subtitles from the iframe page (playerjsSubtitle = "[Lang]url\n...")
        try {
            const sm = (iframePage?.text || '').match(/var playerjsSubtitle\s*=\s*"([^"]+)"/);
            if (sm) {
                for (const line of sm[1].split(/\\n|\r?\n/)) {
                    const mm = line.match(/\[([^\]]+)\](.+)/);
                    if (mm) subtitles.push({ language: mm[1].trim(), url: mm[2].trim() });
                }
            }
        } catch { /* */ }

        // Single source — the master carries all language audio tracks (Hindi/Tamil/
        // Telugu/Eng/Jap); the player lists them from the manifest and switches audio.
        streams.push({ server: 'AnimeWorld', link: videoSource, type: 'm3u8', headers: { Referer: `${ZEPHYR}/`, Origin: ZEPHYR } });
        return { streams, subtitles };
    },
};
