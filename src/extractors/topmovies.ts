import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';
import { bypassHrefli } from '../utils/bypass';

const FF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0';

/**
 * TopMovies — ported from invokeTopMovies (StreamPlayExtractor.kt ~2199).
 *
 * search by imdb id -> first article -> detail page (cloudflare/wpRedis).
 * Movie: maxbutton-download-links -> maxbutton-fast-server-gdrive.
 * TV:    maxbutton-g-drive -> episode link via "Episode N" strong span.
 * unblockedgames links get the href.li bypass.
 */
export const TopMoviesProvider: Provider = {
    id: 'topmovies',
    name: 'TopMovies',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        try {
            const api = await getDomain('topMovies');
            if (!api) return result;
            if (!data.imdbId) return result;

            const season = data.season;
            const episode = data.episode;

            const url = season == null
                ? `${api}/search/${data.imdbId}`
                : `${api}/search/${data.imdbId} Season ${season}`;

            const searchDoc = (await safeGet(url, { cloudflare: true })).document;
            const hrefpattern = searchDoc('#content_box article a').first().attr('href');
            if (!hrefpattern) return result;

            const res = (await safeGet(hrefpattern, { cloudflare: true, headers: { 'User-Agent': FF_UA } })).document;

            const pushHosted = async (finalLink: string) => {
                const hosted = await loadExtractor(finalLink, `${api}/`);
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `TopMovies ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            };

            if (season == null) {
                const detailPageUrls: string[] = [];
                res('a.maxbutton-download-links').each((_, a) => {
                    const h = res(a).attr('href');
                    if (h) detailPageUrls.push(h);
                });

                for (const detailPageUrl of detailPageUrls) {
                    let detailDoc;
                    try { detailDoc = (await safeGet(detailPageUrl, { cloudflare: true })).document; } catch { continue; }
                    const driveLinks: string[] = [];
                    detailDoc('a.maxbutton-fast-server-gdrive').each((_, a) => {
                        const h = detailDoc(a).attr('href');
                        if (h) driveLinks.push(h);
                    });
                    for (const driveLink of driveLinks) {
                        const finalLink = driveLink.includes('unblockedgames')
                            ? await bypassHrefli(driveLink)
                            : driveLink;
                        if (!finalLink) continue;
                        await pushHosted(finalLink);
                    }
                }
            } else {
                const detailPageUrls: string[] = [];
                res('a.maxbutton-g-drive').each((_, a) => {
                    const h = res(a).attr('href');
                    if (h) detailPageUrls.push(h);
                });

                for (const detailPageUrl of detailPageUrls) {
                    let detailDoc;
                    try { detailDoc = (await safeGet(detailPageUrl, { cloudflare: true })).document; } catch { continue; }

                    let episodeLink: string | undefined;
                    detailDoc('span strong').each((_, el) => {
                        if (episodeLink) return;
                        if (new RegExp(`Episode\\s+${episode}`, 'i').test(detailDoc(el).text())) {
                            episodeLink = detailDoc(el).closest('a').attr('href')
                                || detailDoc(el).parent().closest('a').attr('href');
                        }
                    });
                    if (!episodeLink) continue;

                    const finalLink = episodeLink.includes('unblockedgames')
                        ? await bypassHrefli(episodeLink)
                        : episodeLink;
                    if (!finalLink) continue;
                    await pushHosted(finalLink);
                }
            }
        } catch (e: any) {
            console.error('Error in TopMovies extractor:', e?.message || e);
        }
        return result;
    },
};
