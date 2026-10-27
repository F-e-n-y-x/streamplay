import net from '../utils/net';
import { Provider, LinkData, ExtractorResult } from '../types';

/**
 * MovieBox — the public H5 web API (port of CSX `invokeMoviebox`, via the user's
 * nuvio-plugin cinestream/lib/sources/moviebox.ts). Replaces the mobile BFF
 * (api.inmoviebox.com, HMAC-signed) which now 404s / 406s datacenter IPs.
 *
 *   get-latest-app-pkgs → anon `x-user` header JSON {token}
 *   POST subject/search {keyword, subjectType} → items whose title is "<Title>" or "<Title> [Hindi]" (dub)
 *   h5.aoneroom.com post/list/subject?id= → detailPath
 *   subject/download + subject/play → direct mp4 (hakunaymatata CDN) + captions
 *
 * Parked in disabledProviders (2026-10-27): the flow resolves, but the bcdnw/bcdnxw CDN
 * hosts it hands out answer 429 to this server's direct AND WARP egress whatever the
 * headers; VidLink returns the same files on the `bcdn` host, which plays.
 */
const BASE = 'https://h5-api.aoneroom.com';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
// The hakunaymatata CDN answers 429 to ANY Referer and 428 to a browser UA without one;
// a plain non-browser UA gets the file (verified 2026-10-27).
export const HAKU_HEADERS = { 'User-Agent': 'okhttp/4.12.0' };
const unwrap = (j: any) => j?.data?.data ?? j?.data ?? j ?? {};
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const MovieBoxProvider: Provider = {
    id: 'moviebox',
    name: 'MovieBox',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.title) return result;
        const xUser = (await net.get(`${BASE}/wefeed-h5api-bff/app/get-latest-app-pkgs?app_name=moviebox`, { headers: { 'User-Agent': UA }, timeout: 10000 })).headers['x-user'];
        let token = '';
        try { token = JSON.parse(String(xUser || '{}')).token || ''; } catch { /* no token */ }
        if (!token) return result;
        const headers: Record<string, string> = {
            'X-Client-Info': '{"timezone":"Africa/Nairobi"}', 'Accept-Language': 'en-US,en;q=0.5', Accept: 'application/json',
            Referer: BASE, Authorization: `Bearer ${token}`, 'User-Agent': UA,
        };
        const isTv = data.type === 'tv';
        const search = (await net.post(`${BASE}/wefeed-h5api-bff/subject/search`,
            { keyword: data.title, page: 1, perPage: 24, subjectType: isTv ? 2 : 1 }, { headers, timeout: 12000 })).data;

        // "<Title>" (original audio) or "<Title> [Hindi]" (a dub), minus a trailing " S1-S3".
        const titleRe = new RegExp(`^${escRe(data.title)}(?:\\s+\\[([^\\]]+)\\])?$`, 'i');
        const ids = new Map<string, string>();
        for (const it of unwrap(search)?.items || []) {
            const m = titleRe.exec(String(it?.title || '').replace(/\sS\d+(?:-S?\d+)*$/i, ''));
            if (it?.subjectId && m && !ids.has(it.subjectId)) ids.set(it.subjectId, m[1] || 'Original');
        }

        const seenSubs = new Set<string>();
        await Promise.all([...ids].slice(0, 6).map(async ([subjectId, language]) => {
            try {
                const detail = (await net.get(`https://h5.aoneroom.com/wefeed-h5-bff/web/post/list/subject?id=${subjectId}`, { headers: { 'User-Agent': UA }, timeout: 10000 })).data;
                const detailPath = detail?.data?.items?.[0]?.subject?.detailPath;
                if (!detailPath) return;
                const params = `subjectId=${subjectId}${isTv ? `&se=${data.season ?? 1}&ep=${data.episode ?? 1}` : ''}&detailPath=${detailPath}`;
                const h = { ...headers, Referer: `https://fmoviesunblocked.net/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail`, Origin: 'https://fmoviesunblocked.net' };
                const [dl, play] = await Promise.all(['download', 'play'].map((k) =>
                    net.get(`${BASE}/wefeed-h5api-bff/subject/${k}?${params}`, { headers: h, timeout: 12000 }).then((r) => unwrap(r.data)).catch(() => ({}))));
                const seen = new Set<number>();
                const add = (url: string, res: number) => {
                    if (!url || seen.has(res)) return;
                    seen.add(res);
                    const audio = language === 'Original' ? '' : language;
                    result.streams.push({
                        server: `MovieBox${audio ? ` · ${audio}` : ''}${res ? ` · ${res}p` : ''}`, link: url,
                        type: /\.m3u8/.test(url) ? 'm3u8' : 'mp4', headers: HAKU_HEADERS,
                        ...(res ? { quality: `${res}p` } : {}),
                    });
                };
                for (const d of dl?.downloads || []) if (!d?.vipLocked) add(d?.url, Number(d?.resolution) || 0);
                for (const s of play?.streams || []) if (!s?.vipLocked) add(s?.url, parseInt(s?.resolutions, 10) || Number(s?.resolution) || 0);
                for (const c of dl?.captions || []) {
                    if (c?.url && !seenSubs.has(c.url)) { seenSubs.add(c.url); result.subtitles.push({ language: c.lanName || c.lan || 'Unknown', url: c.url }); }
                }
            } catch { /* this subject failed */ }
        }));
        result.streams.sort((a, b) => (parseInt(b.quality || '0') || 0) - (parseInt(a.quality || '0') || 0));
        return result;
    },
};
