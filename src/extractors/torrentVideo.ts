import { Provider, LinkData, ExtractorResult, Stream } from '../types';
import { TORRENTSDB, searchYTS, searchApibay, searchEztv, searchTorrentio, searchTorznab, scoreVideo, shortLabel, qualityOf, sxe, titleVariants, titleSimilarity, TRelease } from '../utils/torrentSearch';

/**
 * Torrent-mode providers for MOVIES and TV (anime stays on AnimeTosho/Nyaa — see torrent.ts).
 * Magnets are streamed through /api/torrent (WebTorrent + on-the-fly mkv→mp4 remux).
 * Runs only in torrent mode (the SSE `torrent=1` gate).
 */

const normT = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Does a release belong to the wanted title? Accepts a MATCH against ANY title variant
 * (original title, subtitle-stripped, &↔and, …): a variant's normalized form appears
 * contiguously in the release name, OR the token similarity is high (tolerates typos /
 * reordered words). Contiguous is preferred; similarity is the fuzzy fallback.
 */
const titleMatches = (relTitle: string, wants: string[]): boolean => {
    const r = normT(relTitle);
    for (const w of wants) {
        const wn = normT(w.split(/[:(]/)[0]);
        if (wn.length >= 3 && r.includes(wn)) return true;                 // contiguous (precise)
        if (w.split(/\s+/).length >= 3 && titleSimilarity(w, relTitle) >= 0.85) return true;  // fuzzy (long titles only)
    }
    return false;
};

const toStreams = (rels: TRelease[], wants: string[], year?: number, epTag?: RegExp): Stream[] => {
    // Title-matched releases only: an unrelated torrent is worse than no result.
    const scored = rels.filter((r) => titleMatches(r.title, wants))
        .map((r) => ({ r, s: scoreVideo(r, year) + (epTag && epTag.test(r.title) ? 4 : 0) }))
        // cached (debrid) releases don't need live seeders — they stream from the debrid CDN
        .filter((x) => (x.r.cached || x.r.seeders > 0) && x.s > 0)
        .sort((a, b) => b.s - a.s)
        // de-dupe by direct url (cached) or infohash (P2P) so the same release isn't listed twice
        .filter((x, _i, arr) => arr.findIndex((y) => (y.r.url || y.r.magnet).slice(0, 60) === (x.r.url || x.r.magnet).slice(0, 60)) === _i)
        .slice(0, 6);
    return scored.map(({ r }) => r.cached && r.url ? {
        server: `Torrent · ${shortLabel(r.title)} · Cached ⚡`,
        link: r.url,                    // proxify() → /api/torrent/http (range / remux)
        type: 'mp4' as const,
        quality: qualityOf(r.title),
        debrid: true,
    } : {
        server: `Torrent · ${shortLabel(r.title)} · ${r.seeders}⬆`,
        link: r.magnet,                 // proxify() → /api/torrent stream URL
        type: 'mp4' as const,
        quality: qualityOf(r.title),
    });
};

export const TorrentMovieProvider: Provider = {
    id: 'torrent-movie',
    name: 'Torrent (Movies)',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        if (data.type !== 'movie' || !data.title) return { streams: [], subtitles: [] };
        const wants = titleVariants(data.title, data.orgTitle);
        // Query YTS + Torrentio (aggregator) by IMDb id, apibay + Torznab (Jackett/Prowlarr
        // meta-indexer, if configured) by title. Merge everything, then rank/dedupe.
        const [yts, torrentio, tdb, torznab, ...bays] = await Promise.all([
            searchYTS(data.imdbId, data.title),
            searchTorrentio('movie', data.imdbId),
            searchTorrentio('movie', data.imdbId, undefined, undefined, TORRENTSDB),
            searchTorznab(`${data.title} ${data.year || ''}`.trim(), '2000'),
            ...wants.slice(0, 2).map((w) => searchApibay(`${w} ${data.year || ''}`.trim(), '201,207')),
        ]);
        const rels = [...yts, ...torrentio, ...tdb, ...torznab, ...bays.flat()];
        return { streams: toStreams(rels, wants, data.year), subtitles: [] };
    },
};

export const TorrentTvProvider: Provider = {
    id: 'torrent-tv',
    name: 'Torrent (TV)',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        if (data.type !== 'tv' || !data.title) return { streams: [], subtitles: [] };
        const s = data.season ?? 1;
        const e = data.episode ?? 1;
        const tag = sxe(s, e);
        const epRe = new RegExp(tag, 'i');
        const wants = titleVariants(data.title, data.orgTitle);
        const [eztv, torrentio, tdb, torznab, epq, packq] = await Promise.all([
            searchEztv(data.imdbId),
            searchTorrentio('series', data.imdbId, s, e),
            searchTorrentio('series', data.imdbId, s, e, TORRENTSDB),
            searchTorznab(`${data.title} ${tag}`, '5000'),          // Jackett/Prowlarr, this episode
            // exact-episode query on the top two title variants
            Promise.all(wants.slice(0, 2).map((w) => searchApibay(`${w} ${tag}`, '205,208'))).then((a) => a.flat()),
            searchApibay(`${data.title} Season ${s}`, '205,208'),   // season packs (episode picked by &ep on stream)
        ]);
        // EZTV: keep this exact episode (or untagged, which the stream will file-pick by &ep).
        const eztvHit = eztv.filter((r) => (r.season === s && r.episode === e) || epRe.test(r.title));
        const packHit = packq.filter((r) => new RegExp(`(season\\s*0*${s}|s0*${s})\\b`, 'i').test(r.title) && !/S\d{1,2}E\d{1,2}/i.test(r.title));
        return { streams: toStreams([...eztvHit, ...epq, ...packHit, ...torznab, ...torrentio, ...tdb], wants, data.year, epRe), subtitles: [] };
    },
};
