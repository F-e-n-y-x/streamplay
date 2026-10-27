import net from '../utils/net';
import { Provider, LinkData, ExtractorResult, Stream } from '../types';
import { encDecPost, USER_AGENT } from '../utils/encdec';

const API = 'https://api.wecollege.net';
const headers = { Accept: '*/*', 'User-Agent': USER_AGENT, Origin: 'https://vidy.st', Referer: 'https://vidy.st/' };

/** Servers whose streams played end-to-end through /api/proxy (2026-10-27). Value = audio
 *  language ('' = original); delhi labels each source by language in `quality`.
 *  Dropped: reno (segments return HTML), paris (master → master loop), tampa/orlando (404). */
const SERVERS: Record<string, string> = {
    miami: '', boise: '', vegas: '', oakland: '', atlanta: '', phoenix: '', delhi: '', munich: 'German',
};
const LANG = /^(Hindi|English|Tamil|Telugu|Malayalam|Kannada|Bengali|Marathi|German|French|Spanish|Italian|Portuguese|Japanese|Korean)$/;

/**
 * VidEasy (vidy.st) — per-media `seed` → `{server}/sources?…&enc=2&seed=` returns an
 * encrypted blob → enc-dec.app `dec-videasy` → `{sources:[{url,quality}], subtitles}`.
 * Ref: smy778/EncDecEndpoints samples/videasy.py.
 */
export const VidEasyProvider: Provider = {
    id: 'videasy',
    name: 'VidEasy',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.title || !data.id) return result;
        const seed = (await net.get(`${API}/seed?mediaId=${data.id}`, { headers, timeout: 10000 })).data?.seed;
        if (!seed) return result;
        const qs = new URLSearchParams({
            title: encodeURIComponent(data.title), mediaType: data.type, year: String(data.year || ''),
            ...(data.type === 'tv' ? { episodeId: String(data.episode ?? 1), seasonId: String(data.season ?? 1) } : {}),
            tmdbId: String(data.id), imdbId: data.imdbId || '', enc: '2', seed,
        });
        const subs = new Set<string>();
        await Promise.all(Object.entries(SERVERS).map(async ([server, lang]) => {
            try {
                const enc = (await net.get(`${API}/${server}/sources?${qs}`, { headers, timeout: 12000, responseType: 'text' })).data;
                if (!enc || typeof enc !== 'string') return;
                const dec = (await encDecPost('dec-videasy', { text: enc, id: String(data.id), seed }))?.result;
                for (const s of dec?.sources || []) {
                    if (!s?.url) continue;
                    const q = String(s.quality || '');
                    const isRes = /^\d{3,4}p$/i.test(q);
                    const audio = lang || (LANG.test(q) ? q : '');
                    const st: Stream = {
                        server: `VidEasy · ${server}${audio ? ` · ${audio}` : ''}${isRes ? ` · ${q}` : ''}`,
                        link: s.url, type: /\.mp4(\?|$)/i.test(s.url) ? 'mp4' : 'm3u8', headers,
                        ...(isRes ? { quality: q } : {}), ...(audio ? { audioName: audio } : {}),
                    };
                    result.streams.push(st);
                }
                for (const sub of dec?.subtitles || []) {
                    if (sub?.url && !subs.has(sub.url)) { subs.add(sub.url); result.subtitles.push({ language: sub.language || sub.lang || 'Unknown', url: sub.url }); }
                }
            } catch { /* this server failed — others may answer */ }
        }));
        return result;
    },
};
