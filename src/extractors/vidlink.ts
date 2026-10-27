import net from '../utils/net';
import { Provider, LinkData, ExtractorResult } from '../types';
import { encDecGet, USER_AGENT } from '../utils/encdec';
import { HAKU_HEADERS } from './moviebox';

const VIDLINK_API = 'https://vidlink.pro';

/**
 * VidLink — enc-dec.app encrypts the TMDB id, `/api/b/...` returns either an HLS
 * `playlist` (+ optional `?headers=` JSON) or a `file` stream with per-quality mp4s
 * (MovieBox's hakunaymatata CDN — see HAKU_HEADERS) plus `captions`.
 */
export const VidlinkProvider: Provider = {
    id: 'vidlink',
    name: 'Vidlink',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (data.isAnime || !data.id) return result;
        const enc = (await encDecGet(`enc-vidlink?text=${data.id}`))?.result;
        if (!enc) return result;

        const headers = { 'User-Agent': USER_AGENT, Referer: `${VIDLINK_API}/`, Origin: VIDLINK_API };
        const apiUrl = data.season == null
            ? `${VIDLINK_API}/api/b/movie/${enc}`
            : `${VIDLINK_API}/api/b/tv/${enc}/${data.season}/${data.episode}`;
        const stream = (await net.get(apiUrl, { headers, timeout: 12000 })).data?.stream;
        if (!stream) return result;

        if (stream.playlist) {
            const reqHeaders: Record<string, string> = { ...headers };
            try { Object.assign(reqHeaders, JSON.parse(new URL(stream.playlist).searchParams.get('headers') || '{}')); } catch { /* none */ }
            result.streams.push({ server: 'Vidlink', link: stream.playlist, type: 'm3u8', headers: reqHeaders });
        }
        for (const [q, f] of Object.entries<any>(stream.qualities || {})) {
            if (!f?.url) continue;
            result.streams.push({
                server: `Vidlink · ${q}p`, link: f.url, quality: `${q}p`,
                type: f.type === 'hls' || /\.m3u8/.test(f.url) ? 'm3u8' : 'mp4',
                headers: f.headers && Object.keys(f.headers).length ? f.headers : HAKU_HEADERS,
            });
        }
        result.streams.sort((a, b) => (parseInt(b.quality || '0') || 0) - (parseInt(a.quality || '0') || 0));
        for (const c of stream.captions || []) if (c?.url) result.subtitles.push({ language: c.language || 'Unknown', url: c.url });
        return result;
    },
};
