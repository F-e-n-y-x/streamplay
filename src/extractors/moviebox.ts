import axios from 'axios';
import crypto from 'crypto';
import { Provider, LinkData, ExtractorResult, Stream } from '../types';
import { getQualityFromName, qualityLabel, base64Decode } from '../utils/common';

const MOVIEBOX_API = 'https://api.inmoviebox.com';

// From MovieBoxProvider.kt:
//   secretKeyDefault = base64Decode("NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==")
//     -> "76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O"
//   the HMAC key is base64DecodeArray(secretKeyDefault) i.e. base64-decode that string again.
const SECRET_KEY_DEFAULT_B64 = base64Decode('NzZpUmwwN3MweFNOOWpxbUVXQXQ3OUVCSlp1bElRSXNWNjRGWnIyTw==');
const HMAC_KEY = Buffer.from(SECRET_KEY_DEFAULT_B64, 'base64');

const md5Hex = (buf: Buffer | string): string =>
    crypto.createHash('md5').update(buf).digest('hex');

/** generateXClientToken(): "<ts>,<md5(reverse(ts))>" */
const generateXClientToken = (): string => {
    const ts = Date.now().toString();
    const reversed = ts.split('').reverse().join('');
    return `${ts},${md5Hex(reversed)}`;
};

const buildCanonicalString = (
    method: string,
    accept: string,
    contentType: string,
    url: string,
    body: string | null,
    timestamp: number
): string => {
    const parsed = new URL(url);
    const path = parsed.pathname || '';

    // sort query parameter names, join key=value (no re-encoding)
    const names = [...new Set([...parsed.searchParams.keys()])].sort();
    const query = names
        .map((key) => parsed.searchParams.getAll(key).map((v) => `${key}=${v}`).join('&'))
        .join('&');

    const canonicalUrl = query.length > 0 ? `${path}?${query}` : path;

    const bodyBytes = body != null ? Buffer.from(body, 'utf-8') : null;
    const bodyHash = bodyBytes
        ? md5Hex(bodyBytes.length > 102400 ? bodyBytes.subarray(0, 102400) : bodyBytes)
        : '';
    const bodyLength = bodyBytes ? bodyBytes.length.toString() : '';

    return `${method.toUpperCase()}\n${accept}\n${contentType}\n${bodyLength}\n${timestamp}\n${bodyHash}\n${canonicalUrl}`;
};

/** generateXTrSignature(): "<ts>|2|<base64(HmacMD5(canonical))>" */
const generateXTrSignature = (
    method: string,
    accept: string,
    contentType: string,
    url: string,
    body: string | null = null
): string => {
    const timestamp = Date.now();
    const canonical = buildCanonicalString(method, accept, contentType, url, body, timestamp);
    const sig = crypto.createHmac('md5', HMAC_KEY).update(Buffer.from(canonical, 'utf-8')).digest('base64');
    return `${timestamp}|2|${sig}`;
};

const X_CLIENT_INFO = JSON.stringify({
    package_name: 'com.community.oneroom',
    version_name: '3.0.13.0325.03',
    version_code: 50020088,
    os: 'android',
    os_version: '13',
    install_ch: 'ps',
    device_id: 'da2b99c821e6ea023e4be55b54d5f7d8',
    install_store: 'ps',
    gaid: '1b2212c1-dadf-43c3-a0c8-bd6ce48ae22d',
    brand: 'Windows',
    model: 'Subsystem for Android(TM)',
    system_language: 'en',
    net: 'NETWORK_WIFI',
    region: 'US',
    timezone: 'Asia/Calcutta',
    sp_code: '',
});

const MOVIEBOX_UA =
    'com.community.oneroom/50020088 (Linux; U; Android 13; en_US; Subsystem for Android(TM); Build/TQ3A.230901.001; Cronet/145.0.7582.0)';

const axGet = (url: string, headers: Record<string, string>) =>
    axios.get(url, { headers, timeout: 15000, validateStatus: () => true, transformResponse: (r) => r });

const axPost = (url: string, body: string, headers: Record<string, string>) =>
    axios.post(url, body, { headers, timeout: 15000, validateStatus: () => true, transformResponse: (r) => r });

const parse = (text: any): any => {
    try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
};

const decodeJwtExpiry = (token: string): number => {
    try {
        const payload = token.split('.')[1];
        if (!payload) return 0;
        const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
        return Number(JSON.parse(json).exp) || 0;
    } catch { return 0; }
};

const isTokenValid = (token?: string | null): boolean => {
    if (!token) return false;
    return decodeJwtExpiry(token) > Date.now() / 1000 + 3600;
};

let movieboxBearerToken: string | null = null;

const getMovieBoxToken = async (): Promise<string> => {
    if (isTokenValid(movieboxBearerToken)) return movieboxBearerToken!;

    const url = `${MOVIEBOX_API}/wefeed-mobile-bff/tab/ranking-list?tabId=0&categoryType=4516404531735022304&page=1&perPage=1`;
    const headers: Record<string, string> = {
        'user-agent': MOVIEBOX_UA,
        'accept': 'application/json',
        'content-type': 'application/json',
        'x-client-token': generateXClientToken(),
        'x-tr-signature': generateXTrSignature('GET', 'application/json', 'application/json', url),
        'x-client-info': X_CLIENT_INFO,
        'x-client-status': '0',
    };

    try {
        const res = await axGet(url, headers);
        const xUser = res.headers['x-user'];
        if (xUser) {
            const token = parse(xUser)?.token;
            if (token) {
                movieboxBearerToken = token;
                return token;
            }
        }
    } catch { /* ignore */ }
    return '';
};

const streamType = (url: string, format: string): Stream['type'] => {
    const u = url.toLowerCase();
    if (u.endsWith('.m3u8') || format.toLowerCase() === 'hls') return 'm3u8';
    return 'mp4';
};

/**
 * MovieBox — ported from invokeMovieBox (StreamPlayExtractor.kt).
 * Authenticates against the inmoviebox mobile BFF (HmacMD5-signed requests),
 * searches by title, resolves subjects + dubs, and emits play-info streams + captions.
 */
export const MovieBoxProvider: Provider = {
    id: 'moviebox',
    name: 'MovieBox',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        const title = data.title;
        if (!title) return result;

        try {
            const season = data.season ?? 0;
            const episode = data.episode ?? 0;
            const token = await getMovieBoxToken();

            const searchUrl = `${MOVIEBOX_API}/wefeed-mobile-bff/subject-api/search/v2`;
            const jsonBody = JSON.stringify({ page: 1, perPage: 10, keyword: title });
            const baseHeaders: Record<string, string> = {
                'user-agent': MOVIEBOX_UA,
                'accept': 'application/json',
                // The signed contentType is "application/json; charset=utf-8", so the actual
                // header must match it exactly or the server rejects with 407 Signature invalid.
                'content-type': 'application/json; charset=utf-8',
                'x-client-token': generateXClientToken(),
                'x-tr-signature': generateXTrSignature('POST', 'application/json', 'application/json; charset=utf-8', searchUrl, jsonBody),
                'x-client-info': X_CLIENT_INFO,
                'x-client-status': '0',
                'Authorization': `Bearer ${token}`,
            };

            const searchRes = await axPost(searchUrl, jsonBody, baseHeaders);
            if (searchRes.status !== 200) return result;

            const root = parse(searchRes.data);
            const results: any[] = root?.data?.results;
            if (!Array.isArray(results)) return result;

            const matchingIds: string[] = [];
            for (const r of results) {
                const subjects: any[] = r?.subjects;
                if (!Array.isArray(subjects)) continue;
                for (const subject of subjects) {
                    const name: string = subject?.title;
                    const id: string = subject?.subjectId;
                    const type: number = subject?.subjectType ?? 0;
                    if (name && id && name.toLowerCase().includes(title.toLowerCase()) && (type === 1 || type === 2)) {
                        matchingIds.push(id);
                    }
                }
            }
            if (matchingIds.length === 0) return result;

            await Promise.all(matchingIds.map(async (id) => {
                try {
                    const subjectUrl = `${MOVIEBOX_API}/wefeed-mobile-bff/subject-api/get?subjectId=${id}`;
                    const subjectHeaders: Record<string, string> = {
                        ...baseHeaders,
                        'content-type': 'application/json',
                        'x-client-token': generateXClientToken(),
                        'x-tr-signature': generateXTrSignature('GET', 'application/json', 'application/json', subjectUrl),
                        'Authorization': `Bearer ${token}`,
                    };
                    const subjectRes = await axGet(subjectUrl, subjectHeaders);

                    let authtoken = token;
                    const xUserHeader = subjectRes.headers['x-user'];
                    if (xUserHeader) {
                        const newToken = parse(xUserHeader)?.token;
                        if (newToken && isTokenValid(newToken)) {
                            authtoken = newToken;
                            movieboxBearerToken = newToken;
                        }
                    }

                    if (subjectRes.status !== 200) return;

                    const subjectJson = parse(subjectRes.data);
                    const subjectData = subjectJson?.data;

                    const subjectIds: Array<[string, string]> = [];
                    let originalLanguageName = 'Original';
                    const dubs = subjectData?.dubs;
                    if (Array.isArray(dubs)) {
                        for (const dub of dubs) {
                            const dubId: string = dub?.subjectId;
                            const lanName: string = dub?.lanName;
                            if (dubId && lanName) {
                                if (dubId === id) originalLanguageName = lanName;
                                else subjectIds.push([dubId, lanName]);
                            }
                        }
                    }
                    subjectIds.unshift([id, originalLanguageName]);

                    for (const [subjectId, language] of subjectIds) {
                        const playUrl = `${MOVIEBOX_API}/wefeed-mobile-bff/subject-api/play-info?subjectId=${subjectId}&se=${season}&ep=${episode}`;
                        const playHeaders: Record<string, string> = {
                            ...baseHeaders,
                            'content-type': 'application/json',
                            'x-client-token': generateXClientToken(),
                            'x-tr-signature': generateXTrSignature('GET', 'application/json', 'application/json', playUrl),
                            'Authorization': `Bearer ${authtoken}`,
                        };
                        const playRes = await axGet(playUrl, playHeaders);
                        if (playRes.status !== 200) continue;

                        const playRoot = parse(playRes.data);
                        const streams: any[] = playRoot?.data?.streams;
                        if (!Array.isArray(streams)) continue;

                        const langLabel = language.replace('dub', 'Audio');

                        for (const stream of streams) {
                            const streamId: string = stream?.id ?? `${subjectId}|${season}|${episode}`;
                            const format: string = stream?.format ?? '';
                            const signCookie: string | undefined =
                                stream?.signCookie && String(stream.signCookie).length > 0 ? String(stream.signCookie) : undefined;

                            const baseStreamHeaders: Record<string, string> = { Referer: MOVIEBOX_API };
                            if (signCookie) baseStreamHeaders['Cookie'] = signCookie;

                            const resolutionNodes: any[] = stream?.resolutionList ?? stream?.resolutions;
                            if (Array.isArray(resolutionNodes)) {
                                for (const resNode of resolutionNodes) {
                                    const resUrl: string = resNode?.resourceLink;
                                    if (!resUrl) continue;
                                    const quality: number = resNode?.resolution ?? 0;
                                    result.streams.push({
                                        server: `MovieBox ${langLabel}`,
                                        link: resUrl,
                                        type: streamType(resUrl, format),
                                        quality: qualityLabel(getQualityFromName(String(quality))),
                                        headers: baseStreamHeaders,
                                    });
                                }
                            } else {
                                const singleUrl: string = stream?.url;
                                if (!singleUrl) continue;
                                const resText: string = typeof stream?.resolutions === 'string' ? stream.resolutions : '';
                                result.streams.push({
                                    server: `MovieBox ${langLabel}`,
                                    link: singleUrl,
                                    type: streamType(singleUrl, format),
                                    quality: qualityLabel(getQualityFromName(resText)),
                                    headers: baseStreamHeaders,
                                });
                            }

                            // subtitles
                            const subLinks = [
                                `${MOVIEBOX_API}/wefeed-mobile-bff/subject-api/get-stream-captions?subjectId=${subjectId}&streamId=${streamId}`,
                                `${MOVIEBOX_API}/wefeed-mobile-bff/subject-api/get-ext-captions?subjectId=${subjectId}&resourceId=${streamId}&episode=${episode}`,
                            ];
                            for (const subLink of subLinks) {
                                try {
                                    const subHeaders: Record<string, string> = {
                                        'User-Agent': 'com.community.mbox.in/50020042 (Linux; U; Android 16; en_IN; sdk_gphone64_x86_64; Build/BP22.250325.006; Cronet/133.0.6876.3)',
                                        'Accept': '',
                                        'Content-Type': '',
                                        'X-Client-Info': '{"package_name":"com.community.mbox.in","version_name":"3.0.03.0529.03","version_code":50020042,"os":"android","os_version":"16","device_id":"da2b99c821e6ea023e4be55b54d5f7d8","install_store":"ps","gaid":"d7578036d13336cc","brand":"google","model":"sdk_gphone64_x86_64","system_language":"en","net":"NETWORK_WIFI","sp_code":""}',
                                        'X-Client-Status': '0',
                                        'x-client-token': generateXClientToken(),
                                        'x-tr-signature': generateXTrSignature('GET', '', '', subLink),
                                        'Authorization': `Bearer ${authtoken}`,
                                    };
                                    const subRes = await axGet(subLink, subHeaders);
                                    if (subRes.status !== 200) continue;
                                    const subRoot = parse(subRes.data);
                                    const captions: any[] = subRoot?.data?.extCaptions;
                                    if (Array.isArray(captions)) {
                                        for (const caption of captions) {
                                            const captionUrl: string = caption?.url;
                                            if (!captionUrl) continue;
                                            const lang: string = caption?.language || caption?.lanName || caption?.lan || 'Unknown';
                                            result.subtitles.push({ language: `${lang} (${langLabel})`, url: captionUrl });
                                        }
                                    }
                                } catch { /* skip sub link */ }
                            }
                        }
                    }
                } catch { /* skip id */ }
            }));
        } catch (e: any) {
            console.error('Error in MovieBox extractor:', e?.message || e);
        }

        return result;
    },
};
