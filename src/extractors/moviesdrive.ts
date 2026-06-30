import { Provider, LinkData, ExtractorResult } from '../types';
import { app, safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';

/**
 * MoviesDrive — ported from invokeMoviesdrive (StreamPlayExtractor.kt ~2850).
 *
 * Flow:
 *   1. /search.php?q=<imdbId> -> JSON {hits:[{document:{imdb_id,permalink}}]}
 *   2. open the matched permalink.
 *   3. movie: every `h5 > a` href -> extractMdrive(href) -> hubcloud/gdflix links
 *      tv:    find `h5` matching the season tag -> next sibling <a> -> episode page,
 *             then `h5` matching the episode tag -> next 1-2 sibling <a> hosts.
 *   4. loadExtractor each host.
 */

const MDRIVE_HOST_RE = /hubcloud|gdflix|gdlink/i;

/** Port of extractMdrive(): grab hubcloud/gdflix/gdlink anchors off a page. */
const extractMdrive = async (url: string): Promise<string[]> => {
    try {
        const $ = (await app.get(url)).document;
        const out: string[] = [];
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href') || '';
            if (MDRIVE_HOST_RE.test(href)) out.push(href);
        });
        return out;
    } catch {
        return [];
    }
};

const pad2 = (n?: number): string => (n != null && n < 10 ? `0${n}` : `${n}`);

export const MoviesDriveProvider: Provider = {
    id: 'moviesdrive',
    name: 'MoviesDrive',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        const imdbId = data.imdbId;
        if (!imdbId) return result;

        try {
            const domain = await getDomain('moviesdrive');
            if (!domain) return result;

            const searchRes = await safeGet(`${domain}/search.php?q=${imdbId}`, { cloudflare: true });
            const root = searchRes.json<any>();
            const hits: any[] = root?.hits || [];
            if (!hits.length) return result;

            const match = hits
                .map(h => h?.document)
                .find(d => d && d.imdb_id === imdbId);
            if (!match) return result;

            const permalink: string = match.permalink || '';
            if (!permalink) return result;
            const href = permalink.startsWith('http') ? permalink : domain + permalink;

            const mainDoc = (await safeGet(href, { cloudflare: true })).document;

            const hostUrls = new Set<string>();

            if (data.season == null) {
                const pageHrefs: string[] = [];
                mainDoc('h5 > a').each((_, el) => {
                    const h = mainDoc(el).attr('href') || '';
                    if (h && !pageHrefs.includes(h)) pageHrefs.push(h);
                });
                for (const page of pageHrefs) {
                    // The h5>a link is sometimes already a host (hubcloud/gdflix), and
                    // sometimes a MoviesDrive "graph" page that lists host links.
                    if (MDRIVE_HOST_RE.test(page)) {
                        hostUrls.add(page);
                    } else {
                        const servers = await extractMdrive(page);
                        for (const s of servers) hostUrls.add(s);
                    }
                }
            } else {
                const sSlug = pad2(data.season);
                const eSlug = pad2(data.episode);
                const seasonRe = new RegExp(`Season ${data.season}|S${sSlug}`, 'i');
                const epRe = new RegExp(`Ep${eSlug}|Ep${data.episode}`, 'i');

                const seasonEntries = mainDoc('h5').toArray().filter(el =>
                    seasonRe.test(mainDoc(el).text())
                );

                for (const entry of seasonEntries) {
                    const epPageHref = mainDoc(entry).next().find('a').first().attr('href') || '';
                    if (!epPageHref) continue;
                    try {
                        const epDoc = (await app.get(epPageHref)).document;
                        const fEp = epDoc('h5').toArray().find(el => epRe.test(epDoc(el).text()));
                        if (!fEp) continue;
                        const s1 = epDoc(fEp).next().find('a').first().attr('href');
                        const s2 = epDoc(fEp).next().next().find('a').first().attr('href');
                        if (s1) hostUrls.add(s1);
                        if (s2) hostUrls.add(s2);
                    } catch { /* skip episode page */ }
                }
            }

            for (const hostUrl of hostUrls) {
                const hosted = await loadExtractor(hostUrl, '');
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `MoviesDrive ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            }
        } catch (e: any) {
            console.error('Error in MoviesDrive extractor:', e?.message || e);
        }
        return result;
    },
};
