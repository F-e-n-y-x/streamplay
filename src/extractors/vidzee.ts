import crypto from 'crypto';
import { Provider, LinkData, ExtractorResult, Stream } from '../types';
import { safeGet } from '../utils/http';
import { base64Decode } from '../utils/common';

const DEFAULT_REFERER = 'https://player.vidzee.wtf/';

// base64Decode("cGxlYXNlZG9udHNjcmFwZW1lc2F5d2FsbGFoaQ==") -> "pleasedontscrapemesaywallahi"
// padded to 32 bytes with NUL, used as the AES-256-CBC key.
const SECRET = base64Decode('cGxlYXNlZG9udHNjcmFwZW1lc2F5d2FsbGFoaQ==');
const KEY_BYTES = Buffer.concat([Buffer.from(SECRET, 'utf-8'), Buffer.alloc(32)]).subarray(0, 32);

/**
 * decryptVidzeeUrl(): the link is base64("<ivB64>:<ciphertextB64>") where both
 * inner parts are themselves base64. AES/CBC/PKCS5 with the padded secret key.
 */
const decryptVidzeeUrl = (encryptedUrl: string): string => {
    const decoded = Buffer.from(encryptedUrl, 'base64').toString('utf-8');
    const idx = decoded.indexOf(':');
    if (idx < 0) throw new Error('Invalid encrypted URL format');
    const ivB64 = decoded.slice(0, idx);
    const ciphertextB64 = decoded.slice(idx + 1);

    const iv = Buffer.from(ivB64, 'base64');
    const ciphertext = Buffer.from(ciphertextB64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-cbc', KEY_BYTES, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
};

/**
 * Vidzee — ported from invokeVidzee (StreamPlayExtractor.kt).
 * Iterates servers sr=1..8 hitting /api/server, decrypts each returned link and
 * pushes m3u8/mp4 streams plus subtitle tracks.
 */
export const VidzeeProvider: Provider = {
    id: 'vidzee',
    name: 'VidZee',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.id) return result;

        const isTv = data.season != null;

        await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(async (sr) => {
            try {
                const apiUrl = isTv
                    ? `https://player.vidzee.wtf/api/server?id=${data.id}&sr=${sr}&ss=${data.season}&ep=${data.episode}`
                    : `https://player.vidzee.wtf/api/server?id=${data.id}&sr=${sr}`;

                const json = (await safeGet(apiUrl)).json<any>();
                if (!json) return;

                const globalHeaders: Record<string, string> = {};
                if (json.headers && typeof json.headers === 'object') {
                    for (const k of Object.keys(json.headers)) globalHeaders[k] = String(json.headers[k]);
                }

                const urls: any[] = Array.isArray(json.url) ? json.url : [];
                for (const obj of urls) {
                    const encryptedLink: string = obj?.link || '';
                    const name: string = obj?.name || 'Vidzee';
                    const type: string = obj?.type || 'hls';
                    const lang: string = obj?.lang || 'Unknown';
                    const flag: string = obj?.flag || '';
                    if (!encryptedLink.trim()) continue;

                    let finalUrl: string;
                    try {
                        finalUrl = decryptVidzeeUrl(encryptedLink);
                    } catch {
                        finalUrl = encryptedLink;
                    }

                    try {
                        // eslint-disable-next-line no-new
                        new URL(finalUrl); // validate
                    } catch {
                        continue;
                    }

                    const referer = globalHeaders['referer'] || DEFAULT_REFERER;
                    const displayName = flag.trim()
                        ? `VidZee ${name} (${lang} - ${flag})`
                        : `VidZee ${name} (${lang})`;

                    const streamType: Stream['type'] = type.toLowerCase() === 'hls' ? 'm3u8' : 'mp4';
                    result.streams.push({
                        server: displayName,
                        link: finalUrl,
                        type: streamType,
                        quality: '1080p',
                        headers: { ...globalHeaders, Referer: referer },
                    });
                }

                const subs: any[] = Array.isArray(json.tracks) ? json.tracks : [];
                for (const sub of subs) {
                    const subLang: string = sub?.lang || 'Unknown';
                    const subUrl: string = sub?.url || '';
                    if (subUrl.trim()) result.subtitles.push({ language: subLang, url: subUrl });
                }
            } catch {
                /* skip server */
            }
        }));

        return result;
    },
};
