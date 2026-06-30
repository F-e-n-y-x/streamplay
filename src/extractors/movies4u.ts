import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';

/**
 * Movies4u — ported from invokeMovies4u (StreamPlayExtractor.kt ~4596).
 *
 * Flow:
 *   1. /?s=<title year> -> `article h2 a, article h3 a` candidate posts.
 *   2. open each post, read IMDb id from `p a:contains(IMDb Rating)` href -> must equal imdbId.
 *   3. movie: `div.download-links-div a.btn` -> inner page ->
 *             `div.downloads-btns-div a.btn` host links.
 *      tv:    `div.downloads-btns-div` whose previous sibling text has "Season N" ->
 *             first non-zip a.btn -> episode page -> Nth downloads-btns-div -> a.btn host links.
 *   4. loadExtractor each host.
 */
export const Movies4uProvider: Provider = {
    id: 'movies4u',
    name: 'Movies4u',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        try {
            const api = await getDomain('movies4u');
            if (!api) return result;
            // Kotlin matches on imdbId (passed as `id`). Without it we can't verify a post.
            const wantImdb = data.imdbId;
            if (!wantImdb) return result;

            const searchQuery = `${data.title || ''} ${data.year || ''}`.trim();
            const searchDoc = (await safeGet(`${api}/?s=${encodeURIComponent(searchQuery)}`, { cloudflare: true })).document;

            const postUrls: string[] = [];
            searchDoc('article h2 a, article h3 a').each((_, el) => {
                const href = searchDoc(el).attr('href') || '';
                if (href && !postUrls.includes(href)) postUrls.push(href);
            });

            const hostUrls = new Set<string>();

            for (const postUrl of postUrls) {
                const postDoc = (await safeGet(postUrl, { cloudflare: true })).document;
                const imdbHref = postDoc('p a:contains(IMDb Rating)').attr('href') || '';
                const imdbId = imdbHref.split('title/')[1]?.split('/')[0] || '';
                if (imdbId !== wantImdb) continue;

                if (data.season == null) {
                    const innerUrl = postDoc('div.download-links-div a.btn').attr('href') || '';
                    if (!innerUrl) continue;
                    const innerDoc = (await safeGet(innerUrl, { cloudflare: true })).document;
                    innerDoc('div.downloads-btns-div a.btn').each((_, el) => {
                        const href = innerDoc(el).attr('href') || '';
                        if (href) hostUrls.add(href);
                    });
                } else {
                    const blocks = postDoc('div.downloads-btns-div').toArray();
                    for (const block of blocks) {
                        const headerText = postDoc(block).prev().text() || '';
                        if (!new RegExp(`Season ${data.season}`, 'i').test(headerText)) continue;

                        const seasonLink = postDoc(block).find('a.btn').toArray()
                            .map(a => postDoc(a))
                            .find(a => !/zip/i.test(a.text()))
                            ?.attr('href') || '';
                        if (!seasonLink) continue;

                        const episodeDoc = (await safeGet(seasonLink, { cloudflare: true })).document;
                        const episodeBlocks = episodeDoc('div.downloads-btns-div').toArray();
                        if (data.episode != null && data.episode >= 1 && data.episode <= episodeBlocks.length) {
                            const epBlock = episodeBlocks[data.episode - 1];
                            episodeDoc(epBlock).find('a.btn').each((_, el) => {
                                const href = episodeDoc(el).attr('href') || '';
                                if (href) hostUrls.add(href);
                            });
                        }
                    }
                }
            }

            for (const hostUrl of hostUrls) {
                const hosted = await loadExtractor(hostUrl, '');
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `Movies4u ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            }
        } catch (e: any) {
            console.error('Error in Movies4u extractor:', e?.message || e);
        }
        return result;
    },
};
