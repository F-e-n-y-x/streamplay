import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet } from '../utils/http';

const Vidsrcxyz = 'https://vidsrc-embed.su';

const httpsify = (u: string): string => (u.startsWith('//') ? 'https:' + u : u);
const getBaseUrl = (u: string): string => { try { const x = new URL(u); return `${x.protocol}//${x.host}`; } catch { return ''; } };

const b64decode = (s: string): string => Buffer.from(s, 'base64').toString('latin1');
const codesOf = (s: string): number[] => Array.from(s).map(c => c.charCodeAt(0));
const fromCodes = (a: number[]): string => a.map(c => String.fromCharCode(c)).join('');

/** Port of decryptMethods from StreamPlayUtils.kt. */
const decryptMethods: Record<string, (input: string) => string> = {
    TsA2KGDGux: (input) => {
        const rev = Array.from(input).reverse().join('').replace(/-/g, '+').replace(/_/g, '/');
        const decoded = b64decode(rev);
        return fromCodes(codesOf(decoded).map(c => c - 7));
    },
    ux8qjPHC66: (input) => {
        const reversed = Array.from(input).reverse().join('');
        const hexPairs = (reversed.match(/.{1,2}/g) || []).map(h => String.fromCharCode(parseInt(h, 16))).join('');
        const key = 'X9a(O;FMV2-7VO5x;Ao:dN1NoFs?j,';
        return fromCodes(codesOf(hexPairs).map((c, i) => c ^ key.charCodeAt(i % key.length)));
    },
    xTyBxQyGTA: (input) => {
        const filtered = Array.from(input).reverse().filter((_, i) => i % 2 === 0).join('');
        return b64decode(filtered);
    },
    IhWrImMIGL: (input) => {
        const reversed = Array.from(input).reverse().join('');
        const rot13 = Array.from(reversed).map(ch => {
            const c = ch.charCodeAt(0);
            if ((c >= 97 && c <= 109) || (c >= 65 && c <= 77)) return String.fromCharCode(c + 13);
            if ((c >= 110 && c <= 122) || (c >= 78 && c <= 90)) return String.fromCharCode(c - 13);
            return ch;
        }).join('');
        return b64decode(Array.from(rot13).reverse().join(''));
    },
    o2VSUnjnZl: (input) => {
        const from = 'xyzabcdefghijklmnopqrstuvwXYZABCDEFGHIJKLMNOPQRSTUVW';
        const to = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const map: Record<string, string> = {};
        for (let i = 0; i < from.length; i++) map[from[i]] = to[i];
        return Array.from(input).map(c => map[c] ?? c).join('');
    },
    eSfH1IRMyL: (input) => {
        const reversed = Array.from(input).reverse().join('');
        const shifted = fromCodes(codesOf(reversed).map(c => c - 1));
        return (shifted.match(/.{1,2}/g) || []).map(h => String.fromCharCode(parseInt(h, 16))).join('');
    },
    Oi3v1dAlaM: (input) => {
        const rev = Array.from(input).reverse().join('').replace(/-/g, '+').replace(/_/g, '/');
        const decoded = b64decode(rev);
        return fromCodes(codesOf(decoded).map(c => c - 5));
    },
    sXnL9MQIry: (input) => {
        const xorKey = 'pWB9V)[*4I`nJpp?ozyB~dbr9yt!_n4u';
        const hexDecoded = (input.match(/.{1,2}/g) || []).map(h => String.fromCharCode(parseInt(h, 16))).join('');
        const decrypted = fromCodes(codesOf(hexDecoded).map((c, i) => c ^ xorKey.charCodeAt(i % xorKey.length)));
        const shifted = fromCodes(codesOf(decrypted).map(c => c - 3));
        return b64decode(shifted);
    },
    JoAHUMCLXV: (input) => {
        const rev = Array.from(input).reverse().join('').replace(/-/g, '+').replace(/_/g, '/');
        const decoded = b64decode(rev);
        return fromCodes(codesOf(decoded).map(c => c - 3));
    },
    KJHidj7det: (input) => {
        const decoded = b64decode(input.slice(10, input.length - 16));
        const key = '3SAY~#%Y(V%>5d/Yg$G[Lh1rK4a;7ok';
        return fromCodes(codesOf(decoded).map((c, i) => c ^ key.charCodeAt(i % key.length)));
    },
    playerjs: (x) => {
        try {
            let a = x.slice(2);
            const b1 = (str: string): string => Buffer.from(str, 'latin1').toString('base64');
            const patterns = ['*,4).(_)()', '33-*.4/9[6', ':]&*1@@1=&', '=(=:19705/', '%?6497.[:4'];
            for (const k of patterns) a = a.split('/@#@/' + b1(k)).join('');
            return b64decode(a);
        } catch (e: any) {
            return `Failed to decode: ${e?.message}`;
        }
    },
};

const extractIframeUrl = async (url: string): Promise<string | null> => {
    const doc = (await safeGet(url)).document;
    const src = httpsify(doc('iframe').attr('src') || '');
    return src.length ? src : null;
};

const extractProrcpUrl = async (iframeUrl: string): Promise<string | null> => {
    const html = (await safeGet(iframeUrl, { referer: iframeUrl })).text;
    const m = /src:\s+'(.*?)'/.exec(html);
    if (!m) return null;
    return getBaseUrl(iframeUrl) + m[1];
};

const extractAndDecryptSource = async (prorcpUrl: string, referer: string): Promise<Array<[string, string]> | null> => {
    const responseText = (await safeGet(prorcpUrl, { referer })).text;
    const playerJsRegex = /Playerjs\(\{.*?file:"(.*?)".*?\}\)/s;
    const temp = playerJsRegex.exec(responseText)?.[1];

    let id: string | undefined;
    let content: string | undefined;
    if (temp) {
        id = 'playerjs';
        content = temp;
    } else {
        const $ = cheerio.load(responseText);
        const reporting = $('#reporting_content').first();
        if (!reporting.length) return null;
        const node = reporting.next();
        if (!node.length) return null;
        id = node.attr('id');
        content = node.text();
    }
    if (!id || !content) return null;

    const decrypted = decryptMethods[id]?.(content);
    if (!decrypted) return null;

    const vSubs: Record<string, string> = {
        v1: 'shadowlandschronicles.com',
        v2: 'cloudnestra.com',
        v3: 'thepixelpioneer.com',
        v4: 'putgate.org',
        v5: '',
    };
    const placeholderRegex = /\{(v\d+)\}/;

    const mirrors: Array<[string, string]> = decrypted
        .split(' or ')
        .map(s => s.trim())
        .filter(s => s.startsWith('http'))
        .map(rawUrl => {
            const match = placeholderRegex.exec(rawUrl);
            const version = match?.[1] || '';
            const domain = vSubs[version] || '';
            const finalUrl = domain ? rawUrl.replace(/\{v\d+\}/g, domain) : rawUrl;
            return [version, finalUrl] as [string, string];
        });

    return mirrors.length ? mirrors : null;
};

/**
 * VidSrcXyz — ported from invokeVidSrcXyz (StreamPlayExtractor.kt).
 */
export const VidSrcXyzProvider: Provider = {
    id: 'vidsrcxyz',
    name: 'VidsrcXYZ',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        const id = data.imdbId;
        if (!id) return result;

        try {
            const season = data.type === 'tv' ? data.season : undefined;
            const url = season == null
                ? `${Vidsrcxyz}/embed/movie?imdb=${id}`
                : `${Vidsrcxyz}/embed/tv?imdb=${id}&season=${season}&episode=${data.episode}`;

            const iframeUrl = await extractIframeUrl(url);
            if (!iframeUrl) return result;

            const prorcpUrl = await extractProrcpUrl(iframeUrl);
            if (!prorcpUrl) return result;

            const decryptedSource = await extractAndDecryptSource(prorcpUrl, iframeUrl);
            if (!decryptedSource) return result;

            const referer = prorcpUrl.split('rcp')[0];
            for (const [version, link] of decryptedSource) {
                const cap = version ? version.charAt(0).toUpperCase() + version.slice(1) : '';
                result.streams.push({
                    server: `VidsrcXYZ Server ${cap}`.trim(),
                    link,
                    type: link.includes('.m3u8') ? 'm3u8' : 'mp4',
                    headers: { Referer: referer },
                });
            }
        } catch (e: any) {
            console.error('Error in VidsrcXYZ extractor:', e?.message || e);
        }

        return result;
    }
};
