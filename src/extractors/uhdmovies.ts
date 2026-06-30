import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';
import { bypassHrefli, getBaseUrl } from '../utils/bypass';

const REDIRECT_RE = /window\.location\.replace\(["'](.*?)["']\)/;

/**
 * UHDMovies — ported from invokeUhdmovies (StreamPlayExtractor.kt ~1716).
 *
 * search -> first article -> detail page -> per-quality download links.
 * driveleech/driveseed links carry a JS window.location.replace redirect;
 * everything else goes through the href.li bypass.
 */
export const UhdMoviesProvider: Provider = {
    id: 'uhdmovies',
    name: 'UHDMovies',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        try {
            const api = await getDomain('uhdmovies');
            if (!api) return result;

            const query = (data.title || '').replace(/-/g, ' ').replace(/:/g, ' ').trim();
            if (!query) return result;

            const searchUrl = `${api}/search/${encodeURIComponent(`${query} ${data.year ?? ''}`.trim())}`;
            const searchDoc = (await safeGet(searchUrl, { cloudflare: true })).document;
            const pageUrl = searchDoc('article div.entry-image a').first().attr('href');
            if (!pageUrl) return result;

            const doc = (await safeGet(pageUrl, { cloudflare: true })).document;

            // p tags matching the season/year, whose NEXT sibling holds the download/episode link.
            const season = data.season;
            const episode = data.episode;
            const seasonRe = season == null
                ? new RegExp(`${data.year ?? ''}`)
                : new RegExp(`(S0?${season}|Season 0?${season})`, 'i');
            const epRe = season == null
                ? /Download/i
                : new RegExp(`Episode ${episode}`, 'i');

            const links: string[] = [];
            doc('div.entry-content p').each((_, el) => {
                const text = doc(el).text();
                if (!seasonRe.test(text)) return;
                const sib = doc(el).next();
                if (!sib.length) return;
                sib.find('a').each((__, a) => {
                    if (epRe.test(doc(a).text())) {
                        const href = doc(a).attr('href');
                        if (href && !links.includes(href)) links.push(href);
                    }
                });
            });

            for (const link of links) {
                let driveLink: string | null = null;
                try {
                    if (/driveleech/i.test(link) || /driveseed/i.test(link)) {
                        const text = (await safeGet(link, { cloudflare: true })).text;
                        const fileId = REDIRECT_RE.exec(text)?.[1];
                        if (!fileId) continue;
                        driveLink = getBaseUrl(link) + fileId;
                    } else {
                        driveLink = await bypassHrefli(link);
                    }
                } catch { continue; }
                if (!driveLink) continue;

                const hosted = await loadExtractor(driveLink, '');
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `UHDMovies ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            }
        } catch (e: any) {
            console.error('Error in UHDMovies extractor:', e?.message || e);
        }
        return result;
    },
};
