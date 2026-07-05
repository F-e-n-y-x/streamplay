import { Provider, ContentKind } from '../types';

// --- Video providers ---
import { KissKhProvider } from './kisskh';
import { TwoEmbedProvider } from './twoembed';
import { VidFastProvider } from './vidfast';
import { VidrockProvider } from './vidrock';
import { HexaProvider } from './hexa';
import { RiveStreamProvider } from './rivestream';
import { AllMovielandProvider } from './allmovieland';
import { XpassProvider } from './xpass';
import { VaplayerProvider } from './vaplayer';
import { DahmerMoviesProvider } from './dahmermovies';
import { VegaMoviesProvider } from './vegamovies';
import { HdHub4uProvider } from './hdhub4u';
import { FourKHdHubProvider } from './fourkhdhub';
import { Movies4uProvider } from './movies4u';
import { RogMoviesProvider } from './rogmovies';
import { MultiMoviesProvider } from './multimovies';
import { UhdMoviesProvider } from './uhdmovies';
import { MoviesModProvider } from './moviesmod';
import { TopMoviesProvider } from './topmovies';
import { BollyflixProvider } from './bollyflix';
import { CineMacityProvider } from './cinemacity';

// --- Anime providers (title-matched; via the persistent FlareSolverr session) ---
//     AniZone works (single HLS with JP/KR/EN audio + many subtitle tracks).
//     AnimePahe is active but BEST-EFFORT: it resolves real SUB/DUB, but its Kwik
//     CDN IP-bans many datacenter egresses — where that happens it returns nothing
//     (and can burn up to PROVIDER_TIMEOUT_MS before doing so). Move it to
//     disabledProviders below if your network is Kwik-banned.
import { AllAnimeProvider } from './allanime';    // ani-cli backend: reliable native SUB + DUB, no FlareSolverr/key
import { AniZoneProvider } from './anizone';
import { AnimeWorldProvider } from './animeworld';
import { ConsumetProvider } from './consumet';   // multi-backend aggregator (opt-in via CONSUMET_URL)
import { AnimePaheProvider } from './animepahe';

// --- CastleTV: Indian multi-language (Hindi/Tamil/…) movies + series via api.hlowb.com ---
import { CastleProvider } from './castle';

// --- Subtitle providers ---
import { SubtitleApiProvider } from './subtitleapi';
import { WyzieSubsProvider } from './wyziesubs';

// --- Torrent — served ONLY in torrent mode, not the normal fan-out ---
import { TorrentAnimeProvider } from './torrent';               // anime via AnimeTosho/Nyaa
import { TorrentMovieProvider, TorrentTvProvider } from './torrentVideo';  // movies (YTS/TPB) + TV (EZTV/TPB)

// --- Disabled: faithful ports whose upstreams are currently dead/changed/gated.
//     Kept in the tree so they can be re-enabled when the upstream recovers
//     (e.g. a rotated key/domain is updated). See each file for the evidence. ---
import { VidlinkProvider } from './vidlink';       // upstream /api/b returns empty body
import { VidEasyProvider } from './videasy';       // api.videasy.net endpoints 404
import { VidzeeProvider } from './vidzee';         // rotated AES key (stale secret)
import { MovieBoxProvider } from './moviebox';     // /play-info 406, datacenter-IP gated
import { MappleProvider } from './mapple';         // /api/stream-token routes removed (Turnstile)
import { VidSrcXyzProvider } from './vidsrcxyz';   // prorcp now Cloudflare-Turnstile gated
import { PeachifyProvider } from './peachify';     // rotated AES-GCM key
import { NineTvProvider } from './ninetv';         // moviesapi.club DNS no longer resolves
import { MoviesDriveProvider } from './moviesdrive'; // upstream files removed (recovery pages)
import { Hdmovie2Provider } from './hdmovie2';     // hdmo2.com domain degraded (404s)

/**
 * Providers served by /api/streams (run concurrently per request).
 * Cloudflare-gated providers (UHDMovies, MoviesMod, TopMovies, MultiMovies,
 * CineMacity, ...) rely on FLARESOLVERR_URL being set in `.env`.
 */
export const providers: Provider[] = [
    // === Anime first ===
    // Dedicated anime providers run (and rank) ahead of the generic movie/TV
    // sources for anime titles. Each early-returns for non-anime content, so this
    // ordering costs movies nothing while putting the good sub/dub sources at the
    // top of the list for anime.
    AllAnimeProvider,     // ani-cli backend — reliable native SUB + DUB (no FlareSolverr/key)
    AniZoneProvider,      // HLS + multi-audio (JP/KR/EN) + subtitles
    AnimeWorldProvider,   // Indian dubs (Hindi/Tamil/Telugu) + Eng/Jap via zephyrflick
    AnimePaheProvider,    // JP/EN native HLS via animepahe.pw + Kwik
    ConsumetProvider,     // aggregator: Zoro/AnimePahe/Gogo/AnimeKai fallback (needs CONSUMET_URL)

    // direct-API (fast, reliable)
    TwoEmbedProvider,
    VidFastProvider,
    VidrockProvider,
    HexaProvider,
    RiveStreamProvider,
    AllMovielandProvider,
    XpassProvider,
    VaplayerProvider,
    DahmerMoviesProvider,
    // asian drama
    KissKhProvider,
    // Indian multi-language movies + series (Hindi/Tamil/Telugu dubs, direct HLS)
    CastleProvider,
    // scrape / multi (need FlareSolverr for the Cloudflare ones)
    VegaMoviesProvider,
    HdHub4uProvider,
    FourKHdHubProvider,
    Movies4uProvider,
    RogMoviesProvider,
    MultiMoviesProvider,
    UhdMoviesProvider,
    MoviesModProvider,
    TopMoviesProvider,
    BollyflixProvider,
    CineMacityProvider,
    // subtitles
    SubtitleApiProvider,
    WyzieSubsProvider,
];

/** Ported but disabled (dead/changed upstream). Not served; here for reference + easy revival. */
export const disabledProviders: Provider[] = [
    VidlinkProvider,
    VidEasyProvider,
    VidzeeProvider,
    MovieBoxProvider,
    MappleProvider,
    VidSrcXyzProvider,
    PeachifyProvider,
    NineTvProvider,
    MoviesDriveProvider,
    Hdmovie2Provider,
];

/**
 * Content-kind gating. A provider absent from this map serves ALL kinds (the generic
 * TMDB/IMDB-id providers like the direct-API ones, DahmerMovies, and the subtitle
 * providers — DahmerMovies proves generic providers can carry anime too). Listing a
 * provider here restricts it: e.g. the dedicated anime scrapers only run for anime,
 * and the Indian movie/series scrapers are skipped for anime so an anime title no
 * longer triggers ~12 pointless FlareSolverr solves.
 */
const PROVIDER_KINDS: Record<string, ContentKind[]> = {
    // dedicated anime. (AnimeWorld is intentionally NOT listed → it serves ALL kinds:
    // it carries anime, Western cartoons like Ben 10, plus series & movies.)
    allanime: ['anime'], anizone: ['anime'], animepahe: ['anime'], consumet: ['anime'],
    // Asian drama
    kisskh: ['asian'],
    // Indian / scraper multi (movies + series + Asian, NOT anime — AnimeWorld covers dubbed anime)
    castle: ['movie', 'series', 'asian'],
    vegamovies: ['movie', 'series', 'asian'], hdhub4u: ['movie', 'series', 'asian'], fourkhdhub: ['movie', 'series', 'asian'],
    movies4u: ['movie', 'series', 'asian'], rogmovies: ['movie', 'series', 'asian'], multimovies: ['movie', 'series', 'asian'],
    uhdmovies: ['movie', 'series', 'asian'], moviesmod: ['movie', 'series', 'asian'], topmovies: ['movie', 'series', 'asian'],
    bollyflix: ['movie', 'series', 'asian'], cinemacity: ['movie', 'series', 'asian'],
};
for (const p of providers) if (PROVIDER_KINDS[p.id]) p.kinds = PROVIDER_KINDS[p.id];

export const registerProvider = (provider: Provider) => {
    providers.push(provider);
};

export const getProviders = (): Provider[] => {
    return providers;
};

/** Providers that serve the given content kind (undefined `kinds` = all kinds). */
export const getProvidersForKind = (kind: ContentKind): Provider[] =>
    providers.filter((p) => !p.kinds || p.kinds.includes(kind));

/** Torrent providers — run ONLY in torrent mode. Kind-gated so a movie doesn't hit the
 *  anime tracker and vice-versa; the SSE filters these by the title's content kind. */
const TORRENT_PROVIDERS: Provider[] = (() => {
    TorrentAnimeProvider.kinds = ['anime'];
    TorrentMovieProvider.kinds = ['movie'];
    TorrentTvProvider.kinds = ['series', 'asian'];
    return [TorrentAnimeProvider, TorrentMovieProvider, TorrentTvProvider];
})();
export const torrentProviders = (): Provider[] => TORRENT_PROVIDERS;
