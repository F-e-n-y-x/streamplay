import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';
import { app } from '../utils/http';
import { flareSolverrGetHtml } from '../utils/flaresolverr';
import { seasonScore } from '../utils/season';
import { animeSearchTitles } from '../anime';

/**
 * AniZone (anizone.to) — anime provider with a single adaptive HLS stream that
 * carries multiple audio tracks (JP/KR/EN) plus many external subtitle tracks.
 *
 * SPEED NOTE: anizone.to is a Laravel **Livewire/Alpine** app that is currently
 * served WITHOUT a Cloudflare interstitial, so we fetch it with plain HTTP (~1s)
 * instead of a FlareSolverr browser round-trip (~30-90s, and flaky). FlareSolverr
 * is kept only as a fallback for the day the site turns the challenge back on.
 *
 * Because the search grid renders its titles client-side (`x-text`/`:title`
 * Alpine bindings — absent from the raw HTML), we can't read a card's title from
 * plain search markup. Instead we take the relevance-ordered candidate `/anime/…`
 * links and confirm the right one by the *episode page's* static `<title>`
 * ("Episode N - <Anime Name> — AniZone"), which IS server-rendered.
 *
 * Flow: plain GET `/anime?search=` → candidate anime ids → for the top few, GET
 * `/anime/<id>/<ep>` and read `<title>` to confirm the match → pull the
 * `<media-player src>` (master m3u8) + `<track kind=subtitles>` list.
 */

const BASE = (process.env.ANIZONE_BASE_URL || 'https://anizone.to').replace(/\/+$/, '');

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const abs = (href: string) => (href.startsWith('http') ? href : `${BASE}${href.startsWith('/') ? '' : '/'}${href}`);
const looksChallenged = (html: string) => /just a moment|cf-browser-verification|__cf_chl|checking your browser/i.test(html);

/** Fetch a page as plain HTTP (fast); fall back to FlareSolverr only if blocked. */
async function fetchHtml(url: string): Promise<string | null> {
    try {
        const res = await app.get(url, { timeout: 12000 });
        if (res.status === 200 && res.text && !looksChallenged(res.text)) return res.text;
    } catch { /* fall through */ }
    return await flareSolverrGetHtml(url);
}

/** Anime name out of an episode page's static <title>. */
function titleOfEpisodePage(html: string): string {
    const m = html.match(/<title>([^<]*)<\/title>/i);
    if (!m) return '';
    return m[1].replace(/—\s*AniZone\s*$/i, '').replace(/^\s*Episode\s+\d+\s*[-–]\s*/i, '').trim();
}

/** Significant-token overlap so "Frieren: Beyond…" matches "Sousou no Frieren". */
function overlaps(a: string, b: string): boolean {
    const ta = new Set(norm(a).split(' ').filter((w) => w.length >= 3));
    const tb = new Set(norm(b).split(' ').filter((w) => w.length >= 3));
    for (const w of ta) if (tb.has(w)) return true;
    return false;
}


export const AniZoneProvider: Provider = {
    id: 'anizone',
    name: 'AniZone',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        const subtitles: Subtitle[] = [];
        if (!data.isAnime || !data.title) return { streams, subtitles };

        const episode = data.type === 'movie' ? 1 : (data.episode ?? 1);
        const wantSeason = (data.type === 'movie' || data.seasonResolved) ? undefined : (data.season ?? 1);

        // 1) collect relevance-ordered candidate anime ids. Try the TMDB name, the
        //    original, AND the AniList romaji/synonyms — AniZone's search matches
        //    romaji far better than TMDB's English title.
        const queries = animeSearchTitles(data);
        const candidates: string[] = [];
        for (const q of queries) {
            const html = await fetchHtml(`${BASE}/anime?search=${encodeURIComponent(q)}`);
            if (!html) continue;
            const $ = cheerio.load(html);
            $('a[href*="/anime/"]').each((_i, el) => {
                const href = $(el).attr('href') || '';
                // only bare anime pages (/anime/<id>), not episode links (/anime/<id>/<n>)
                if (!/\/anime\/[a-z0-9]+$/i.test(href)) return;
                const u = abs(href);
                if (!candidates.includes(u)) candidates.push(u);
            });
            if (candidates.length) break;
        }
        if (!candidates.length) return { streams, subtitles };

        // 2) Among candidates that actually HAVE the requested episode, pick the one
        //    whose title's SEASON best matches the requested season (see seasonScore).
        //    Fetching `${href}/${episode}` and requiring a <media-player src> also
        //    naturally filters out season-entries that don't contain this episode.
        const want = `${data.title} ${data.orgTitle || ''}`;
        // A TV-series request must not resolve to the franchise's MOVIE (e.g. Slime's
        // "Scarlet Bond", ~1h48m) — the episode grid and runtime would be wrong.
        const MOVIE_RE = /\b(movie|gekijou?ban|the movie|film|scarlet bond|mugen train|hero of the abyss)\b/i;
        // Fetch the candidate episode pages IN PARALLEL (one request time, not N) and
        // pick the highest season-scored one that actually has this episode.
        const scored = (await Promise.all(candidates.slice(0, 8).map(async (animeHref) => {
            const watchHtml = await fetchHtml(`${animeHref}/${episode}`);
            if (!watchHtml) return null;
            const src = cheerio.load(watchHtml)('media-player').attr('src');
            if (!src) return null;
            const name = titleOfEpisodePage(watchHtml);
            let score = (wantSeason ? seasonScore(name, wantSeason, data.seasonYear) : 0) + (overlaps(name, want) ? 1 : 0);
            if (data.type === 'tv' && MOVIE_RE.test(name)) score -= 5;   // don't serve the movie for a series
            return { src, html: watchHtml, score };
        }))).filter(Boolean) as { src: string; html: string; score: number }[];
        const chosen = scored.sort((a, b) => b.score - a.score)[0];
        if (!chosen) return { streams, subtitles };

        const $w = cheerio.load(chosen.html);
        $w('track[kind="subtitles"]').each((_i, el) => {
            const url = $w(el).attr('src');
            const label = $w(el).attr('label') || $w(el).attr('srclang');
            // Resolve relative track src's against BASE — a bare "/subs/…" would 404.
            if (url && label) subtitles.push({ language: label, url: abs(url) });
        });

        // Single source — the master carries all audio renditions (JP/KR/EN); the
        // player enumerates them from the manifest and switches audio in-place.
        streams.push({ server: 'AniZone', link: chosen.src, type: chosen.src.endsWith('.mp4') ? 'mp4' : 'm3u8', headers: { Referer: `${BASE}/` } });
        return { streams, subtitles };
    },
};
