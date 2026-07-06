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

/**
 * CastleTV tags every catalogue entry with a `movieTypeName`
 * (Anime / Movies / TV shows / Reality Shows / …). The SAME title often exists
 * as several mediums — e.g. searching "One Piece" returns the **anime**, the
 * **Netflix live-action** ("TV shows"), AND a dozen **movies**, all sharing the
 * title. Matching on title alone made an anime request land on the live-action or
 * a film ("playing a completely different anime"). We classify each row and score
 * medium alignment so an anime request wins the Anime entry, a movie wins a film,
 * and a (non-anime) series wins the live-action show.
 */
type Medium = 'anime' | 'movie' | 'tv' | '';
const mediumOf = (row: any): Medium => {
    const n = String(row?.movieTypeName || '').toLowerCase();
    if (/anime/.test(n)) return 'anime';
    if (/movie|film/.test(n)) return 'movie';
    if (/tv|show|series|drama|reality|season/.test(n)) return 'tv';
    return '';
};
const desiredMedium = (data: LinkData): Medium =>
    data.isAnime ? (data.type === 'movie' ? 'movie' : 'anime')
                 : (data.type === 'movie' ? 'movie' : 'tv');

/**
 * Token-based title match. CastleTV's keyword search is FUZZY — asking for a title
 * it doesn't carry returns a page of unrelated shows that merely share a filler
 * word ("… in Another World" returns 20 different isekai). A plain substring check
 * scored those as matches, so we'd play a completely different anime. Instead we
 * compare the DISTINCTIVE tokens (dropping filler like "the/in/another/world"): a
 * candidate must contain the smaller title's distinctive words to count, so a title
 * CastleTV lacks resolves to nothing rather than the wrong show.
 */
const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'to', 'and', 'or', 'my', 'with', 'season', 'part', 'world', 'another', 'life', 'story', 'movie', 'film', 'tv', 'series', 'saga', 'arc', 'chapter', 'no', 'wo', 'ga', 'isekai', 'de']);
const distinctiveTokens = (s: string) => norm(s).split(' ').filter((w) => w && !STOP.has(w));
function titleMatch(want: string, candidate: string): number {
    if (!want || !candidate) return 0;
    const nt = norm(candidate);
    if (nt === want) return 3;                       // exact
    const A = new Set(distinctiveTokens(want));
    const B = new Set(distinctiveTokens(candidate));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const w of A) if (B.has(w)) inter++;
    const contain = inter / Math.min(A.size, B.size);
    if (contain >= 0.999) return 2;                  // every distinctive token of the shorter side present
    if (contain >= 0.6) return 1;                    // strong partial
    return 0;
}

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

export interface CastleEp { number: number; title?: string }

/**
 * Episode list for a title straight from CastleTV — used to POPULATE the episode grid
 * when TMDB/TVDB have thin data (Indian daily soaps are rarely episode-catalogued
 * anywhere, but CastleTV carries every episode). Search + details only; no video
 * resolution, so it's cheap enough to call while building a title's season plan.
 */
export async function castleEpisodes(title: string, year?: number): Promise<CastleEp[]> {
    if (!process.env.CASTLE_SUFFIX || !title) return [];
    const key = await securityKey();
    if (!key) return [];
    try {
        const sr = await encGet(`${API}/film-api/v1.1.0/movie/searchByKeyword?channel=IndiaA&clientType=1&keyword=${encodeURIComponent(title)}&lang=en-US&mode=1&packageName=com.external.castle&page=1&size=20`, key);
        const rows: any[] = sr?.rows || sr?.list || [];
        if (!rows.length) return [];
        const want = norm(title);
        const best = rows.map((m) => {
            let s = titleMatch(want, m.title || '');
            if (s <= 0) return { m, s: 0 };
            if (year && m.publishTime) {
                try {
                    let pt: number | string = m.publishTime;
                    if (typeof pt === 'number' && pt > 0 && pt < 1e12) pt = pt * 1000;
                    const y = new Date(pt).getFullYear();
                    if (y > 1970) s += y === year ? 3 : -Math.min(2, Math.abs(y - year) * 0.5);
                } catch { /* */ }
            }
            return { m, s };
        }).sort((a, b) => b.s - a.s)[0];
        if (!best || best.s <= 0) return [];
        const det = await encGet(`${API}/film-api/v1.9.9/movie?channel=IndiaA&clientType=1&lang=en-US&movieId=${best.m.id}&packageName=com.external.castle`, key);
        const eps: any[] = det?.episodes || [];
        return eps
            .map((e) => ({ number: Number(e.number), title: e.title || e.name || undefined }))
            .filter((e) => Number.isFinite(e.number))
            .sort((a, b) => a.number - b.number);
    } catch { return []; }
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

        try {
        // 1) search → best title/year match
        const sr = await encGet(`${API}/film-api/v1.1.0/movie/searchByKeyword?channel=IndiaA&clientType=1&keyword=${encodeURIComponent(data.title)}&lang=en-US&mode=1&packageName=com.external.castle&page=1&size=20`, key);
        const rows: any[] = sr?.rows || sr?.list || [];
        if (!rows.length) return { streams, subtitles };
        const want = norm(data.title);
        const wantOrg = data.orgTitle ? norm(data.orgTitle) : '';
        const wantMedium = desiredMedium(data);
        // CastleTV lists each SEASON of a show as its own entry, usually with the
        // SAME title and only the year differing. Disambiguate by the selected
        // season's air year (falling back to the series year) — this is what stops
        // "S1E2" from landing on whichever same-titled entry happened to rank first.
        const targetYear = data.seasonYear || data.year;
        const best = rows.map((m) => {
            // A REAL title-token match is required first. Medium/year only refine an
            // already-matching candidate — they can never promote a zero-title row
            // (CastleTV's fuzzy search returns unrelated same-genre shows otherwise).
            let s = Math.max(titleMatch(want, m.title || ''), titleMatch(wantOrg, m.title || ''));
            if (s <= 0) return { m, s: 0 };
            // Medium alignment (anime vs live-action vs film) — the decisive tiebreak
            // when several mediums share the title. A wrong medium is penalised hard
            // so it drops below the `best.s <= 0` floor and is rejected rather than
            // served as "the wrong anime".
            const med = mediumOf(m);
            if (med) s += med === wantMedium ? 2 : -3;
            if (targetYear && m.publishTime) {
                try {
                    // publishTime may be ms-epoch, SECONDS-epoch, or an ISO string.
                    // A bare seconds value (< ~1e12) fed to new Date() reads as 1970,
                    // which collapsed the whole year tiebreak → wrong season picked.
                    let pt: number | string = m.publishTime;
                    if (typeof pt === 'number' && pt > 0 && pt < 1e12) pt = pt * 1000;
                    const y = new Date(pt).getFullYear();
                    if (y > 1970) s += y === targetYear ? 3 : -Math.min(2, Math.abs(y - targetYear) * 0.5);
                } catch { /* */ }
            }
            return { m, s };
        }).sort((a, b) => b.s - a.s)[0];
        if (!best || best.s <= 0) return { streams, subtitles };

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

        // 3) Request only tracks that have their OWN video file (existIndividualVideo)
        //    plus one default/master. Languages WITHOUT an individual file exist only
        //    as MUXED audio inside a master — a browser can't switch muxed audio
        //    (VLC can), and requesting them just returns a fallback file that plays
        //    the wrong language. So emitting them as "English"/"Hindi" sources is
        //    misleading; we skip them. The default source carries the master's own
        //    (usually original-language) audio.
        const tracks: any[] = (ep.tracks && ep.tracks.length) ? ep.tracks : [];
        const individual = tracks.filter((t) => t.existIndividualVideo === true);
        const reqs: { languageId?: number; name: string }[] = [{ name: 'Original' }];   // master default (no languageId)
        for (const t of individual) reqs.push({ languageId: Number(t.languageId), name: t.languageName || 'Original' });

        const perLang = await Promise.all(reqs.map(async (rq) => {
            for (const res of [3, 2, 1]) {
                const body: any = {
                    mode: '1', appMarket: 'GuanWang', clientType: '1', woolUser: 'false',
                    apkSignKey: 'ED0955EB04E67A1D9F3305B95454FED485261475', androidVersion: '13',
                    movieId: String(best.m.id), episodeId: String(ep.id), isNewUser: 'true',
                    resolution: String(res), packageName: 'com.external.castle',
                };
                if (rq.languageId != null) body.languageId = rq.languageId;
                let vd: any;
                try {
                    const r = await axios.post(`${API}/film-api/v2.0.1/movie/getVideo2?clientType=1&packageName=com.external.castle&channel=IndiaA&lang=en-US`, JSON.stringify(body), { headers: HEADERS, timeout: 15000, transformResponse: (x) => x });
                    vd = unwrap(String(r.data), key);
                } catch { continue; }
                if (vd?.videoUrl && vd.permissionDenied !== true) {
                    return { name: rq.name, url: vd.videoUrl as string, subs: (vd.subtitles || []) as any[] };
                }
            }
            return null;
        }));

        // CastleTV frequently returns the SAME underlying file for several
        // languageIds (only the auth token differs) — i.e. a language it doesn't
        // actually carry falls back to the default track. Dedupe by the file path
        // (ignoring the auth query) so we don't list "Tamil"/"English" entries that
        // all play the same audio; keep the first language that resolved each file.
        const seenFile = new Set<string>();
        for (const r of perLang) {
            if (!r) continue;
            const fileKey = r.url.split('?')[0];
            if (seenFile.has(fileKey)) continue;
            seenFile.add(fileKey);
            streams.push({ server: `CastleTV · ${r.name}`, link: r.url, type: r.url.includes('.m3u8') ? 'm3u8' : 'mp4', headers: { Referer: `${API}/` } });
            for (const s of r.subs) {
                if (s.url && !subtitles.find((x) => x.url === s.url)) subtitles.push({ language: s.title || s.abbreviate || 'Sub', url: s.url });
            }
        }

        } catch (e: any) {
            // encGet does not set validateStatus, so any non-2xx / timeout / reset
            // rejects. Every sibling extractor degrades to a partial result rather
            // than throwing out of invoke() (which also leaks a raw stack via the
            // /debug endpoint) — match that contract.
            console.error('Error in CastleTV extractor:', e?.message || e);
        }
        return { streams, subtitles };
    },
};
