import { Provider } from '../types';

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

// --- Subtitle providers ---
import { SubtitleApiProvider } from './subtitleapi';
import { WyzieSubsProvider } from './wyziesubs';

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

export const registerProvider = (provider: Provider) => {
    providers.push(provider);
};

export const getProviders = (): Provider[] => {
    return providers;
};
