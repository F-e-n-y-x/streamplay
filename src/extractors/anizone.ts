import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';
import { flareSolverrGetHtml } from '../utils/flaresolverr';

/**
 * AniZone (anizone.to) — anime provider with a single adaptive HLS stream that
 * carries multiple audio tracks (JP/KR/EN) plus many external subtitle tracks.
 *
 * Flow: search by title → open the episode page (`/anime/<slug>/<ep>`) → read the
 * <media-player src> (m3u8) and <track kind=subtitles> list. All requests go
 * through the persistent FlareSolverr session (site is Cloudflare-gated).
 */

const BASE = (process.env.ANIZONE_BASE_URL || 'https://anizone.to').replace(/\/+$/, '');

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const abs = (href: string) => (href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`);

export const AniZoneProvider: Provider = {
    id: 'anizone',
    name: 'AniZone',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        const subtitles: Subtitle[] = [];
        if (!data.isAnime || !data.title) return { streams, subtitles };

        const episode = data.type === 'movie' ? 1 : (data.episode ?? 1);

        // 1) search (try English title, then original) and pick the best match
        const candidates = [data.title, data.orgTitle].filter(Boolean) as string[];
        let animeHref = '';
        for (const q of candidates) {
            const html = await flareSolverrGetHtml(`${BASE}/anime?search=${encodeURIComponent(q)}`);
            if (!html) continue;
            const $ = cheerio.load(html);
            const results: { href: string; title: string }[] = [];
            $('div.grid > div.relative.overflow-hidden').each((_i, el) => {
                const t = $(el).find('a[title]');
                const href = t.attr('href') || '';
                const title = t.attr('title') || '';
                if (href && title) results.push({ href, title });
            });
            if (!results.length) continue;
            const want = norm(q);
            const best = results.find((r) => norm(r.title) === want)
                || results.find((r) => norm(r.title).includes(want) || want.includes(norm(r.title)))
                || results[0];
            animeHref = abs(best.href);
            break;
        }
        if (!animeHref) return { streams, subtitles };

        // 2) episode page → stream + subtitles
        const watchHtml = await flareSolverrGetHtml(`${animeHref.replace(/\/$/, '')}/${episode}`);
        if (!watchHtml) return { streams, subtitles };
        const $w = cheerio.load(watchHtml);

        const src = $w('media-player').attr('src');
        if (!src) return { streams, subtitles };

        $w('track[src][kind="subtitles"]').each((_i, el) => {
            const url = $w(el).attr('src');
            const label = $w(el).attr('label') || $w(el).attr('srclang');
            if (url && label) subtitles.push({ language: label, url });
        });

        // Single source — the master carries all audio renditions (JP/KR/EN); the
        // player enumerates them from the manifest and switches audio in-place.
        streams.push({ server: 'AniZone', link: src, type: src.endsWith('.mp4') ? 'mp4' : 'm3u8', headers: { Referer: `${BASE}/` } });
        return { streams, subtitles };
    },
};
