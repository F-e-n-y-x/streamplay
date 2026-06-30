import axios from 'axios';
import crypto from 'crypto';
import { Provider, LinkData, ExtractorResult, Stream } from '../types';
import { USER_AGENT } from '../utils/encdec';

const VIDROCK_API = 'https://vidrock.ru';

// AES-CBC key from vidrockEncode() in StreamPlayUtils.kt
// base64Decode("eDdrOW1QcVQycld2WTh6QTViQzNuRjZoSjJsSzRtTjk=") -> "x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9"
const VIDROCK_KEY = 'x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9';

/** Mirrors vidrockEncode(): AES/CBC/PKCS5 then URL-safe base64. IV = first 16 bytes of the key. */
const vidrockEncode = (tmdb: number, type: string, season?: number, episode?: number): string => {
    const plain = (type === 'tv' && season != null && episode != null)
        ? `${tmdb}_${season}_${episode}`
        : `${tmdb}`;

    const key = Buffer.from(VIDROCK_KEY, 'utf-8');
    const iv = Buffer.from(VIDROCK_KEY.slice(0, 16), 'utf-8');
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()]);

    return encrypted.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
};

/**
 * Vidrock — ported from invokevidrock (StreamPlayExtractor.kt).
 * Encrypts the TMDB id, hits /api/<type>/<encoded>, and walks the returned
 * source map (direct mp4/m3u8 or a /playlist/ endpoint listing resolutions).
 */
export const VidrockProvider: Provider = {
    id: 'vidrock',
    name: 'Vidrock',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.id) return result;

        try {
            const type = data.season == null ? 'movie' : 'tv';
            const encoded = vidrockEncode(data.id, type, data.season, data.episode);
            const headers = { 'Origin': VIDROCK_API, 'User-Agent': USER_AGENT };

            const res = await axios.get(`${VIDROCK_API}/api/${type}/${encoded}`, { headers, timeout: 15000 });
            const sources = res.data;
            if (!sources || typeof sources !== 'object') return result;

            for (const key of Object.keys(sources)) {
                const src = sources[key];
                const rawUrl: string = src?.url || '';
                const lang: string = src?.language || 'Unknown';
                if (!rawUrl || rawUrl === 'null') continue;

                const safeUrl = rawUrl.includes('%') ? decodeURIComponent(rawUrl) : rawUrl;
                const displayName = `Vidrock [${key}] ${lang}`;

                if (safeUrl.includes('/playlist/')) {
                    try {
                        const playlist = (await axios.get(safeUrl, { headers, timeout: 15000 })).data;
                        if (Array.isArray(playlist)) {
                            for (const item of playlist) {
                                if (item?.url) {
                                    result.streams.push({
                                        server: `Vidrock-${key}`,
                                        link: item.url,
                                        type: item.url.includes('.m3u8') ? 'm3u8' : 'mp4',
                                        quality: item.resolution ? `${item.resolution}p` : undefined,
                                        headers
                                    });
                                }
                            }
                        }
                    } catch { /* skip playlist */ }
                } else {
                    const type: Stream['type'] = safeUrl.includes('.m3u8') ? 'm3u8' : 'mp4';
                    result.streams.push({ server: `Vidrock-${key}`, link: safeUrl, type, quality: lang, headers });
                }
            }
        } catch (error: any) {
            console.error('Error in Vidrock extractor:', error?.message || error);
        }

        return result;
    }
};
