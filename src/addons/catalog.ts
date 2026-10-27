/**
 * Curated, built-in addon catalog served by GET /api/addons/catalog (one-click add in the UI).
 * Only entries whose manifest answered HTTP 200 + valid JSON on `lastChecked`. A .ts (not
 * .json) so `tsc` ships it in dist/ without resolveJsonModule.
 *
 * `obfuscated` = javascript-obfuscator'd scraper code that cannot be reviewed (count in
 * `obfuscatedCount`). Nuvio scrapers run in the server's worker+vm runtime, which is NOT a
 * security boundary — only add repos you trust as much as the server itself.
 * `needsConfig` = the bare manifest returns nothing useful; the user must configure the addon
 * on its `configureUrl` (often with an account/debrid key) and paste their personal manifest URL.
 */
export interface CatalogEntry {
    name: string;
    manifestUrl: string;
    kind: 'nuvio' | 'stremio';
    description: string;
    tags: string[];
    needsDebrid: boolean;
    needsConfig?: boolean;
    configureUrl?: string;
    obfuscated: boolean;
    obfuscatedCount?: number;
    scraperCount?: number;
    /** last commit / release of the source, ISO date */
    lastUpdated?: string;
    lastChecked: string;
}

const GH = (repo: string, branch = 'main') => `https://raw.githubusercontent.com/${repo}/refs/heads/${branch}/manifest.json`;
const CHECKED = '2026-10-27';

export const CATALOG: CatalogEntry[] = [
    // ── Nuvio plugin repos ──
    { name: 'All-in-One-Nuvio', manifestUrl: GH('NuvioPlugin/All-in-One-Nuvio'), kind: 'nuvio', description: 'Largest community bundle (D3adlyRocket): VidLink, Videasy, Vixsrc, 4KHDHub, HDHub4u, MovieBox, NetMirror, HiAnime, AnimeKai, KissKH… 51 of 66 scrapers are obfuscated.', tags: ['movies', 'tv', 'anime', 'indian', 'asian', 'multi-language'], needsDebrid: false, obfuscated: true, obfuscatedCount: 51, scraperCount: 66, lastUpdated: '2026-10-02', lastChecked: CHECKED },
    { name: "Yoru's Repo", manifestUrl: GH('yoruix/nuvio-providers'), kind: 'nuvio', description: 'Successor of tapframe/nuvio-providers: 4KHDHub, MovieBox, DVDPlay, YFlix, VidLink, Cinevibe, ShowBox, DooFlix, NetMirror… Readable source.', tags: ['movies', 'tv', 'anime', 'indian'], needsDebrid: false, obfuscated: false, scraperCount: 28, lastUpdated: '2026-06-07', lastChecked: CHECKED },
    { name: 'Michat88 Repo', manifestUrl: GH('michat88/nuvio-providers'), kind: 'nuvio', description: 'KissKH, HDRezka, Idlix, MoviesMod, Vidrock, Watch32, XPrime, YFlix… Readable source; not updated since Dec 2025.', tags: ['movies', 'tv', 'asian', 'indonesian'], needsDebrid: false, obfuscated: false, scraperCount: 30, lastUpdated: '2025-12-30', lastChecked: CHECKED },
    { name: 'Hindi-Nuvio', manifestUrl: GH('D3adlyRocket/Hindi-Nuvio'), kind: 'nuvio', description: 'Indian sources (4KHDHub, AllMovieLand, CinemaCity…) by D3adlyRocket. Readable source.', tags: ['movies', 'tv', 'indian', 'hindi'], needsDebrid: false, obfuscated: false, scraperCount: 14, lastUpdated: '2026-05-27', lastChecked: CHECKED },
    { name: 'All-in-One-Anime', manifestUrl: GH('D3adlyRocket/Anime-Nuvio'), kind: 'nuvio', description: 'Anime bundle (AllWish, Anime-Sama, AnimeKai…) by D3adlyRocket. 2 of 9 scrapers obfuscated.', tags: ['anime'], needsDebrid: false, obfuscated: true, obfuscatedCount: 2, scraperCount: 9, lastUpdated: '2026-05-27', lastChecked: CHECKED },
    { name: 'Nuvio-TV', manifestUrl: GH('D3adlyRocket/Nuvio-TV'), kind: 'nuvio', description: 'Small TV-tuned bundle (4KHDHub, AnimeKai…) by D3adlyRocket. Readable source.', tags: ['movies', 'tv', 'anime'], needsDebrid: false, obfuscated: false, scraperCount: 7, lastUpdated: '2026-05-22', lastChecked: CHECKED },
    { name: 'Eclipsia', manifestUrl: GH('ItsMe-95fx/eclipsia-nuvio'), kind: 'nuvio', description: 'Multi-language movie/TV scrapers. Readable source; works best with a TMDB_API_KEY set on the server.', tags: ['movies', 'tv', 'multi-language'], needsDebrid: false, obfuscated: false, scraperCount: 10, lastUpdated: '2026-07-04', lastChecked: CHECKED },
    { name: 'NiakVIO', manifestUrl: GH('niakw/NiakVIO'), kind: 'nuvio', description: 'French-first (anime-sama, voiranime, coflix, purstream…) plus Indian sources. Minified bundles (readable after formatting, not obfuscated). Very active.', tags: ['french', 'anime', 'movies', 'tv'], needsDebrid: false, obfuscated: false, scraperCount: 41, lastUpdated: '2026-10-26', lastChecked: CHECKED },
    { name: "Gowaru's Repo", manifestUrl: GH('Gowaru/gowaru-nuvio-providers'), kind: 'nuvio', description: 'French anime/movie sites (anime-sama, voiranime, franime, frenchstream, wookafr…). Minified bundles, not obfuscated.', tags: ['french', 'anime', 'movies', 'tv'], needsDebrid: false, obfuscated: false, scraperCount: 37, lastUpdated: '2026-10-14', lastChecked: CHECKED },
    { name: 'Latino Providers', manifestUrl: GH('KennethJYS/Nuvio-Providers-Latino'), kind: 'nuvio', description: 'Spanish / LatAm (Cinecalidad, Embed69, SeriesMetro, LaMovie…). Readable source.', tags: ['spanish', 'movies', 'tv'], needsDebrid: false, obfuscated: false, scraperCount: 10, lastUpdated: '2026-10-08', lastChecked: CHECKED },
    { name: 'German Providers', manifestUrl: GH('InvalidPandaa/nuvio-german-providers'), kind: 'nuvio', description: 'German (ARD, Arte, Netzkino, Pluto TV, AniWorld, SerienStream, Megakino…). Readable source.', tags: ['german', 'movies', 'tv', 'anime'], needsDebrid: false, obfuscated: false, scraperCount: 20, lastUpdated: '2026-10-04', lastChecked: CHECKED },
    { name: 'Anthology', manifestUrl: GH('falsisdev/anthology'), kind: 'nuvio', description: 'Turkish films, series, anime and live TV. Readable source.', tags: ['turkish', 'movies', 'tv', 'anime'], needsDebrid: false, obfuscated: false, scraperCount: 42, lastUpdated: '2026-10-26', lastChecked: CHECKED },
    { name: 'MoOnCrOwN TR', manifestUrl: GH('mooncrown04/nuviotr'), kind: 'nuvio', description: 'Turkish (DiziYou, SinemaCX, FullHDFilmizlesene, JetFilmizle…). Readable source.', tags: ['turkish', 'movies', 'tv'], needsDebrid: false, obfuscated: false, scraperCount: 17, lastUpdated: '2026-10-17', lastChecked: CHECKED },

    // ── Stremio addons ──
    { name: 'Torrentio', manifestUrl: 'https://torrentio.strem.fun/manifest.json', kind: 'stremio', description: 'The classic torrent indexer. Without debrid it returns magnets (torrent mode); configure a debrid key for direct HTTP links.', tags: ['torrents', 'movies', 'tv', 'anime'], needsDebrid: false, configureUrl: 'https://torrentio.strem.fun/configure', obfuscated: false, lastChecked: CHECKED },
    { name: 'TorrentsDB', manifestUrl: 'https://torrentsdb.com/manifest.json', kind: 'stremio', description: 'Torrentio-compatible torrent index (magnets; debrid optional).', tags: ['torrents', 'movies', 'tv', 'anime'], needsDebrid: false, configureUrl: 'https://torrentsdb.com/configure', obfuscated: false, lastChecked: CHECKED },
    { name: 'Peerflix', manifestUrl: 'https://addon.peerflix.mov/manifest.json', kind: 'stremio', description: 'Torrent addon with strong Spanish/multi-audio coverage (magnets; debrid optional).', tags: ['torrents', 'spanish', 'movies', 'tv'], needsDebrid: false, configureUrl: 'https://addon.peerflix.mov/configure', obfuscated: false, lastChecked: CHECKED },
    { name: 'PenguPlay', manifestUrl: 'https://pengu.uk/manifest.json', kind: 'stremio', description: 'Direct HTTP streams (VidFast, MovieBox, 4KHDHub, VegaMovies, KissKH, Anikoto…) up to 4K, plus subtitles. Needs a free sign-in: configure on pengu.uk and paste YOUR personal manifest URL (it contains your token — keep it private).', tags: ['http', 'movies', 'tv', 'anime', 'subtitles'], needsDebrid: false, needsConfig: true, configureUrl: 'https://pengu.uk/configure', obfuscated: false, lastChecked: CHECKED },
    { name: 'MediaFusion (ElfHosted)', manifestUrl: 'https://mediafusion.elfhosted.com/manifest.json', kind: 'stremio', description: 'Torrent + debrid aggregator with live sports/TV. Returns nothing until configured.', tags: ['torrents', 'debrid', 'movies', 'tv', 'live'], needsDebrid: false, needsConfig: true, configureUrl: 'https://mediafusion.elfhosted.com/configure', obfuscated: false, lastChecked: CHECKED },
    { name: 'Comet (ElfHosted)', manifestUrl: 'https://comet.elfhosted.com/manifest.json', kind: 'stremio', description: 'Fast debrid-first torrent addon. Needs a debrid service configured.', tags: ['torrents', 'debrid', 'movies', 'tv', 'anime'], needsDebrid: true, needsConfig: true, configureUrl: 'https://comet.elfhosted.com/configure', obfuscated: false, lastChecked: CHECKED },
    { name: 'OpenSubtitles v3', manifestUrl: 'https://opensubtitles-v3.strem.io/manifest.json', kind: 'stremio', description: 'Official Stremio subtitles addon (subtitles only, IMDb ids).', tags: ['subtitles'], needsDebrid: false, obfuscated: false, lastChecked: CHECKED },
];
