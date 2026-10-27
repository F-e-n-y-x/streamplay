import { Provider, ContentKind } from '../types';

// --- Video providers ---
import { KissKhProvider } from './kisskh';
import { TwoEmbedProvider } from './twoembed';
import { VidFastProvider } from './vidfast';
import { VidlinkProvider } from './vidlink';       // enc-dec.app → /api/b (mp4 qualities + captions)
import { VidEasyProvider } from './videasy';       // api.wecollege.net seed flow + enc-dec dec-videasy
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
import { HDRezkaProvider } from './hdrezka';   // huge movies+series catalog (multi-audio), no Cloudflare

// --- Anime providers (title-matched; via the persistent FlareSolverr session) ---
//     AniZone works (single HLS with JP/KR/EN audio + many subtitle tracks).
//     AnimePahe is active but BEST-EFFORT: it resolves real SUB/DUB, but its Kwik
//     CDN IP-bans many datacenter egresses — where that happens it returns nothing
//     (and can burn up to PROVIDER_TIMEOUT_MS before doing so). Move it to
//     disabledProviders below if your network is Kwik-banned.
import { AllAnimeProvider } from './allanime';    // ani-cli backend: reliable native SUB + DUB, no FlareSolverr/key
import { AniZoneProvider } from './anizone';
import { AniNekoProvider } from './anineko';       // anineko.to: SUB/HardSub/DUB via FlareSolverr + packed embeds
import { AnimeNoSubProvider } from './animenosub';  // animenosub.to: English SUB+DUB, plain HTTP → megaplay m3u8
import { AnimeWorldProvider } from './animeworld';
import { ConsumetProvider } from './consumet';   // multi-backend aggregator (opt-in via CONSUMET_URL)
import { AnimePaheProvider } from './animepahe';
import { AnikageProvider } from './anikage';        // AniList-id JSON API: sub+dub HLS (og.bakayaro.live)
import { Just4AnimeProvider } from './just4anime';  // AniList-id JSON API: sub/dub/hsub HLS + subtitles
import { AnimekizzProvider } from './animekizz';    // AniList-id JSON API: sub/dub/softsub HLS + subtitles

// --- Admin-configured addons (NUVIO_PLUGINS / STREMIO_ADDONS), registered at runtime ---
import { nuvioProviders } from './nuvio';
import { stremioProviders, stremioTorrentProviders } from './stremio';

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
import { MovieBoxProvider } from './moviebox';     // H5 API resolves, but its bcdnw/bcdnxw CDN 429s this egress (VidLink serves the same catalog via bcdn)
import { VidzeeProvider } from './vidzee';         // rotated AES key (stale secret)
import { MappleProvider } from './mapple';         // /api/stream-token routes removed (Turnstile)
import { VidSrcXyzProvider } from './vidsrcxyz';   // prorcp now Cloudflare-Turnstile gated
import { PeachifyProvider } from './peachify';     // rotated AES-GCM key
import { NineTvProvider } from './ninetv';         // moviesapi.club DNS no longer resolves
import { MoviesDriveProvider } from './moviesdrive'; // upstream files removed (recovery pages)
import { Hdmovie2Provider } from './hdmovie2';     // hdmo2.com domain degraded (404s)

/**
 * Built-in scrapers. OFF by default since 2.0 — sources come from the Nuvio/Stremio
 * addons (NUVIO_PLUGINS / STREMIO_ADDONS). Set BUILTIN_PROVIDERS=on to serve them again.
 * Cloudflare-gated providers (UHDMovies, MoviesMod, TopMovies, MultiMovies,
 * CineMacity, ...) rely on FLARESOLVERR_URL being set in `.env`.
 */
export const builtinProviders: Provider[] = [
    // === Anime first ===
    // Dedicated anime providers run (and rank) ahead of the generic movie/TV
    // sources for anime titles. Each early-returns for non-anime content, so this
    // ordering costs movies nothing while putting the good sub/dub sources at the
    // top of the list for anime.
    AniZoneProvider,      // HLS + multi-audio (JP/KR/EN) + subtitles
    AniNekoProvider,      // anineko.to — SUB/HardSub/DUB (FlareSolverr-solved, packed embeds)
    AnimeNoSubProvider,   // animenosub.to — English SUB+DUB, plain HTTP → megaplay direct m3u8
    AnimeWorldProvider,   // Indian dubs (Hindi/Tamil/Telugu) + Eng/Jap via zephyrflick
    AnikageProvider,      // AniList-id API: sub+dub HLS, 8 servers
    Just4AnimeProvider,   // AniList-id API: sub/dub/hsub HLS + subtitles
    AnimekizzProvider,    // AniList-id API: sub/dub/softsub HLS + subtitles
    ConsumetProvider,     // aggregator: Zoro/AnimePahe/Gogo/AnimeKai fallback (needs CONSUMET_URL)

    // direct-API (fast, reliable)
    TwoEmbedProvider,
    VidFastProvider,
    VidlinkProvider,
    VidEasyProvider,
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
    HDRezkaProvider,      // large movies + series catalog with multiple audio tracks (rezka.ag)
];

/** Active built-ins: the subtitle providers always, the scrapers only with BUILTIN_PROVIDERS=on. */
export const providers: Provider[] = [
    ...(process.env.BUILTIN_PROVIDERS === 'on' ? builtinProviders : []),
    SubtitleApiProvider,
    WyzieSubsProvider,
];

/** Ported but disabled (dead/changed upstream). Not served; here for reference + easy revival. */
export const disabledProviders: Provider[] = [
    // AllAnime gates episode sources behind an IP-reputation captcha (NEED_CAPTCHA) that
    // is triggered on this box's direct IP AND its WARP egress IPs (verified live 2026-07)
    // → resolves 0 streams every request. Revive from a clean residential IP.
    AllAnimeProvider,
    // kwik.cx (AnimePahe's video CDN) returns a Cloudflare 403 on direct, WARP, AND
    // FlareSolverr egress (verified 2026-07) → it resolves nothing while burning a
    // FlareSolverr solve on search/release/play every anime request (and returns state
    // `empty`, which doesn't trip the circuit breaker). Revive when kwik clears, or use
    // a self-hosted Consumet (its own maintained AnimePahe extractor).
    AnimePaheProvider,
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
    allanime: ['anime'], anizone: ['anime'], anikage: ['anime'], just4anime: ['anime'], animekizz: ['anime'], anineko: ['anime'], animenosub: ['anime'], animepahe: ['anime'], consumet: ['anime'],
    // Asian drama
    kisskh: ['asian'],
    // CastleTV also carries Indian-dubbed anime (Hindi/Tamil/Telugu), so it runs for anime too.
    castle: ['movie', 'series', 'asian', 'anime'],
    // Indian / scraper multi (movies + series + Asian, NOT anime — AnimeWorld covers dubbed anime)
    vegamovies: ['movie', 'series', 'asian'], hdhub4u: ['movie', 'series', 'asian'], fourkhdhub: ['movie', 'series', 'asian'],
    movies4u: ['movie', 'series', 'asian'], rogmovies: ['movie', 'series', 'asian'], multimovies: ['movie', 'series', 'asian'],
    uhdmovies: ['movie', 'series', 'asian'], moviesmod: ['movie', 'series', 'asian'], topmovies: ['movie', 'series', 'asian'],
    bollyflix: ['movie', 'series', 'asian'], cinemacity: ['movie', 'series', 'asian'],
    // HDRezka: movies + series + Asian drama (Russian-origin catalog, multi-audio). Not
    // anime — the dedicated anime providers cover that with better sub/dub handling.
    hdrezka: ['movie', 'series', 'asian'],
};
for (const p of builtinProviders) if (PROVIDER_KINDS[p.id]) p.kinds = PROVIDER_KINDS[p.id];

/** Built-ins + the admin-configured Nuvio plugins / Stremio addons (loaded at runtime). */
export const getProviders = (): Provider[] => [...providers, ...nuvioProviders(), ...stremioProviders()];

/** Providers that serve the given content kind (undefined `kinds` = all kinds). */
export const getProvidersForKind = (kind: ContentKind): Provider[] =>
    getProviders().filter((p) => !p.kinds || p.kinds.includes(kind));

/** Torrent providers — run ONLY in torrent mode. Kind-gated so a movie doesn't hit the
 *  anime tracker and vice-versa; the SSE filters these by the title's content kind. */
const TORRENT_PROVIDERS: Provider[] = (() => {
    TorrentAnimeProvider.kinds = ['anime'];
    TorrentMovieProvider.kinds = ['movie'];
    TorrentTvProvider.kinds = ['series', 'asian'];
    return [TorrentAnimeProvider, TorrentMovieProvider, TorrentTvProvider];
})();
export const torrentProviders = (): Provider[] => [...TORRENT_PROVIDERS, ...stremioTorrentProviders()];
