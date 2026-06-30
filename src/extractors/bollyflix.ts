import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet, app } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';
import { base64Decode } from '../utils/common';

/**
 * Bollyflix — ported from invokeBollyflix (StreamPlayExtractor.kt ~2925).
 *
 * search by imdb id -> each article -> detail page.
 * Quality headings (h5 movie / h4 tv, last 4) -> sibling <a>.
 * Links carrying `id=` are resolved through web.sidexfee.com -> base64.
 * Movie: loadExtractor directly. TV: open href, pick "Episode NN" link.
 */
export const BollyflixProvider: Provider = {
    id: 'bollyflix',
    name: 'Bollyflix',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        try {
            const api = await getDomain('bollyflix');
            if (!api) return result;
            if (!data.imdbId) return result;

            const season = data.season;
            const episode = data.episode;

            const res1 = (await safeGet(`${api}/search/${data.imdbId}`, { cloudflare: true, timeout: 10000 })).document;

            const articleHrefs: string[] = [];
            res1('div > article > a').each((_, a) => {
                const h = res1(a).attr('href');
                if (h) articleHrefs.push(h);
            });

            const pushHosted = async (href: string) => {
                const hosted = await loadExtractor(href, '');
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `Bollyflix ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            };

            for (const url of articleHrefs) {
                const res = (await safeGet(url, { cloudflare: true })).document;
                const hTag = season == null ? 'h5' : 'h4';
                const sTag = season == null ? '' : `Season ${season}`;
                const headingRe = new RegExp(`${sTag}.*(480p|720p|1080p|2160p)`, 'i');

                const entries: ReturnType<typeof res>[] = [];
                res(`div.thecontent.clearfix > ${hTag}`).each((_, el) => {
                    const text = res(el).text();
                    if (headingRe.test(text) && !/download/i.test(text)) entries.push(res(el));
                });
                const lastEntries = entries.slice(-4);

                for (const entry of lastEntries) {
                    let href = entry.next().find('a').first().attr('href');
                    if (!href) continue;

                    if (href.includes('id=')) {
                        const token = href.split('id=')[1];
                        const text = (await app.get(`https://web.sidexfee.com/?id=${token}`)).text;
                        const encoded = text.split('link":"')[1]?.split('"};')[0];
                        if (encoded) href = base64Decode(encoded);
                    }

                    if (season == null) {
                        await pushHosted(href);
                    } else {
                        const episodeText = `Episode ${String(episode).padStart(2, '0')}`;
                        const epDoc = (await safeGet(href, { cloudflare: true })).document;
                        let link: string | undefined;
                        epDoc('article h3 a').each((_, a) => {
                            if (link) return;
                            if (epDoc(a).text().includes(episodeText)) link = epDoc(a).attr('href');
                        });
                        if (link) await pushHosted(link);
                    }
                }
            }
        } catch (e: any) {
            console.error('Error in Bollyflix extractor:', e?.message || e);
        }
        return result;
    },
};
