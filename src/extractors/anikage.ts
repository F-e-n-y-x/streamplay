import net from '../utils/net';
import { Provider, LinkData, ExtractorResult } from '../types';
import { anilistEpisode, animeSearchTitles } from '../anime';
import { USER_AGENT } from '../utils/encdec';

const BASE = 'https://anikage.cc';
const CDN = 'https://og.bakayaro.live';   // plays Anikage's opaque source/subtitle tokens
const headers = { 'User-Agent': USER_AGENT, Referer: `${BASE}/` };

/**
 * Anikage — plain JSON API keyed by AniList id (port of CSX `invokeAnikage`):
 * browse?q= → entry whose anilistId matches → episodes/{n}/servers → per server ×
 * sub|dub sources. Each source/subtitle is an opaque token served by og.bakayaro.live.
 * `embeds` (iframe players) are skipped — direct HLS only.
 */
export const AnikageProvider: Provider = {
    id: 'anikage',
    name: 'Anikage',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        const target = anilistEpisode(data);
        if (!target) return result;
        let slug: string | undefined;
        for (const q of animeSearchTitles(data).slice(0, 3)) {
            const r = (await net.get(`${BASE}/api/media/anime/browse`, { params: { q, sort: 'popularity', page: 1, limit: 25, adult: true }, headers, timeout: 12000 })).data;
            slug = (r?.data || []).find((x: any) => x?.anilistId === target.id)?.slug;
            if (slug) break;
        }
        if (!slug) return result;
        const ep = `${BASE}/api/media/anime/${slug}/episodes/${target.ep}`;
        const servers: any[] = (await net.get(`${ep}/servers`, { headers, timeout: 12000 })).data?.servers || [];
        const subs = new Set<string>();
        const jobs = servers.flatMap((sv) => (sv?.subTypes || ['sub', 'dub']).filter((l: string) => l === 'sub' || l === 'dub').map((lang: string) => ({ sv, lang })));
        // The API 429s past ~4 parallel requests: 3 workers, one retry after a short pause.
        const fetchSources = async (sv: any, lang: string) => {
            for (let i = 0; ; i++) {
                const r = await net.get(`${ep}/sources`, { params: { provider: sv.id, lang }, headers, timeout: 15000, validateStatus: () => true });
                if (r.status !== 429 || i) return r.data;
                await new Promise((ok) => setTimeout(ok, 1500));
            }
        };
        const worker = async () => { for (let job = jobs.shift(); job; job = jobs.shift()) {
            const { sv, lang } = job;
            try {
                const r = await fetchSources(sv, lang);
                for (const s of r?.sources || []) {
                    if (!s?.url) continue;
                    result.streams.push({
                        server: `Anikage · ${sv.id} · ${lang === 'dub' ? 'English (Dub)' : 'Japanese (Sub)'}`,
                        link: `${CDN}/${s.isM3U8 ? 'm3u8' : 'stream'}/${s.url}`, type: s.isM3U8 ? 'm3u8' : 'mp4',
                        quality: '1080p', headers,
                    });
                }
                for (const t of r?.subtitles || []) {
                    if (!t?.file || subs.has(t.label || t.file)) continue;
                    subs.add(t.label || t.file);
                    result.subtitles.push({ language: t.label || 'Unknown', url: `${CDN}/stream/${t.file}`, headers });
                }
            } catch { /* this server/lang failed */ }
        } };
        await Promise.all([worker(), worker(), worker()]);
        return result;
    },
};
