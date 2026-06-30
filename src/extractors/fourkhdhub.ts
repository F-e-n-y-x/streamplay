import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';
import { getRedirectLinks } from '../utils/common';

/**
 * 4kHDHub — ported from invoke4khdhub (StreamPlayExtractor.kt ~3316).
 *
 * Flow:
 *   1. /?s=<title> -> `div.card-grid > a.movie-card`; match on movie-card-content
 *      containing the (normalized) title (+ year if available), else first by title.
 *   2. open the matched href.
 *   3. movie: `div.download-item a` href -> getRedirectLinks() -> loadExtractor.
 *      tv:    `div.episode-download-item` matching "Sxx"(+"Exx") ->
 *             `div.episode-links > a` href -> getRedirectLinks() -> loadExtractor.
 */
const pad2 = (n?: number): string => (n != null && n < 10 ? `0${n}` : `${n}`);

export const FourKHdHubProvider: Provider = {
    id: 'fourkhdhub',
    name: '4kHDHub',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        try {
            const domain = await getDomain('n4khdhub');
            if (!domain) return result;
            const query = (data.title || '').trim();
            if (!query) return result;

            const searchDoc = (await safeGet(`${domain}/?s=${encodeURIComponent(query)}`, { cloudflare: true })).document;
            const normalizedTitle = query.toLowerCase().trim();
            const yearStr = data.year ? data.year.toString() : null;

            const cards = searchDoc('div.card-grid > a.movie-card').toArray();
            const content = (el: any): string =>
                (searchDoc(el).find('div.movie-card-content').text() || '').toLowerCase();

            const matched =
                cards.find(el => {
                    const c = content(el);
                    return c.includes(normalizedTitle) && (yearStr == null || c.includes(yearStr));
                }) || cards.find(el => content(el).includes(normalizedTitle));
            if (!matched) return result;

            const link = searchDoc(matched).attr('href') || '';
            const url = link.startsWith('http') ? link : `${domain}${link}`;

            const doc = (await safeGet(url, { cloudflare: true })).document;

            const hrefs = new Set<string>();

            if (data.season == null) {
                doc('div.download-item a').each((_, el) => {
                    const h = doc(el).attr('href') || '';
                    if (h) hrefs.add(h);
                });
            } else {
                const seasonText = `S${pad2(data.season)}`;
                const episodeText = data.episode != null ? `E${pad2(data.episode)}` : null;
                doc('div.episode-download-item').each((_, el) => {
                    const text = doc(el).text();
                    const matchesSeason = text.toLowerCase().includes(seasonText.toLowerCase());
                    const matchesEp = episodeText == null || text.toLowerCase().includes(episodeText.toLowerCase());
                    if (matchesSeason && matchesEp) {
                        doc(el).find('div.episode-links > a').each((_, a) => {
                            const h = doc(a).attr('href') || '';
                            if (h) hrefs.add(h);
                        });
                    }
                });
            }

            for (const href of hrefs) {
                const source = (await getRedirectLinks(href)) || href;
                const hosted = await loadExtractor(source, '');
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `4kHDHub ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            }
        } catch (e: any) {
            console.error('Error in 4kHDHub extractor:', e?.message || e);
        }
        return result;
    },
};
