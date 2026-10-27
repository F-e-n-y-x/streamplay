import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';
import { seasonRe, episodeRe } from '../utils/season';
import { VEGA_HEADERS } from './vegamovies';

/**
 * RogMovies — ported from invokeRogmovies (StreamPlayExtractor.kt ~2482).
 *
 * Flow:
 *   1. /search.php?q=<imdbId|title> -> JSON {hits:[{document:{imdb_id,post_title,permalink}}]}
 *   2. match by imdb_id, else by title keyword, else first.
 *   3. open permalink.
 *   4. movie: `button.dwd-button` parent href -> page -> `button.btn` (V-Cloud|G-Direct) parent href.
 *      tv:    h3/h5 matching "Season N" -> walk siblings -> a (V-Cloud|Single|Episode|G-Direct) ->
 *             page -> h4 matching "Episode N" -> next sibling a links.
 *   5. loadExtractor each source.
 */


const normalizeAlphaNumSpace = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]/g, '');

export const RogMoviesProvider: Provider = {
    id: 'rogmovies',
    name: 'RogMovies',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        try {
            const api = await getDomain('rogmovies');
            if (!api) return result;

            const search = async (query: string): Promise<any[]> => {
                const res = await safeGet(`${api}/search.php?q=${encodeURIComponent(query)}`, {
                    referer: api, headers: VEGA_HEADERS, cloudflare: true,
                });
                const json = res.json<any>();
                return (json?.hits || []).map((h: any) => h?.document).filter(Boolean);
            };

            const results = data.imdbId
                ? await search(data.imdbId)
                : (data.title ? await search(data.title) : []);
            if (!results.length) return result;

            const keywords = (data.title || '')
                .toLowerCase()
                .replace(/[^a-z0-9 ]/g, '')
                .split(' ')
                .filter(w => w.length > 2);

            const match =
                results.find(d => data.imdbId && (d.imdb_id || '').toLowerCase() === data.imdbId.toLowerCase()) ||
                results.find(d => {
                    const t = normalizeAlphaNumSpace(d.post_title || '');
                    return keywords.length > 0 && keywords.every(k => t.includes(k));
                });   // no blind results[0] — a wrong title is worse than none

            const permalink: string = match?.permalink;
            if (!permalink) return result;
            const mainDoc = (await safeGet(api + permalink, { referer: api, headers: VEGA_HEADERS, cloudflare: true })).document;

            const sources = new Set<string>();

            if (data.season == null) {
                const pages: string[] = [];
                mainDoc('button.dwd-button').each((_, el) => {
                    const href = mainDoc(el).parent().attr('href') || '';
                    if (href && !pages.includes(href)) pages.push(href);
                });

                for (const page of pages) {
                    try {
                        const doc = (await safeGet(page, { referer: api, headers: VEGA_HEADERS, cloudflare: true })).document;
                        doc('button.btn').each((_, el) => {
                            const t = doc(el).text();
                            if (/v-cloud|g-direct/i.test(t)) {
                                const href = doc(el).parent().attr('href') || '';
                                if (href) sources.add(href);
                            }
                        });
                    } catch { /* skip page */ }
                }
            } else {
                const sRe = seasonRe(data.season);
                const epRe = episodeRe(data.episode ?? 1);

                // collect candidate (season-block) links
                const headers = mainDoc('h3, h5').toArray().filter(el => sRe.test(mainDoc(el).text()));
                const pageLinks: string[] = [];
                for (const h of headers) {
                    let sib = mainDoc(h).next();
                    while (sib.length && !['h3', 'h5'].includes((sib.get(0) as any)?.tagName)) {
                        sib.find('a').each((_, a) => {
                            if (/v-cloud|single|episode|g-direct/i.test(mainDoc(a).text())) {
                                const href = mainDoc(a).attr('href') || '';
                                if (href && !pageLinks.includes(href)) pageLinks.push(href);
                            }
                        });
                        sib = sib.next();
                    }
                }

                for (const page of pageLinks) {
                    try {
                        const doc = (await safeGet(page, { referer: api, headers: VEGA_HEADERS, cloudflare: true })).document;
                        const epNode = doc('h4').toArray().find(el => epRe.test(doc(el).text()));
                        if (!epNode) continue;
                        doc(epNode).next().find('a').each((_, a) => {
                            if (/v-cloud|single|episode|g-direct/i.test(doc(a).text())) {
                                const href = doc(a).attr('href') || '';
                                if (href) sources.add(href);
                            }
                        });
                    } catch { /* skip page */ }
                }
            }

            for (const source of sources) {
                const hosted = await loadExtractor(source, '');
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `RogMovies ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            }
        } catch (e: any) {
            console.error('Error in RogMovies extractor:', e?.message || e);
        }
        return result;
    },
};
