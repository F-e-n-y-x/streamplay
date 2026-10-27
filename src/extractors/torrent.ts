import net from '../utils/net';
import { Provider, LinkData, ExtractorResult, Stream } from '../types';
import { pad2 } from '../utils/season';
import { animeSearchTitles } from '../anime';
import { searchNyaa, searchTorznab } from '../utils/torrentSearch';

/**
 * Torrent anime provider (AnimeTosho / Nyaa).
 *
 * The most DURABLE anime source: torrents never rot, cover sub AND dub in 1080p, and
 * index by ABSOLUTE episode number — so they sidestep the aired-vs-production season
 * mess entirely. We query AnimeTosho's JSON feed for the episode, rank the releases,
 * and return magnet links. The magnet is streamed by /api/torrent (see routes/torrent
 * + utils/torrent). Runs only in "torrent mode" (see the SSE `torrent=1` gate).
 */

const FEED = 'https://feed.animetosho.org/json';

// Fansub/encode groups that are reliably well-seeded and browser-friendly (h264).
const GOOD_GROUPS = /\b(subsplease|erai-raws|horriblesubs|ember|judas|asw|cerberus|nandesu|commie|dkb|nep_blanc|yameii)\b/i;
const DUB_RE = /\b(dual[\s._-]?audio|dual|dub|multi[\s._-]?audio|eng[\s._-]?dub)\b/i;

interface Release { title: string; magnet: string; size: number; files: number; seeders?: number }

const magnetFrom = (r: any): string => {
    if (typeof r.magnet_uri === 'string' && r.magnet_uri) return r.magnet_uri;
    const hash = r.info_hash || r.infohash;
    if (!hash) return '';
    const trackers = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.stealth.si:80/announce', 'udp://tracker.torrent.eu.org:451/announce']
        .map((t) => `&tr=${encodeURIComponent(t)}`).join('');
    return `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(r.torrent_name || r.title || '')}${trackers}`;
};

async function searchTosho(q: string): Promise<Release[]> {
    try {
        const { data } = await net.get(FEED, { params: { q, only_tor: 1 }, timeout: 15000 });
        const arr: any[] = Array.isArray(data) ? data : [];
        return arr.map((r) => ({ title: String(r.title || r.torrent_name || ''), magnet: magnetFrom(r), size: Number(r.total_size) || 0, files: Number(r.num_files) || 1, seeders: Number(r.seeders ?? r.num_seeders) || 0 }))
            .filter((r) => r.magnet && r.title);
    } catch { return []; }
}

/** Score a release for a specific episode: prefer 1080p, good groups, THIS episode, single-file. */
function scoreRelease(r: Release, episode: number, wantDub: boolean): number {
    const t = r.title;
    let s = 0;
    if (/\b1080p?\b/i.test(t)) s += 4; else if (/\b720p?\b/i.test(t)) s += 2; else if (/\b2160p|4k\b/i.test(t)) s += 1;
    if (GOOD_GROUPS.test(t)) s += 3;
    if (/\b(h[\s._-]?264|x264|avc)\b/i.test(t)) s += 2;   // browser-friendly codec (cheap remux)
    if (/\b(h[\s._-]?265|x265|hevc)\b/i.test(t)) s -= 1;  // needs transcode
    const ep = new RegExp(`(?:^|[\\s\\-._([])(?:e|ep|episode\\s*)?0*${episode}(?:[\\s\\-._)\\]v]|$)`, 'i');
    const isBatch = r.files > 3 || /\b\d{1,3}\s*[\-~]\s*\d{1,3}\b/.test(t) || /\b(batch|complete|season)\b/i.test(t);
    if (ep.test(t) && !isBatch) s += 6;         // exact single-episode match
    else if (isBatch) s += 2;                   // a batch has the episode too (we pick the file index)
    if (wantDub) { if (DUB_RE.test(t)) s += 5; else s -= 3; }
    else if (DUB_RE.test(t)) s -= 1;            // sub run: mildly deprioritise dual-audio
    s += Math.min(3, Math.log10((r.seeders || 0) + 1) * 1.5);   // well-seeded = actually streamable
    return s;
}

async function releasesFor(titles: string[], episode: number, wantDub: boolean): Promise<Release[]> {
    const seen = new Set<string>();
    const out: Release[] = [];
    for (const base of titles.slice(0, 3)) {
        // Multiple query shapes: padded + non-padded episode, and a bare-title query that
        // catches batches / season packs (the stream then file-picks the episode by &ep).
        const queries = wantDub
            ? [`${base} ${pad2(episode)} dual audio`, `${base} dual audio`, `${base} ${pad2(episode)}`, `${base} ${episode}`, `${base}`]
            : [`${base} ${pad2(episode)}`, `${base} - ${pad2(episode)}`, `${base} ${episode}`, `${base}`];
        for (const q of queries) {
            // Query AnimeTosho, Nyaa AND Torznab (Jackett/Prowlarr anime cat, if set) and merge.
            const [tosho, nyaa, torznab] = await Promise.all([searchTosho(q), searchNyaa(q), searchTorznab(q, '5070')]);
            for (const r of [...tosho, ...nyaa, ...torznab]) {
                const k = (r.magnet.match(/btih:([a-z0-9]+)/i)?.[1] || r.magnet).slice(0, 40).toLowerCase();
                if (!seen.has(k)) { seen.add(k); out.push(r); }
            }
            if (out.filter((r) => scoreRelease(r, episode, wantDub) >= 8).length >= 3) break;
        }
        if (out.length) break;   // got results for this title variant — good enough
    }
    return out.map((r) => ({ r, s: scoreRelease(r, episode, wantDub) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.r);
}

const shortName = (title: string): string => {
    const group = (title.match(/^\[([^\]]+)\]/) || [])[1] || (title.match(/\(([^)]*(?:sub|dub)[^)]*)\)/i) || [])[1] || 'Torrent';
    const q = (title.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1] || '';
    return `${group}${q ? ' ' + q : ''}`.trim();
};

export const TorrentAnimeProvider: Provider = {
    id: 'torrent',
    name: 'Torrent',
    // NOTE: this only searches AnimeTosho here; the actual peer/seed traffic happens
    // in /api/torrent (WebTorrent) and uses the container's DIRECT egress — WebTorrent
    // can't route UDP/DHT through the WARP SOCKS proxy. To hide the home IP from peers,
    // run the streamplay container behind WARP at the network level.
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        // AnimeTosho is anime-only; skip live-action to avoid empty queries.
        if (!(data.isAnime || data.isCartoon) || !data.title) return { streams, subtitles: [] };
        // When we know the AniList cour titles (e.g. "Solo Leveling Season 2 -Arise from
        // the Shadow-"), that cour is numbered 1..N on Nyaa — so search those titles with
        // the per-cour episode. Otherwise fall back to the base titles + ABSOLUTE episode
        // (S2E1 = #13), which is how batch/continuous releases number things.
        const courTitles = data.animeSeasonTitles?.filter(Boolean) || [];
        const useCour = courTitles.length > 0;
        const episode = data.type === 'movie' ? 1 : (useCour ? (data.episode ?? 1) : (data.absoluteEpisode ?? data.episode ?? 1));
        const titles = useCour ? courTitles : animeSearchTitles(data);

        for (const wantDub of [false, true]) {
            const rels = (await releasesFor(titles, episode, wantDub)).slice(0, 3);
            for (const r of rels) {
                streams.push({
                    server: `Torrent · ${wantDub ? 'Dub' : 'Sub'} · ${shortName(r.title)}`,
                    link: r.magnet,          // proxify() turns a magnet into an /api/torrent stream URL
                    type: 'mp4',
                    quality: (r.title.match(/\b(2160p|1080p|720p|480p)\b/i) || [])[1],
                    audioName: wantDub ? 'English' : 'Japanese',
                });
            }
        }
        return { streams, subtitles: [] };
    },
};
