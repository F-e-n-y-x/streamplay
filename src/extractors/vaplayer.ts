import { Provider, LinkData, ExtractorResult } from '../types';
import { app } from '../utils/http';

const vaplayer = 'https://streamdata.vaplayer.ru';

interface VaplayerSub { lang?: string; code?: string; url?: string; }
interface VaplayerResponse {
    data?: { stream_urls?: string[] };
    default_subs?: VaplayerSub[];
}

/**
 * Vaplayer — ported from invokevaplayer (StreamPlayExtractor.kt).
 * Hits api.php with the TMDB id and returns the listed m3u8 stream URLs + subs.
 */
export const VaplayerProvider: Provider = {
    id: 'vaplayer',
    name: 'Vaplayer',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        try {
            const season = data.type === 'tv' ? data.season : undefined;
            const url = season == null
                ? `${vaplayer}/api.php?tmdb=${data.id}&type=movie`
                : `${vaplayer}/api.php?tmdb=${data.id}&type=tv&season=${season}&episode=${data.episode}`;

            const refer = 'https://nextgencloudfabric.com/';
            const response = (await app.get(url, { referer: refer })).json<VaplayerResponse>();
            const streamUrls = response?.data?.stream_urls;
            if (!streamUrls) return result;

            for (const sub of response?.default_subs ?? []) {
                if (!sub.url) continue;
                result.subtitles.push({ language: sub.lang || sub.code || 'Unknown', url: sub.url });
            }

            streamUrls.forEach((streamUrl, index) => {
                if (!streamUrl) return;
                result.streams.push({
                    server: `Vaplayer Server ${index + 1}`,
                    link: streamUrl,
                    type: streamUrl.includes('.m3u8') ? 'm3u8' : 'mp4',
                    headers: { Referer: refer },
                });
            });
        } catch (e: any) {
            console.error('Error in Vaplayer extractor:', e?.message || e);
        }

        return result;
    }
};
