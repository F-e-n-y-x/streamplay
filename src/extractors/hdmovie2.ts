import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult } from '../types';
import { app, safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';
import { createSlug } from '../utils/common';

/**
 * Hdmovie2 — ported from invokeHdmovie2 (StreamPlayExtractor.kt ~3556).
 *
 * Flow:
 *   1. /movies/<slug>-<year>
 *   2. read `ul#playeroptionsul > li`; POST admin-ajax (doo_player_ajax) to get embed_url,
 *      parse the iframe src out of it.
 *      - episode: 2nd <li>, nume = episode+1, type=movie
 *      - movie:   first <li> whose text has v2/v3, using its data-nume, type=movie
 *   3. if ajax failed: fallback to `a[href*=dwo]` -> `div > p > a` GDFlix links
 *      (following redirects via location header).
 *   4. loadExtractor the resolved embed / GDFlix link.
 */

const CHROME_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const getIframe = (html: string): string => cheerio.load(html)('iframe').attr('src') || '';

export const Hdmovie2Provider: Provider = {
    id: 'hdmovie2',
    name: 'Hdmovie2',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        try {
            const api = await getDomain('hdmovie2');
            if (!api) return result;
            const slug = createSlug(data.title);
            if (!slug) return result;

            const url = `${api}/movies/${slug}-${data.year}`;
            const headers = { 'User-Agent': CHROME_UA };
            const ajaxUrl = `${api}/wp-admin/admin-ajax.php`;
            const commonHeaders = { ...headers, 'Accept': '*/*', 'X-Requested-With': 'XMLHttpRequest' };

            const document = (await safeGet(url, { headers, cloudflare: true })).document;

            const fetchSource = async (post: string, nume: string, type: string): Promise<string> => {
                const body = new URLSearchParams({ action: 'doo_player_ajax', post, nume, type });
                const res = await app.post(ajaxUrl, body, {
                    referer: api,
                    headers: { ...commonHeaders, 'Content-Type': 'application/x-www-form-urlencoded' },
                });
                const json = res.json<{ embed_url?: string }>();
                return getIframe(json?.embed_url || '');
            };

            let link: string | null = null;
            const isEpisode = data.episode != null && data.season != null;

            if (isEpisode) {
                const li = document('ul#playeroptionsul > li').toArray()[1];
                if (li) {
                    const post = document(li).attr('data-post') || '';
                    const nume = ((data.episode as number) + 1).toString();
                    link = await fetchSource(post, nume, 'movie');
                }
            } else {
                const mv = document('ul#playeroptionsul > li').toArray()
                    .find(el => /v2|v3/i.test(document(el).text()));
                if (mv) {
                    const post = document(mv).attr('data-post') || '';
                    const nume = document(mv).attr('data-nume') || '';
                    link = await fetchSource(post, nume, 'movie');
                }
            }

            if (!link) {
                const type = isEpisode ? '(Combined)' : '';
                const dwoHrefs: string[] = [];
                document('a[href*=dwo]').each((_, el) => {
                    const h = document(el).attr('href') || '';
                    if (h) dwoHrefs.push(h);
                });

                for (const anchor of dwoHrefs) {
                    const innerDoc = (await safeGet(anchor, { cloudflare: true })).document;
                    const inner: string[] = [];
                    innerDoc('div > p > a').each((_, el) => {
                        const h = innerDoc(el).attr('href') || '';
                        if (h) inner.push(h);
                    });
                    for (const href of inner) {
                        if (!href.includes('GDFlix')) continue;
                        // follow redirects to the real GDFlix url via location header
                        let redirectedUrl = href;
                        for (let i = 0; i < 10; i++) {
                            const r = await app.get(href, { referer: anchor });
                            const loc = r.responseHeaders['location'];
                            if (loc) { redirectedUrl = loc; break; }
                        }
                        const hosted = await loadExtractor(redirectedUrl, '');
                        result.streams.push(...hosted.streams.map(s => ({ ...s, server: `Hdmovie2${type} ${s.server}` })));
                        result.subtitles.push(...hosted.subtitles);
                    }
                }
            } else {
                const hosted = await loadExtractor(link, api);
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `Hdmovie2 ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            }
        } catch (e: any) {
            console.error('Error in Hdmovie2 extractor:', e?.message || e);
        }
        return result;
    },
};
