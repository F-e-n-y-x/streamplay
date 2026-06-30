import crypto from 'crypto';
import { Provider, LinkData, ExtractorResult } from '../types';
import { app } from '../utils/http';
import { USER_AGENT } from '../utils/encdec';

const peachifyAPI = 'https://peachify.top';

const b64UrlDecode = (data: string): Buffer => {
    let fixed = data.replace(/-/g, '+').replace(/_/g, '/');
    fixed += '='.repeat((4 - (fixed.length % 4)) % 4);
    return Buffer.from(fixed, 'base64');
};

/** peachifyDecrypt() port: AES-256-GCM, key is the 64-hex string -> 32 bytes. */
const peachifyDecrypt = (encrypt: string): string | null => {
    try {
        const parts = encrypt.split('.');
        if (parts.length !== 3) return null;

        const iv = b64UrlDecode(parts[0]);
        const cipherTextWithTag = Buffer.concat([b64UrlDecode(parts[1]), b64UrlDecode(parts[2])]);

        const keyBytes = Buffer.from('a8f2a1b5e9c470814f6b2c3a5d8e7f9c1a2b3c4d5e3f7a8b8cad1e2d0a4d5c5b', 'hex');

        // GCM tag is the last 16 bytes of the ciphertext.
        const tag = cipherTextWithTag.subarray(cipherTextWithTag.length - 16);
        const cipherText = cipherTextWithTag.subarray(0, cipherTextWithTag.length - 16);

        const decipher = crypto.createDecipheriv('aes-256-gcm', keyBytes, iv);
        decipher.setAuthTag(tag);
        const decrypted = Buffer.concat([decipher.update(cipherText), decipher.final()]);
        return decrypted.toString('utf-8');
    } catch {
        return null;
    }
};

const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/**
 * Peachify — ported from invokePeachify (StreamPlayExtractor.kt).
 * Fans out across the eat-peach/peachify servers, decrypts the GCM payload,
 * and emits each source (handling /m3u8-proxy & /mp4-proxy query unwrapping).
 */
export const PeachifyProvider: Provider = {
    id: 'peachify',
    name: 'Peachify',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        const requestHeaders: Record<string, string> = {
            Accept: '*/*',
            'Accept-Language': 'en-US,en;q=0.5',
            Origin: peachifyAPI,
            Referer: `${peachifyAPI}/`,
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'cross-site',
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0',
        };

        const servers = [
            'https://usa.eat-peach.sbs/holly',
            'https://usa.eat-peach.sbs/multi',
            'https://usa.eat-peach.sbs/ice',
            'https://usa.eat-peach.sbs/air',
            'https://usa.eat-peach.sbs/net',
            'https://uwu.peachify.top/moviebox',
        ];

        try {
            const season = data.type === 'tv' ? data.season : undefined;

            await Promise.all(servers.map(async (server) => {
                try {
                    const apiUrl = season == null
                        ? `${server}/movie/${data.id}`
                        : `${server}/tv/${data.id}/${season}/${data.episode}`;

                    const text = (await app.get(apiUrl, { headers: requestHeaders })).text;
                    let encrypt = '';
                    try { encrypt = JSON.parse(text)?.data || ''; } catch { return; }
                    if (!encrypt) return;

                    const decrypted = peachifyDecrypt(encrypt);
                    if (!decrypted) return;

                    const json = JSON.parse(decrypted);
                    const provider: string = json?.providerName || 'Peachify';
                    const sources = json?.sources;
                    if (!Array.isArray(sources)) return;

                    for (const src of sources) {
                        const rawUrl: string = src?.url || '';
                        if (!rawUrl) continue;
                        const dub: string = src?.dub || '';
                        const srcType: string = src?.type || 'hls';
                        const quality: number = src?.quality || 0;
                        const srcHeaders: Record<string, string> = src?.headers || {};

                        const isProxy = rawUrl.includes('/m3u8-proxy') || rawUrl.includes('/mp4-proxy');

                        let finalUrl = rawUrl;
                        let proxyHeaders: Record<string, string> = {};

                        if (isProxy) {
                            const queryStr = rawUrl.includes('?') ? rawUrl.substring(rawUrl.indexOf('?') + 1) : '';
                            const query: Record<string, string> = {};
                            for (const param of queryStr.split('&')) {
                                const idx = param.indexOf('=');
                                if (idx < 0) continue;
                                try {
                                    const k = decodeURIComponent(param.substring(0, idx));
                                    const v = decodeURIComponent(param.substring(idx + 1));
                                    query[k] = v;
                                } catch { /* skip */ }
                            }
                            finalUrl = query['url'] || rawUrl;
                            if (query['headers']) {
                                try { proxyHeaders = JSON.parse(query['headers']) || {}; } catch { /* ignore */ }
                            }
                        } else {
                            proxyHeaders = { ...srcHeaders };
                        }

                        const finalReferer = proxyHeaders['referer'] || srcHeaders['referer'] || `${peachifyAPI}/`;
                        const finalOrigin = proxyHeaders['origin'] || srcHeaders['origin'] || peachifyAPI;
                        const finalUA = proxyHeaders['user-agent'] || srcHeaders['user-agent'] || USER_AGENT;

                        let name = `Peachify [${cap(provider)}]`;
                        if (dub) name += ` • ${dub}`;

                        result.streams.push({
                            server: name,
                            link: finalUrl,
                            type: srcType === 'hls' || finalUrl.includes('.m3u8') ? 'm3u8' : 'mp4',
                            quality: quality > 0 ? `${quality}p` : undefined,
                            headers: { Origin: finalOrigin, Referer: finalReferer, 'User-Agent': finalUA },
                        });
                    }
                } catch { /* skip server */ }
            }));
        } catch (e: any) {
            console.error('Error in Peachify extractor:', e?.message || e);
        }

        return result;
    }
};
