import axios from 'axios';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';

/**
 * Consumet aggregator — a single provider that fans out across many anime
 * back-ends (Zoro/HiAnime, AnimePahe, Gogoanime, AnimeKai …) with automatic
 * fallback, returning HLS sources + subtitles for both SUB and DUB.
 *
 * Requires a self-hosted Consumet API (set CONSUMET_URL, e.g. the docker-compose
 * `consumet` service → http://consumet:3000). Inert when unset. Uses the AniList
 * id from `animeIds` so it doesn't need its own title→id mapping.
 *
 * Because individual back-ends go up and down, this walks a preference list and
 * stops at the first one that yields playable sources — so one dead provider
 * doesn't take anime playback down with it.
 */

const BASE = () => (process.env.CONSUMET_URL || '').replace(/\/+$/, '');
// Fallback order — most-complete first. Configurable via CONSUMET_PROVIDERS (csv).
const PROVIDERS = () => (process.env.CONSUMET_PROVIDERS || 'zoro,animepahe,animekai,gogoanime').split(',').map((s) => s.trim()).filter(Boolean);

async function tryProvider(base: string, provider: string, anilistId: number, episode: number, dub: boolean): Promise<ExtractorResult | null> {
    try {
        const info = await axios.get(`${base}/meta/anilist/info/${anilistId}`, { params: { provider, ...(dub ? { dub: 'true' } : {}) }, timeout: 15000 });
        const eps: any[] = info.data?.episodes || [];
        if (!eps.length) return null;
        const ep = eps.find((e) => Number(e.number) === episode) || (eps.length === 1 ? eps[0] : undefined);
        if (!ep?.id) return null;

        const watch = await axios.get(`${base}/meta/anilist/watch/${encodeURIComponent(ep.id)}`, { params: { provider }, timeout: 20000 });
        const srcs: any[] = watch.data?.sources || [];
        const headers = watch.data?.headers || {};
        const streams: Stream[] = srcs
            .filter((s) => s.url)
            .map((s) => ({
                server: `Consumet ${provider}${dub ? ' · DUB' : ''}${s.quality && s.quality !== 'default' ? ` ${s.quality}` : ''}`,
                link: s.url,
                type: (s.isM3U8 || /\.m3u8(\?|$)/i.test(s.url)) ? 'm3u8' : 'mp4',
                quality: typeof s.quality === 'string' ? s.quality : undefined,
                headers,
            }) as Stream);
        if (!streams.length) return null;

        const subtitles: Subtitle[] = (watch.data?.subtitles || [])
            .filter((s: any) => s.url && !/thumbnail/i.test(s.lang || ''))
            .map((s: any) => ({ language: s.lang || 'Sub', url: s.url }));
        return { streams, subtitles };
    } catch { return null; }
}

export const ConsumetProvider: Provider = {
    id: 'consumet',
    name: 'Consumet',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const base = BASE();
        if (!base || !data.isAnime) return { streams: [], subtitles: [] };
        const anilistId = data.animeIds?.anilistId;
        if (!anilistId) return { streams: [], subtitles: [] };
        const episode = data.type === 'movie' ? 1 : (data.episode ?? 1);

        // Walk providers in preference order; try sub then dub per provider; stop on first hit.
        for (const provider of PROVIDERS()) {
            for (const dub of [false, true]) {
                const r = await tryProvider(base, provider, anilistId, episode, dub);
                if (r && r.streams.length) return r;
            }
        }
        return { streams: [], subtitles: [] };
    },
};
