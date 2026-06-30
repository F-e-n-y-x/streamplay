import { Provider, LinkData, ExtractorResult } from '../types';
import { app } from '../utils/http';

const xpassAPI = 'https://play.xpass.top';

/** extractXpassBackups() port: regex out `var backups=[...]` and parse it. */
const extractXpassBackups = (html: string): Array<[string, string]> => {
    // Kotlin used `var backups=(\[.*?]);` but the live page now ends the array with
    // `]</script>` (no trailing `;`), so allow `;` OR `<` (or end) after the close.
    const m = /var backups=(\[[\s\S]*?])\s*(?:;|<)/.exec(html);
    if (!m) return [];
    let arr: any[];
    try { arr = JSON.parse(m[1]); } catch { return []; }
    const out: Array<[string, string]> = [];
    for (const obj of arr) {
        const name = obj?.name;
        const url = obj?.url;
        if (name && url) out.push([name, url]);
    }
    return out;
};

/**
 * Xpass — ported from invokeXpass (StreamPlayExtractor.kt).
 * Loads the embed page, extracts the `backups` array, then fetches each backup
 * JSON and walks playlist[0].sources.
 */
export const XpassProvider: Provider = {
    id: 'xpass',
    name: 'Xpass',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        try {
            const season = data.type === 'tv' ? data.season : undefined;
            const baseRef = `${xpassAPI}/`;
            const embedUrl = season == null
                ? `${xpassAPI}/e/movie/${data.id}`
                : `${xpassAPI}/e/tv/${data.id}/${season}/${data.episode}`;

            const html = (await app.get(embedUrl, { referer: baseRef })).text;
            const backups = extractXpassBackups(html);

            await Promise.all(backups.map(async ([name, url]) => {
                try {
                    const fullUrl = url.startsWith('http') ? url : xpassAPI + url;
                    const json = (await app.get(fullUrl)).json<any>();
                    const sources = json?.playlist?.[0]?.sources;
                    if (!Array.isArray(sources)) return;

                    for (const source of sources) {
                        const file: string = source?.file || '';
                        if (!file || !file.startsWith('http')) continue;
                        const type: string = source?.type || '';
                        const isM3u8 = /hls/i.test(type) || file.includes('.m3u8');

                        result.streams.push({
                            server: `Xpass [${name}]`,
                            link: file,
                            type: isM3u8 ? 'm3u8' : 'mp4',
                            headers: { Referer: baseRef },
                        });
                    }
                } catch { /* skip backup */ }
            }));
        } catch (e: any) {
            console.error('Error in Xpass extractor:', e?.message || e);
        }

        return result;
    }
};
