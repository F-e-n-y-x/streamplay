import axios from 'axios';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';
import { guardUrl, guardRedirect, ssrfAgents, setAllowedOrigins } from '../utils/ssrf';
import { getAddonUrls } from '../utils/serverConfig';
import { magnetFromHash } from '../utils/torrentSearch';
import { getIndexQuality } from '../utils/common';
import { norm } from '../utils/season';

/**
 * Generic Stremio addons (STREMIO_ADDONS / admin /api/config/stremio): each manifest
 * becomes TWO providers — `stremio:<host>` (http `url` streams + the addon's subtitles,
 * normal fan-out) and `stremio-t:<host>` (`infoHash` → magnet, torrent mode only, like
 * the other torrent providers). Addressed by the best id form the addon declares
 * (`idPrefixes`): IMDb `tt…`, then `tmdb:…`, then `anilist:`/`mal:` for anime.
 */

interface Res { types: string[]; prefixes?: string[] }
export interface StremioManifest { name: string; types: string[]; stream?: Res; subtitles?: Res; configurationRequired: boolean }

/** `resources` may be strings ("stream") or objects ({name, types, idPrefixes}); missing = legacy stream-only. */
export const parseStremioManifest = (m: any): StremioManifest => {
    const types: string[] = Array.isArray(m?.types) ? m.types.map(String) : ['movie', 'series'];
    const top: string[] | undefined = Array.isArray(m?.idPrefixes) ? m.idPrefixes.map(String) : undefined;
    const out: StremioManifest = { name: String(m?.name || ''), types, configurationRequired: m?.behaviorHints?.configurationRequired === true };
    for (const r of Array.isArray(m?.resources) ? m.resources : ['stream']) {
        const name = typeof r === 'string' ? r : r?.name;
        if (name !== 'stream' && name !== 'subtitles') continue;
        out[name as 'stream' | 'subtitles'] = {
            types: Array.isArray(r?.types) ? r.types.map(String) : types,
            prefixes: Array.isArray(r?.idPrefixes) ? r.idPrefixes.map(String) : top,
        };
    }
    return out;
};

/** The id to request for this title from a resource, or null when the addon can't take any form we have. */
export const stremioId = (d: LinkData, r: Res): { type: string; id: string } | null => {
    const type = d.type === 'movie' ? 'movie' : 'series';
    if (!r.types.includes(type)) return null;
    const se = type === 'series' ? `:${d.season ?? 1}:${d.episode ?? 1}` : '';
    const ep = type === 'series' ? `:${d.episode ?? 1}` : '';
    const a = d.animeIds;
    const cands = [
        d.imdbId && `${d.imdbId}${se}`,
        d.id && `tmdb:${d.id}${se}`,
        a?.anilistId && `anilist:${a.anilistId}${ep}`,   // per-cour ids: episode only
        a?.malId && `mal:${a.malId}${ep}`,
    ].filter((x): x is string => !!x);
    // no idPrefixes = the classic IMDb-only addon
    const id = cands.find((c) => (r.prefixes || ['tt']).some((p) => c.startsWith(p)));
    return id ? { type, id } : null;
};

const strip = (s: string) => s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu, '').replace(/\s+/g, ' ').trim();
const QUALITY_RE = /\b(4k|uhd|2160p?|1440p?|1080p?|720p?|480p?|360p?|hdr(10\+?)?|dv|sdr)\b/gi;
const TECH_RE = /\.(mkv|mp4|avi|webm)\b|\b(mkv|mp4|x26[45]|h\.?26[45]|hevc|av1|hdr|dv|bluray|blu-ray|web-?dl|webrip|remux)\b/i;
const fmtSize = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
// ponytail: text heuristic for "configure me / sign in" placeholder streams (PenguPlay, Jackettio);
// a per-addon marker would be exact if one ever exists.
const PLACEHOLDER_RE = /\b(must sign in|sign in to|kindly configure|configure (this|the) addon|authentication is missing)\b/i;

/** Map a Stremio `streams` array: http urls → `http`, infoHash → `torrent` (magnets). */
export const mapStremioStreams = (label: string, items: any[], d?: LinkData): { http: Stream[]; torrent: Stream[]; subtitles: Subtitle[] } => {
    const http: Stream[] = [], torrent: Stream[] = [], subtitles: Subtitle[] = [];
    for (const s of Array.isArray(items) ? items : []) {
        const bh = s?.behaviorHints || {};
        const desc = String(s?.title || s?.description || '');
        const name = String(s?.name || '');
        if (PLACEHOLDER_RE.test(`${name} ${desc}`)) continue;
        // PenguPlay packs "<file>|^|<sort tag>.pad-<Source>" into filename; the head is a real
        // file name only when it has an extension ("1080pHLS1080phls" is just a sort key).
        const [head, tail] = String(bh.filename || '').split('|^|');
        const via = tail !== undefined ? /\.pad-(.+)$/.exec(tail)?.[1] : undefined;
        const filename = tail === undefined || /\.\w{2,4}$/.test(head) ? head : '';
        if (d && !fileMatches(filename, d)) continue;
        const all = `${name} ${desc} ${filename}`;
        const q = /\b(4k|uhd|2160p?)\b/i.test(all) ? 2160 : getIndexQuality(all);
        const quality = q ? `${q}p` : undefined;
        // inner source: the name minus emoji, the addon's own name and quality tags ("🐧 PenguPlay ❄️ 4K • VidFast · vBlaze" → "VidFast · vBlaze")
        const src = strip(name).split(/\s*(?:\n|•|·|\||-{1,2}\s)\s*/)
            .map((x) => x.replace(QUALITY_RE, '').replace(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '').trim())
            .filter(Boolean).join(' · ') || via || '';
        const lines = desc.split('\n').map(strip).filter(Boolean);
        const info = filename || lines.find((l) => TECH_RE.test(l)) || lines[0] || '';
        const size = typeof bh.videoSize === 'number' && bh.videoSize > 0 ? fmtSize(bh.videoSize) : '';
        const server = [label, src, info, size].filter(Boolean).join(' · ').slice(0, 160);
        if (typeof s?.url === 'string' && /^https?:\/\//i.test(s.url)) {
            const h = bh.proxyHeaders?.request;
            const headers = h && typeof h === 'object' ? Object.fromEntries(Object.entries(h).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined;
            // MKV / HEVC the browser can't play → the ffmpeg remux path (/api/torrent/http, via `debrid`).
            // ponytail: that path doesn't forward `headers`; fine for UA-only addons (PenguPlay).
            const mkv = /\.mkv(\?|$)/i.test(s.url) || /\.mkv$/i.test(filename) || (bh.notWebReady === true && /\b(mkv|hevc|x265|h\.?265)\b/i.test(all));
            http.push({
                server, link: s.url, origin: src || undefined, description: desc, addonName: name || undefined, type: /\.m3u8(\?|$)/i.test(s.url) || /\b(hls|m3u8)\b/i.test(desc) ? 'm3u8' : 'mp4',
                ...(quality ? { quality } : {}), ...(headers && Object.keys(headers).length ? { headers } : {}), ...(mkv ? { debrid: true } : {}),
            });
        } else if (typeof s?.infoHash === 'string' && /^[0-9a-f]{40}$/i.test(s.infoHash)) {
            torrent.push({ server, link: magnetFromHash(s.infoHash, filename || lines[0] || label), description: desc, addonName: name || undefined, type: 'mp4', ...(quality ? { quality } : {}) });
        } else continue;
        subtitles.push(...mapStremioSubs(s.subtitles));
    }
    return { http, torrent, subtitles };
};

/** A scene file name names its show + SxxEyy; drop ones for another title/episode
 *  (PenguPlay answered Breaking Bad S1E1 with "The.Bad.Guys.Breaking.In.S01E01"). */
export const fileMatches = (filename: string, d: LinkData): boolean => {
    const m = /^(.*?)[ ._-]S(\d{1,2})[ ._-]?E(\d{1,4})\b/i.exec(filename);
    if (!m || d.type !== 'tv') return true;
    if (d.season && d.episode && (Number(m[2]) !== d.season || Number(m[3]) !== d.episode)) return false;
    if (d.isAnime) return true;   // anime files use romaji/fansub names
    const show = ` ${norm(m[1])} `.replace(/ (19|20)\d\d /, ' ');
    // either side may carry extra words ("Marvel's Daredevil: Born Again" vs "Daredevil.Born.Again")
    return show.trim() === '' || [d.title, d.orgTitle].some((t) => {
        const want = ` ${norm(t || '').replace(/^the /, '')} `;
        return want.trim() !== '' && (show.includes(want) || want.includes(show.replace(/^ the /, ' ')));
    });
};

/** Stremio subtitle objects `{id, url, lang}` → Subtitle. */
export const mapStremioSubs = (items: any): Subtitle[] =>
    (Array.isArray(items) ? items : []).filter((t) => typeof t?.url === 'string' && /^https?:\/\//i.test(t.url))
        .map((t) => ({ language: String(t.lang || t.language || 'Unknown'), url: t.url }));

const get = async (url: string) => {
    const blocked = guardUrl(url);
    if (blocked) throw new Error(`blocked: ${blocked}`);
    return (await axios.get(url, { ...ssrfAgents(), beforeRedirect: guardRedirect, timeout: 30000 })).data;   // aggregators (PlavioHD) scrape 10+ sites per request
};

let http: Provider[] = [], torrent: Provider[] = [];

export async function reloadStremio(): Promise<void> {
    const urls = getAddonUrls('stremio');
    setAllowedOrigins('stremio', urls);
    const hosts = new Map<string, number>();
    const added = await Promise.all(urls.map(async (manifestUrl) => {
        let host: string;
        try { host = new URL(manifestUrl).host; } catch { return null; }
        // two addons on one host (e.g. Torrentio with two configs): `host`, `host~2`… (the
        // path may hold a token, so it never goes into the id)
        const n = (hosts.get(host) || 0) + 1;
        hosts.set(host, n);
        const key = n > 1 ? `${host}~${n}` : host;
        let m = parseStremioManifest({});
        try { m = parseStremioManifest(await get(manifestUrl)); } catch { /* register anyway — the addon may just be slow right now */ }
        const base = manifestUrl.replace(/\/manifest\.json(\?.*)?$/, '');
        const label = m.name || host;
        const call = async (r: Res | undefined, kind: string, d: LinkData) => {
            const id = r && stremioId(d, r);
            return id ? get(`${base}/${kind}/${id.type}/${id.id}.json`) : null;
        };
        const streams = async (d: LinkData) => mapStremioStreams(label, (await call(m.stream, 'stream', d))?.streams, d);
        const out: { h: Provider; t?: Provider } = {
            h: {
                id: `stremio:${key}`, name: label,
                invoke: async (d): Promise<ExtractorResult> => {
                    const [s, subs] = await Promise.all([streams(d), call(m.subtitles, 'subtitles', d).catch(() => null)]);
                    const seen = new Set<string>();
                    const subtitles = [...s.subtitles, ...mapStremioSubs(subs?.subtitles)].filter((x) => !seen.has(x.url) && !!seen.add(x.url));
                    return { streams: s.http, subtitles };
                },
            },
        };
        if (m.stream) out.t = { id: `stremio-t:${key}`, name: `${label} (torrents)`, invoke: async (d): Promise<ExtractorResult> => ({ streams: (await streams(d)).torrent.slice(0, 8), subtitles: [] }) };
        return out;
    }));
    http = added.flatMap((a) => (a ? [a.h] : []));
    torrent = added.flatMap((a) => (a?.t ? [a.t] : []));
}

export const stremioProviders = (): Provider[] => http;
export const stremioTorrentProviders = (): Provider[] => torrent;

if (getAddonUrls('stremio').length) void reloadStremio();
