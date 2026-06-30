import { Provider, LinkData, ExtractorResult, Stream } from '../types';
import { safeGet } from '../utils/http';
import { USER_AGENT } from '../utils/encdec';

const RIVESTREAM_API = 'https://www.rivestream.app';

const retry = async <T>(times: number, block: () => Promise<T>): Promise<T | null> => {
    for (let i = 0; i < times; i++) {
        try {
            return await block();
        } catch {
            /* retry */
        }
    }
    return null;
};

/**
 * RiveStream — ported from invokeRiveStream (StreamPlayExtractor.kt).
 *
 * Flow:
 *   1. Fetch the list of source services.
 *   2. Scrape the `_app` script from the homepage, extract the `let c = [...]` key array.
 *   3. Derive the secretKey via the cloudflare worker (input=id, cList=keys).
 *   4. For each source, fetch the stream JSON and push m3u8/mp4 links (handling proxy?url= wrapping).
 */
export const RiveStreamProvider: Provider = {
    id: 'rivestream',
    name: 'RiveStream',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.id) return result;

        try {
            const headers: Record<string, string> = { 'User-Agent': USER_AGENT };

            const sourceApiUrl =
                `${RIVESTREAM_API}/api/backendfetch?requestID=VideoProviderServices&secretKey=rive`;
            const sourceList = await retry(3, async () => (await safeGet(sourceApiUrl, { headers })).json<{ data: string[] }>());

            const doc = await retry(3, async () => (await safeGet(RIVESTREAM_API, { headers, timeout: 20000 })).document);
            if (!doc) return result;

            let appScript: string | undefined;
            doc('script').each((_, el) => {
                const src = doc(el).attr('src') || '';
                if (!appScript && src.includes('_app')) appScript = src;
            });
            if (!appScript) return result;

            const js = await retry(3, async () => (await safeGet(`${RIVESTREAM_API}${appScript}`, { headers })).text);
            if (!js) return result;

            // let c = ["...","..."] — pick the first array literal longer than 2 chars.
            let keyList: string[] = [];
            const arrMatches = js.matchAll(/let\s+c\s*=\s*(\[[^\]]*\])/g);
            for (const m of arrMatches) {
                if (m[1].length > 2) {
                    keyList = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
                    break;
                }
            }

            const secretKey = await retry(3, async () =>
                (await safeGet(`https://rivestream.supe2372.workers.dev/?input=${data.id}&cList=${keyList.join(',')}`, { headers })).text
            );
            if (!secretKey) return result;

            const services = sourceList?.data ?? [];

            await Promise.all(services.map(async (source) => {
                try {
                    const streamUrl = data.season == null
                        ? `${RIVESTREAM_API}/api/backendfetch?requestID=movieVideoProvider&id=${data.id}&service=${source}&secretKey=${secretKey}`
                        : `${RIVESTREAM_API}/api/backendfetch?requestID=tvVideoProvider&id=${data.id}&season=${data.season}&episode=${data.episode}&service=${source}&secretKey=${secretKey}`;

                    const responseString = await retry(3, async () => (await safeGet(streamUrl, { headers, timeout: 10000 })).text);
                    if (!responseString) return;

                    let json: any;
                    try { json = JSON.parse(responseString); } catch { return; }

                    const sourcesArray: any[] = json?.data?.sources;
                    if (!Array.isArray(sourcesArray)) return;

                    for (const src of sourcesArray) {
                        const srcName: string = src?.source || '';
                        const label = srcName.toLowerCase().includes('asiacloud')
                            ? `RiveStream ${srcName}[${src?.quality || ''}]`
                            : `RiveStream ${srcName}`;
                        const url: string = src?.url || '';
                        if (!url) continue;

                        try {
                            if (url.includes('proxy?url=')) {
                                const fullyDecoded = decodeURIComponent(url);
                                const encodedUrl = fullyDecoded.split('proxy?url=')[1]?.split('&headers=')[0] || '';
                                const decodedUrl = decodeURIComponent(encodedUrl);

                                const encodedHeaders = fullyDecoded.split('&headers=')[1] || '';
                                let headersMap: Record<string, string> = {};
                                try {
                                    headersMap = JSON.parse(decodeURIComponent(encodedHeaders));
                                } catch { headersMap = {}; }

                                const referer = headersMap['Referer'] || '';
                                const origin = headersMap['Origin'] || '';
                                const videoHeaders = { Referer: referer, Origin: origin };
                                const type: Stream['type'] = decodedUrl.toLowerCase().includes('.m3u8') ? 'm3u8' : 'mp4';

                                result.streams.push({
                                    server: label,
                                    link: decodedUrl,
                                    type,
                                    quality: '1080p',
                                    headers: videoHeaders,
                                });
                            } else {
                                const type: Stream['type'] = url.toLowerCase().includes('.m3u8') ? 'm3u8' : 'mp4';
                                result.streams.push({
                                    server: `${label} (VLC)`,
                                    link: url,
                                    type,
                                    quality: '1080p',
                                });
                            }
                        } catch {
                            /* skip source */
                        }
                    }
                } catch {
                    /* skip service */
                }
            }));
        } catch (e: any) {
            console.error('Error in RiveStream extractor:', e?.message || e);
        }

        return result;
    },
};
