import net from '../utils/net';
import { Provider, LinkData, ExtractorResult } from '../types';
import { anilistEpisode } from '../anime';
import { USER_AGENT } from '../utils/encdec';

const BASE = 'https://animekizz.live';
// A browser UA is required ("Access denied for automated client" otherwise).
const headers = { 'User-Agent': USER_AGENT, Referer: `${BASE}/`, Origin: BASE };

/**
 * Animekizz — JSON API keyed by AniList id (port of CSX `invokeAnimekizz`):
 * GET video/servers/{slug}-{anilistId}:{ep} (the slug part is ignored) → POST
 * video/resolve {episode_id, server_id} → signed HLS via the site's own /proxy.
 * Also returns intro/outro `chapters` — dropped: Stream has no skip-times field yet.
 */
export const AnimekizzProvider: Provider = {
    id: 'animekizz',
    name: 'Animekizz',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        const target = anilistEpisode(data);
        if (!target) return result;
        const episodeId = `anime-${target.id}:${target.ep}`;
        const servers: any[] = (await net.get(`${BASE}/api/v1/video/servers/${episodeId}`, { headers, timeout: 12000 })).data?.servers || [];
        const subs = new Set<string>();
        await Promise.all(servers.filter((s) => s?.id).map(async (sv) => {
            try {
                const r = (await net.post(`${BASE}/api/v1/video/resolve`, { episode_id: episodeId, server_id: sv.id }, { headers, timeout: 15000 })).data;
                const audio = sv.server_type === 'dub' ? 'English (Dub)' : 'Japanese (Sub)';
                for (const s of r?.sources || []) {
                    if (!s?.url) continue;
                    const link = s.url.startsWith('/') ? BASE + s.url : s.url;
                    result.streams.push({
                        server: `Animekizz · ${sv.name || sv.id} · ${audio}`, link,
                        type: String(s.format).toLowerCase() === 'hls' || /\.m3u8/.test(link) ? 'm3u8' : 'mp4',
                        ...(/^\d{3,4}p$/.test(s.quality) ? { quality: s.quality } : {}), headers,
                    });
                    for (const t of s.subtitles || []) {
                        const lang = t?.label || t?.language;
                        if (!t?.url || !lang || subs.has(lang)) continue;   // unlabeled = thumbnails track
                        subs.add(lang);
                        result.subtitles.push({ language: lang, url: t.url.startsWith('/') ? BASE + t.url : t.url });
                    }
                }
            } catch { /* this server failed */ }
        }));
        return result;
    },
};
