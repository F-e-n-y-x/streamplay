import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';
import { app } from '../utils/http';
import { seasonScore, norm } from '../utils/season';
import { animeSearchTitles } from '../anime';
import { getLanguage } from '../utils/common';
import { loadExtractor, findMediaUrl } from '../utils/hostextractors';
import { flareSolverrGetHtml } from '../utils/flaresolverr';

/**
 * AnimeNoSub (animenosub.to) — English SUB + DUB anime, DooPlay WordPress site,
 * plain HTTP (no Cloudflare). Flow:
 *   /?s=<title>                       → /anime/<slug>/ cards
 *   /anime/<slug>/                    → /<slug>-episode-<n>/ episode links
 *   /<slug>-episode-<n>/              → megaplay.buzz/stream/s-2/<id>/sub iframe
 *   megaplay /stream/s-2/<id>/<sub|dub> → data-id → /stream/getSources?id=<data-id>
 *      → { sources:{ file: master.m3u8 }, tracks:[ {file:.vtt,label,kind} ] }
 * DUB is a clean /sub → /dub swap on the megaplay URL (distinct id + stream).
 */
const BASE = (process.env.ANIMENOSUB_BASE_URL || 'https://animenosub.to').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

interface Card { slug: string; url: string; title: string }

/** Parse the /?s= search results into {slug,url,title} anime cards. */
function parseSearch(html: string): Card[] {
    const $ = cheerio.load(html);
    const cards: Card[] = [];
    const seen = new Set<string>();
    $('a[href*="/anime/"]').each((_i, a) => {
        const url = ($(a).attr('href') || '').split('#')[0];
        const m = url.match(/\/anime\/([^/]+)\/?$/);
        if (!m) return;
        const slug = m[1];
        if (seen.has(slug)) return;
        const title = ($(a).attr('title') || $(a).find('img').attr('alt') || $(a).text() || slug).trim();
        seen.add(slug);
        cards.push({ slug, url: new URL(url, `${BASE}/`).href, title });
    });
    return cards;
}

/** Resolve a megaplay embed (…/stream/s-2/<id>/<sub|dub>) to its m3u8 + subtitle tracks. */
async function resolveMegaplay(embedUrl: string): Promise<{ m3u8?: string; subs: Subtitle[] }> {
    const subs: Subtitle[] = [];
    try {
        const page = await app.get(embedUrl, { referer: `${BASE}/`, headers: { 'User-Agent': UA }, timeout: 15000 });
        const id = (page.text.match(/data-id="(\d+)"/) || [])[1];
        if (!id) return { subs };
        const origin = new URL(embedUrl).origin;
        const r = await app.get(`${origin}/stream/getSources?id=${id}`, {
            referer: `${origin}/`, headers: { 'User-Agent': UA, 'X-Requested-With': 'XMLHttpRequest' }, timeout: 15000,
        });
        const data = JSON.parse(r.text);
        for (const t of (data.tracks || [])) {
            if (t.kind === 'captions' && t.file) subs.push({ language: getLanguage(t.label) || t.label || 'Sub', url: t.file });
        }
        return { m3u8: data.sources?.file, subs };
    } catch { return { subs }; }
}

export const AnimeNoSubProvider: Provider = {
    id: 'animenosub',
    name: 'AnimeNoSub',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        const subtitles: Subtitle[] = [];
        if (!data.isAnime || !data.title) return { streams, subtitles };
        const episode = data.type === 'movie' ? 1 : (data.episode ?? 1);

        try {
            // 1) search → best-matching anime (per requested season)
            let cards: Card[] = [];
            for (const q of animeSearchTitles(data)) {
                const html = (await app.get(`${BASE}/?s=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA }, timeout: 15000 })).text;
                cards = parseSearch(html);
                if (process.env.ANIME_DEBUG) console.error(`[AnimeNoSub] search "${q}": ${cards.length}`);
                if (cards.length) break;
            }
            if (!cards.length) return { streams, subtitles };

            const want = norm(data.title);
            const wantSeason = (data.type === 'movie' || data.seasonResolved) ? undefined : (data.season ?? 1);
            const wantOrg = data.orgTitle ? norm(data.orgTitle) : '';
            // animenosub lists a show's movies/arcs/dub-variants as SEPARATE entries, so
            // score by the noise-stripped title, penalise film/arc/OVA entries for a normal
            // episode request, then try the top candidates until one actually HAS the
            // requested episode (a movie/arc/wrong-season entry won't, so it's skipped).
            const stripNoise = (t: string) => t.replace(/\((?:dub|sub|subbed|dubbed|uncensored|tv|bd|hd)\)/gi, ' ').replace(/\b(?:bd|dubbed|subbed)\b/gi, ' ').replace(/\s+/g, ' ').trim();
            const extraRe = /\b(movie|film|arc|compilation|ova|special|recap|part\s*\d)\b/i;
            const candidates = cards.map((c) => {
                const t = norm(stripNoise(c.title));
                let s = (t === want || (wantOrg && t === wantOrg)) ? 4
                    : (t.includes(want) || want.includes(t) || (wantOrg && (t.includes(wantOrg) || wantOrg.includes(t)))) ? 1 : 0;
                if (s > 0) {
                    if (data.type !== 'movie' && extraRe.test(c.title)) s -= 2;
                    if (wantSeason) s += seasonScore(c.title, wantSeason, data.seasonYear);
                }
                return { c, s };
            }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s).map((x) => x.c);
            if (!candidates.length) return { streams, subtitles };

            for (const pick of candidates.slice(0, 5)) {
                // 2) anime page → the episode link matching the requested number
                const animeHtml = (await app.get(pick.url, { referer: `${BASE}/`, headers: { 'User-Agent': UA }, timeout: 15000 })).text;
                const $ = cheerio.load(animeHtml);
                let epUrl = '';
                $('a[href*="-episode-"]').each((_i, a) => {
                    const href = ($(a).attr('href') || '').split('#')[0];
                    const n = Number((href.match(/-episode-(\d+)/) || [])[1]);
                    if (n === episode && !epUrl) epUrl = new URL(href, pick.url).href;
                });
                if (!epUrl) continue;   // this entry lacks the episode → try the next candidate

                // 3) episode page → the player iframe (host varies per title)
                const epHtml = (await app.get(epUrl, { referer: pick.url, headers: { 'User-Agent': UA }, timeout: 15000 })).text;
                const iframe = (epHtml.match(/<iframe[^>]+(?:data-src|src)="([^"]+)"/i) || [])[1];
                if (!iframe) continue;
                const embed = new URL(iframe, epUrl).href;

                if (/megaplay\./i.test(embed)) {
                    // megaplay → resolve SUB and DUB via the /sub↔/dub swap → direct m3u8.
                    const subUrl = embed.replace(/\/(sub|dub)\/?$/, '/sub');
                    const dubUrl = embed.replace(/\/(sub|dub)\/?$/, '/dub');
                    const variants: { url: string; dub: boolean }[] = [{ url: subUrl, dub: false }];
                    if (dubUrl !== subUrl) variants.push({ url: dubUrl, dub: true });
                    const mp = new URL(embed).origin;   // megaplay mirror varies (.buzz/…): send ITS origin
                    await Promise.all(variants.map(async (v) => {
                        const { m3u8, subs } = await resolveMegaplay(v.url);
                        for (const sub of subs) if (!subtitles.find((x) => x.url === sub.url)) subtitles.push(sub);
                        if (m3u8 && !streams.find((s) => s.link === m3u8)) {
                            streams.push({ server: `AnimeNoSub ${v.dub ? 'DUB' : 'SUB'}`, link: m3u8, type: 'm3u8', headers: { Referer: `${mp}/`, Origin: mp } });
                        }
                    }));
                } else {
                    // Other hosts. Try the shared extractor first (fast, plain HTTP — handles
                    // the StreamWish/Filelions/VidHide family that DON'T gate). If it finds
                    // nothing, the host is likely a JS-anti-bot INTERSTITIAL ("Redirecting…",
                    // e.g. sbanh/sblongvu) that only a headless render passes — fall back to
                    // FlareSolverr and pull the m3u8 out of the (packed) player.
                    const origin = (() => { try { return new URL(embed).origin; } catch { return BASE; } })();
                    const host = (() => { try { return new URL(embed).hostname; } catch { return 'AnimeNoSub'; } })();
                    const res = await loadExtractor(embed, `${BASE}/`);
                    for (const sub of res.subtitles) if (!subtitles.find((x) => x.url === sub.url)) subtitles.push(sub);
                    for (const st of res.streams) if (!streams.find((s) => s.link === st.link)) streams.push({ ...st, server: `AnimeNoSub · ${st.server}` });

                    if (!res.streams.length) {
                        const rendered = await flareSolverrGetHtml(embed).catch(() => null);
                        if (rendered) {
                            const m3u8 = findMediaUrl(rendered, ['m3u8'], embed);
                            if (process.env.ANIME_DEBUG) console.error(`[AnimeNoSub] FS render ${host} => ${m3u8 ? m3u8.slice(0, 55) : 'NULL'}`);
                            if (m3u8 && !streams.find((s) => s.link === m3u8)) {
                                streams.push({ server: `AnimeNoSub · ${host}`, link: m3u8, type: 'm3u8', headers: { Referer: `${origin}/`, Origin: origin } });
                            }
                        }
                    }
                }
                if (process.env.ANIME_DEBUG) console.error(`[AnimeNoSub] ${pick.slug} ep${episode} host=${embed.slice(0, 40)} streams=${streams.length}`);
                if (streams.length) break;   // got this episode — stop trying candidates
            }
        } catch (e: any) {
            console.error('Error in AnimeNoSub extractor:', e?.message || e);
        }
        return { streams, subtitles };
    },
};
