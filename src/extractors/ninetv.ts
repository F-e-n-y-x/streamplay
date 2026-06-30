import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet, app } from '../utils/http';

const nineTvAPI = 'https://moviesapi.club';

/**
 * NineTv — ported from invokeNinetv (StreamPlayExtractor.kt).
 *
 * Loads moviesapi.club/<type>/<id>, pulls the embedded <iframe src>, and then
 * resolves that iframe. The Kotlin uses loadExtractor() (a generic host resolver)
 * which we cannot fully port; we follow the iframe and best-effort scrape a direct
 * m3u8/mp4, otherwise return the iframe as a type:'iframe' stream for downstream
 * handling.
 */
export const NineTvProvider: Provider = {
    id: 'ninetv',
    name: 'NineTv',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        try {
            const season = data.type === 'tv' ? data.season : undefined;
            const url = season == null
                ? `${nineTvAPI}/movie/${data.id}`
                : `${nineTvAPI}/tv/${data.id}-${data.season}-${data.episode}`;

            const res = await safeGet(url, { referer: 'https://pressplay.top/' });
            if (res.status !== 200) return result;

            const iframe = res.document('iframe').first().attr('src');
            if (!iframe) return result;

            // Best-effort: follow the iframe and look for a direct stream URL.
            try {
                const embed = await app.get(iframe, { referer: `${nineTvAPI}/` });
                const html = embed.text;
                const m = /(https?:[^"'\\\s]+\.m3u8[^"'\\\s]*)/i.exec(html)
                    || /file\s*:\s*["']([^"']+\.m3u8[^"']*)["']/i.exec(html);
                if (m) {
                    result.streams.push({
                        server: 'NineTv',
                        link: m[1] || m[0],
                        type: 'm3u8',
                        headers: { Referer: iframe },
                    });
                    return result;
                }
            } catch { /* fall through to iframe */ }

            result.streams.push({
                server: 'NineTv',
                link: iframe,
                type: 'iframe',
                headers: { Referer: `${nineTvAPI}/` },
            });
        } catch (e: any) {
            console.error('Error in NineTv extractor:', e?.message || e);
        }

        return result;
    }
};
