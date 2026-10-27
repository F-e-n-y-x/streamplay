import net from '../utils/net';
import { Provider, LinkData, ExtractorResult } from '../types';
import { anilistEpisode } from '../anime';
import { USER_AGENT } from '../utils/encdec';
import { getIndexQuality } from '../utils/common';

const API = 'https://api.just4anime.online/api/v1';
const headers = { 'User-Agent': USER_AGENT, Referer: 'https://just4anime.online/' };

/**
 * Just4Anime — JSON API keyed by AniList id (port of CSX `invokeJust4Anime`):
 * meta/availability/{id}/servers → for each server with the episode × type (sub/dub/h-sub)
 * → meta/sources/{id}?provider&num&type → HLS (via their CORS proxy) + subtitles.
 */
export const Just4AnimeProvider: Provider = {
    id: 'just4anime',
    name: 'Just4Anime',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        const target = anilistEpisode(data);
        if (!target) return result;
        const servers: any[] = (await net.get(`${API}/meta/availability/${target.id}/servers`, { headers, timeout: 12000 })).data?.data?.servers || [];
        const subs = new Set<string>();
        await Promise.all(servers.filter((s) => s?.hasEpisode && s?.code).flatMap((sv) => (sv.types || []).map(async (type: string) => {
            try {
                const d = (await net.get(`${API}/meta/sources/${target.id}`, {
                    params: { provider: sv.code, num: target.ep, type: type.replace('h-sub', 'hsub') }, headers, timeout: 15000,
                })).data?.data;
                const audio = type === 'dub' ? 'English (Dub)' : type === 'sub' ? 'Japanese (Sub)' : 'Japanese (HardSub)';
                for (const s of d?.sources || []) {
                    if (!s?.url) continue;
                    const q = getIndexQuality(String(s.quality || ''));
                    result.streams.push({
                        server: `Just4Anime · ${sv.displayName || sv.code} · ${audio}`, link: s.url,
                        type: s.isM3U8 || /\.m3u8/.test(s.url) ? 'm3u8' : 'mp4',
                        ...(q ? { quality: `${q}p` } : {}),
                        // their proxy already carries the CDN referer; pass any upstream-declared headers through.
                        headers: { ...headers, ...(s.proxied ? {} : s.headers || {}) },
                    });
                }
                for (const t of d?.subtitles || []) {
                    const lang = t?.language || t?.lang || 'English';
                    if (!t?.url || subs.has(lang) || /thumbnail/i.test(t.url)) continue;
                    subs.add(lang);
                    result.subtitles.push({ language: lang, url: t.url });
                }
            } catch { /* this server/type failed */ }
        })));
        return result;
    },
};
