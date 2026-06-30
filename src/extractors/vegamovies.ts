import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';

const VEGA_HEADERS: Record<string, string> = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Microsoft Edge";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'cookie': 'xla=s4t',
};

interface VegaDoc { id?: string; imdb_id?: string; permalink?: string; post_title?: string }
interface VegaHit { document?: VegaDoc }
interface VegaResponse { found?: number; hits?: VegaHit[] }

/**
 * VegaMovies — ported from invokeVegamovies (StreamPlayExtractor.kt ~2372).
 *
 * JSON search.php (by imdb id, then title) -> permalink page.
 * Movie: button.dwd-button -> intermediate page -> V-Cloud buttons -> loadExtractor.
 * TV:    walk h3/h5 season blocks -> V-Cloud/Single/Episode links -> episode page
 *        -> h4 "Episodes: N" -> sibling links -> loadExtractor.
 */
export const VegaMoviesProvider: Provider = {
    id: 'vegamovies',
    name: 'VegaMovies',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        try {
            const api = await getDomain('vegamovies');
            if (!api) return result;
            const imdb = data.imdbId;
            if (!imdb) return result;

            const season = data.season;
            const episode = data.episode;

            const fetchResults = async (query: string): Promise<VegaDoc[]> => {
                const url = `${api}/search.php?q=${query.replace(/ /g, '%20')}`;
                const res = await safeGet(url, { referer: api, headers: VEGA_HEADERS, cloudflare: true });
                const json = res.json<VegaResponse>();
                return (json?.hits || []).map(h => h.document).filter((d): d is VegaDoc => !!d);
            };

            let match: VegaDoc | undefined = (await fetchResults(imdb)).find(d => d.imdb_id?.toLowerCase() === imdb.toLowerCase());
            if (!match && data.title) {
                const results = await fetchResults(data.title);
                match = results.find(d => d.post_title?.toLowerCase().includes(data.title.toLowerCase())) || results[0];
            }
            if (!match?.permalink) return result;

            const mainDoc = (await safeGet(api + match.permalink, { referer: api, headers: VEGA_HEADERS, cloudflare: true })).document;

            const pushHosted = async (source: string) => {
                const hosted = await loadExtractor(source, '');
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `VegaMovies ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            };

            if (season == null) {
                const pages = new Set<string>();
                mainDoc('button.dwd-button').each((_, el) => {
                    const h = mainDoc(el).parent().attr('href');
                    if (h) pages.add(h);
                });

                for (const page of pages) {
                    let doc;
                    try { doc = (await safeGet(page, { referer: api, headers: VEGA_HEADERS, cloudflare: true })).document; } catch { continue; }
                    const sources: string[] = [];
                    doc('button.btn').each((_, el) => {
                        if (/V-Cloud/i.test(doc(el).text())) {
                            const h = doc(el).parent().attr('href');
                            if (h) sources.push(h);
                        }
                    });
                    for (const source of sources) await pushHosted(source);
                }
                return result;
            }

            // TV
            const seasonRe = new RegExp(`Season ${season}`, 'i');
            const linkRe = /(V-Cloud|Single|Episode)/i;
            const pages = new Set<string>();

            mainDoc('h3,h5').each((_, header) => {
                const ht = mainDoc(header).text();
                if (!(seasonRe.test(ht) || /Episode/i.test(ht))) return;
                let sib = mainDoc(header).next();
                while (sib.length && !['h3', 'h5', 'h4'].includes((sib[0] as any).tagName)) {
                    sib.find('a').each((_, a) => {
                        if (linkRe.test(mainDoc(a).text())) {
                            const h = mainDoc(a).attr('href');
                            if (h) pages.add(h);
                        }
                    });
                    sib = sib.next();
                }
            });

            const episodeRe = new RegExp(`Episodes?:\\s*${episode}`, 'i');
            for (const page of pages) {
                let doc;
                try { doc = (await safeGet(page, { referer: api, headers: VEGA_HEADERS, cloudflare: true })).document; } catch { continue; }

                let epNode: ReturnType<typeof doc> | null = null;
                doc('h4').each((_, el) => {
                    if (epNode) return;
                    if (episodeRe.test(doc(el).text())) epNode = doc(el);
                });
                if (!epNode) continue;

                const links: string[] = [];
                (epNode as any).next().find('a').each((_: any, a: any) => {
                    if (linkRe.test(doc(a).text())) {
                        const h = doc(a).attr('href');
                        if (h) links.push(h);
                    }
                });
                for (const link of links) await pushHosted(link);
            }
        } catch (e: any) {
            console.error('Error in VegaMovies extractor:', e?.message || e);
        }
        return result;
    },
};
