import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';
import { bypassHrefli } from '../utils/bypass';

/**
 * MoviesMod — ported from invokeMoviesmod -> invokeModflix
 * (StreamPlayExtractor.kt ~2291 / ~2310).
 *
 * search by imdb id -> detail page -> quality headings (h4 for movie, h3 for tv)
 * -> intermediate page -> maxbutton/episode link -> bypassHrefli -> loadExtractor.
 */
export const MoviesModProvider: Provider = {
    id: 'moviesmod',
    name: 'MoviesMod',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        try {
            const api = await getDomain('moviesmod');
            if (!api) return result;
            if (!data.imdbId) return result;

            const season = data.season;
            const episode = data.episode;
            const id = data.imdbId;

            const searchUrl = season == null ? `${api}/search/${id}` : `${api}/search/${id} ${season}`;
            const searchDoc = (await safeGet(searchUrl, { cloudflare: true })).document;
            const href = searchDoc('#content_box article > a').first().attr('href');
            if (!href) return result;

            const hTag = season == null ? 'h4' : 'h3';
            const aTag = season == null ? 'Download' : 'Episode';
            const sTag = season == null ? '' : `(S0${season}|Season ${season})`;

            const res = (await safeGet(href, { cloudflare: true })).document;

            const headingRe = new RegExp(`${sTag}.*(480p|720p|1080p|2160p)`, 'i');
            const entries: ReturnType<typeof res>[] = [];
            res(`div.thecontent ${hTag}`).each((_, el) => {
                const text = res(el).text();
                if (headingRe.test(text) && !/moviesmod/i.test(text)) {
                    entries.push(res(el));
                }
            });

            for (const entry of entries) {
                const sib = entry.next();
                let link = '';
                sib.find('a').each((_, a) => {
                    if (link) return;
                    if (res(a).text().includes(aTag)) {
                        const h = res(a).attr('href') || '';
                        link = h.includes('=') ? h.split('=').pop() || '' : h;
                    }
                });
                if (!link) continue;

                const intermediate = (await safeGet(link, { cloudflare: true })).document;
                let source: string | undefined;
                if (season == null) {
                    source = intermediate('p a.maxbutton').first().attr('href');
                } else {
                    intermediate('h3 a').each((_, a) => {
                        if (source) return;
                        if (new RegExp(`Episode ${episode}`, 'i').test(intermediate(a).text())) {
                            source = intermediate(a).attr('href');
                        }
                    });
                }
                if (!source) continue;

                const bypassed = await bypassHrefli(source);
                if (!bypassed) continue;

                const hosted = await loadExtractor(bypassed, '');
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `MoviesMod ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            }
        } catch (e: any) {
            console.error('Error in MoviesMod extractor:', e?.message || e);
        }
        return result;
    },
};
