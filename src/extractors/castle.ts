import crypto from 'crypto';
import axios from 'axios';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';

/**
 * CastleTV (api.hlowb.com) — Indian streaming API with **multi-language** movies &
 * series (Hindi / Tamil / Telugu / … + Original), direct HLS. Responses are
 * AES-128-CBC encrypted; the key is derived from the upstream security key plus a
 * secret suffix (CASTLE_SUFFIX). Each language is returned as its own source.
 *
 * Requires CASTLE_SUFFIX to be set — without it the provider is inert.
 */

const API = 'https://api.hlowb.com';
const HEADERS = { Referer: API, 'User-Agent': 'okhttp/4.9.2', 'Content-Type': 'application/json' };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

let keyCache: { value: string; exp: number } | null = null;
async function securityKey(): Promise<string | null> {
    if (keyCache && keyCache.exp > Date.now()) return keyCache.value;
    try {
        const r = await axios.get(`${API}/v0.1/system/getSecurityKey/1?channel=IndiaA&clientType=1&lang=en-US`, { headers: { Referer: API }, timeout: 12000 });
        if (r.data?.code === 200 && r.data?.data) { keyCache = { value: r.data.data, exp: Date.now() + 3_600_000 }; return r.data.data; }
    } catch { /* */ }
    return null;
}

function deriveKey(b64: string): Buffer {
    const suffix = process.env.CASTLE_SUFFIX || '';
    let m = Buffer.concat([Buffer.from(b64, 'base64'), Buffer.from(suffix, 'ascii')]);
    if (m.length < 16) m = Buffer.concat([m, Buffer.alloc(16 - m.length)]);
    else if (m.length > 16) m = m.subarray(0, 16);
    return m;
}

function decrypt(encB64: string, keyB64: string): string | null {
    try {
        const k = deriveKey(keyB64);
        const d = crypto.createDecipheriv('aes-128-cbc', k, k);   // key == IV
        return Buffer.concat([d.update(Buffer.from(encB64, 'base64')), d.final()]).toString('utf8');
    } catch { return null; }
}

/** Big integers in the payload are unquoted → quote them so JSON.parse keeps precision. */
function parseDecrypted(s: string): any {
    try { return JSON.parse(s.replace(/([:[,]\s*)(-?\d{15,})(?=\s*[,}\]])/g, '$1"$2"')); } catch { return null; }
}

/** Unwrap an encrypted `{data}` envelope (or raw ciphertext) and decrypt+parse. */
function unwrap(raw: string, key: string): any {
    let enc = raw;
    try { const j = JSON.parse(raw); if (j.data) enc = j.data; } catch { /* raw ciphertext */ }
    const dec = decrypt(enc, key);
    if (dec === null) { keyCache = null; return null; }   // key likely rotated — drop cache so the next request refetches
    const p = parseDecrypted(dec);
    return p?.data !== undefined ? p.data : p;
}

async function encGet(url: string, key: string): Promise<any> {
    const r = await axios.get(url, { headers: HEADERS, timeout: 15000, transformResponse: (x) => x });
    return unwrap(String(r.data), key);
}

export const CastleProvider: Provider = {
    id: 'castle',
    name: 'CastleTV',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        const subtitles: Subtitle[] = [];
        if (!process.env.CASTLE_SUFFIX || !data.title) return { streams, subtitles };
        const key = await securityKey();
        if (!key) return { streams, subtitles };

        // 1) search → best title/year match
        const sr = await encGet(`${API}/film-api/v1.1.0/movie/searchByKeyword?channel=IndiaA&clientType=1&keyword=${encodeURIComponent(data.title)}&lang=en-US&mode=1&packageName=com.external.castle&page=1&size=20`, key);
        const rows: any[] = sr?.rows || sr?.list || [];
        if (!rows.length) return { streams, subtitles };
        const want = norm(data.title);
        const best = rows.map((m) => {
            const t = norm(m.title || '');
            let s = t === want ? 3 : (t.includes(want) || want.includes(t)) ? 1 : 0;
            if (data.year && m.publishTime) { try { if (new Date(m.publishTime).getFullYear() === data.year) s += 1; } catch { /* */ } }
            return { m, s };
        }).sort((a, b) => b.s - a.s)[0];
        if (!best || best.s === 0) return { streams, subtitles };

        // 2) details → the episode (movie = single episode; TV = match number)
        const det = await encGet(`${API}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&lang=en-US&movieId=${best.m.id}&packageName=com.external.castle`, key);
        const eps: any[] = det?.episodes || [];
        if (!eps.length) return { streams, subtitles };
        let ep = eps[0];
        if (data.type === 'tv' && data.episode) {
            const f = eps.find((e) => Number(e.number) === data.episode);
            if (!f) return { streams, subtitles };   // don't silently serve the wrong episode
            ep = f;
        }

        // 3) one video URL per language track (highest working resolution)
        const langs: any[] = (ep.tracks && ep.tracks.length) ? ep.tracks : [{ languageId: undefined, languageName: 'Original' }];
        await Promise.all(langs.map(async (lang) => {
            for (const res of [3, 2, 1]) {
                const body: any = {
                    mode: '1', appMarket: 'GuanWang', clientType: '1', woolUser: 'false',
                    apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475', androidVersion: '13',
                    movieId: String(best.m.id), episodeId: String(ep.id), isNewUser: 'true',
                    resolution: String(res), packageName: 'com.external.castle',
                };
                if (lang.languageId != null) body.languageId = Number(lang.languageId);
                let vd: any;
                try {
                    const r = await axios.post(`${API}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=com.external.castle&channel=IndiaA&lang=en-US`, JSON.stringify(body), { headers: HEADERS, timeout: 15000, transformResponse: (x) => x });
                    vd = unwrap(String(r.data), key);
                } catch { continue; }
                if (vd?.videoUrl && vd.permissionDenied !== true) {
                    const ln = lang.languageName || 'Original';
                    streams.push({ server: `CastleTV · ${ln}`, link: vd.videoUrl, type: vd.videoUrl.includes('.m3u8') ? 'm3u8' : 'mp4', headers: { Referer: `${API}/` } });
                    for (const s of vd.subtitles || []) {
                        if (s.url && !subtitles.find((x) => x.url === s.url)) subtitles.push({ language: s.title || s.abbreviate || 'Sub', url: s.url });
                    }
                    break;
                }
            }
        }));

        return { streams, subtitles };
    },
};
