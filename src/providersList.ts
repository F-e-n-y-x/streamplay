import { providers } from './extractors';

/**
 * Base host per ACTIVE provider — pinged by /providers/health and shown as the host
 * label. Derived from the registry so a removed/disabled provider drops out by itself;
 * a provider missing here simply has no health ping.
 * ponytail: scrapers on rotating domains (domains.json) carry the snapshot current at
 * writing (2026-10); resolve via getDomain() if the health page must follow rotations.
 */
const env = (k: string, d: string) => (process.env[k] || d).replace(/\/+$/, '');
const HOSTS: Record<string, string> = {
    anizone: env('ANIZONE_BASE_URL', 'https://anizone.to'),
    anineko: env('ANINEKO_BASE_URL', 'https://anineko.to'),
    animenosub: env('ANIMENOSUB_BASE_URL', 'https://animenosub.to'),
    animeworld: env('ANIMEWORLD_BASE_URL', 'https://watchanimeworld.net'),
    consumet: env('CONSUMET_URL', ''),
    '2embed': 'https://www.2embed.cc',
    anikage: 'https://anikage.cc',
    just4anime: 'https://api.just4anime.online',
    animekizz: 'https://animekizz.live',
    vidfast: 'https://vidfast.vc',
    vidlink: 'https://vidlink.pro',
    videasy: 'https://api.wecollege.net',
    vidrock: 'https://vidrock.ru',
    hexasu: 'https://theemoviedb.hexa.su',
    rivestream: 'https://www.rivestream.app',
    allmovieland: 'https://allmovieland.io',
    xpass: 'https://play.xpass.top',
    vaplayer: 'https://streamdata.vaplayer.ru',
    dahmermovies: 'https://a.111477.xyz',
    kisskh: 'https://kisskh.nl',
    castle: 'https://api.hlowb.com',
    vegamovies: 'https://new1.vegamovies.lease',
    hdhub4u: 'https://new9.hdhub4u.cl',
    fourkhdhub: 'https://4khdhub.one',
    movies4u: 'https://new3.movies4u.garden',
    rogmovies: 'https://rogmovies.im',
    multimovies: 'https://m1.multimovies.courses',
    uhdmovies: 'https://uhdmovies.beauty',
    moviesmod: 'https://moviesmod.meme',
    topmovies: 'https://moviesleech.club',
    bollyflix: 'https://bollyflix.co.za',
    cinemacity: 'https://cinemacity.cc',
    hdrezka: env('HDREZKA_BASE_URL', 'https://rezka.ag'),
    subtitleapi: 'https://opensubtitles-v3.strem.io',
    wyziesubs: 'https://sub.wyzie.ru',
};

export const providerDomains = providers
    .filter((p) => HOSTS[p.id])
    .map((p) => ({ id: p.id, name: p.name, url: HOSTS[p.id] }));
