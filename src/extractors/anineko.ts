import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';
import { app } from '../utils/http';
import { flareSolverrGetHtml } from '../utils/flaresolverr';
import { findMediaUrl } from '../utils/hostextractors';
import { seasonScore, norm } from '../utils/season';
import { animeSearchTitles } from '../anime';
import { getLanguage } from '../utils/common';

/**
 * AniNeko (anineko.to) — SUB / Hard-Sub / DUB anime.
 *
 * Flow (all site pages via FlareSolverr — the whole site is behind a Cloudflare JS
 * challenge; FlareSolverr solves it and returns rendered HTML, so no vrf/token dance):
 *   /browser?keyword=<title>            → .nv-anime-card → slug
 *   /watch/<slug>/ep-<episode>          → [data-video] embeds grouped by data-id (sub|hsub|dub)
 *   embed (playmogo/vivibebe/otakuvid/otakuhg/…) → Dean-Edwards packed `…m3u8`
 * Subtitles ride along in the embed URL's caption/sub query params (cdn.anizara.store .vtt).
 *
 * anineko splits a show into one entry per season ("… Season 2"), so we match the
 * requested season via seasonScore (like AnimePahe/AniZone), not just the title.
 */
const BASE = (process.env.ANINEKO_BASE_URL || 'https://anineko.to').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

interface Card { slug: string; title: string }

/** Parse the /browser search grid into {slug,title} cards. */
function parseSearch(html: string): Card[] {
    const $ = cheerio.load(html);
    const cards: Card[] = [];
    const seen = new Set<string>();
    $('a[href*="/watch/"]').each((_i, a) => {
        const href = $(a).attr('href') || '';
        const slug = (href.split('/watch/')[1] || '').split(/[/?#]/)[0];
        if (!slug || seen.has(slug)) return;
        // slug may sit on a thumb link with no text — pull the title from the card's img/alt.
        const card = $(a).closest('.nv-anime-card, article, .item, li');
        const title = ($(a).attr('title') || card.find('img').attr('alt') || card.find('.nv-anime-title, .title, h3').first().text() || $(a).text() || slug).trim();
        seen.add(slug);
        cards.push({ slug, title });
    });
    return cards;
}

/** Pull subtitle tracks out of an embed URL's caption/sub query params. */
function subsFromEmbed(embedUrl: string): Subtitle[] {
    const out: Subtitle[] = [];
    try {
        const q = new URL(embedUrl).searchParams;
        for (const [k, v] of q) {
            if (!/sub|caption|c\d*_file|track/i.test(k)) continue;
            if (!/^https?:\/\//.test(v) || !/\.(vtt|srt|ass)(\?|$)/i.test(v)) continue;
            // lang hint sometimes encoded in a sibling param or the filename; default English.
            out.push({ language: getLanguage('en') || 'English', url: v });
        }
    } catch { /* ignore */ }
    return out;
}

/** Resolve an embed page (packed-JS player) to its .m3u8. */
async function resolveEmbed(embedUrl: string): Promise<string | null> {
    try {
        const r = await app.get(embedUrl, { referer: `${BASE}/`, headers: { 'User-Agent': UA, Referer: `${BASE}/` }, timeout: 15000 });
        return findMediaUrl(r.text, ['m3u8'], embedUrl) ?? null;
    } catch { return null; }
}

export const AniNekoProvider: Provider = {
    id: 'anineko',
    name: 'AniNeko',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        const subtitles: Subtitle[] = [];
        if (!data.isAnime || !data.title) return { streams, subtitles };
        const episode = data.type === 'movie' ? 1 : (data.episode ?? 1);

        try {
            // 1) search → best slug for the requested season
            let cards: Card[] = [];
            for (const q of animeSearchTitles(data)) {
                const html = await flareSolverrGetHtml(`${BASE}/browser?keyword=${encodeURIComponent(q)}`);
                cards = html ? parseSearch(html) : [];
                if (process.env.ANIME_DEBUG) console.error(`[AniNeko] search "${q}": ${cards.length}`);
                if (cards.length) break;
            }
            if (!cards.length) return { streams, subtitles };

            const want = norm(data.title);
            const wantSeason = (data.type === 'movie' || data.seasonResolved) ? undefined : (data.season ?? 1);
            const pick = cards.map((c) => {
                const t = norm(c.title);
                let s = t === want ? 3 : (t.includes(want) || want.includes(t)) ? 1 : 0;
                if (wantSeason) s += seasonScore(c.title, wantSeason, data.seasonYear);
                return { c, s };
            }).sort((x, y) => y.s - x.s)[0]?.c;
            if (!pick) return { streams, subtitles };

            // 2) episode page → data-video embeds grouped by data-id (sub | hsub | dub)
            const epHtml = await flareSolverrGetHtml(`${BASE}/watch/${pick.slug}/ep-${episode}`);
            if (!epHtml) return { streams, subtitles };
            const $ = cheerio.load(epHtml);
            interface Emb { url: string; dub: boolean }
            const embeds: Emb[] = [];
            const seenUrl = new Set<string>();
            $('[data-video]').each((_i, el) => {
                const url = $(el).attr('data-video') || '';
                if (!/^https?:\/\//.test(url) || seenUrl.has(url)) return;
                const group = (($(el).attr('data-id') || $(el).closest('[data-id]').attr('data-id') || '') + ' ' + $(el).text()).toLowerCase();
                seenUrl.add(url);
                embeds.push({ url, dub: /dub/.test(group) });
            });
            if (process.env.ANIME_DEBUG) console.error(`[AniNeko] slug=${pick.slug} ep=${episode} embeds=${embeds.length}`);
            if (!embeds.length) return { streams, subtitles };

            // Resolve at most ~2 SUB + ~2 DUB embeds (each is a network round-trip; the rest
            // are near-duplicate mirrors). Different hosts mirror the same file.
            const cap = (dub: boolean) => embeds.filter((e) => e.dub === dub).slice(0, 2);
            const chosen = [...cap(false), ...cap(true)];
            await Promise.all(chosen.map(async (e) => {
                for (const sub of subsFromEmbed(e.url)) if (!subtitles.find((x) => x.url === sub.url)) subtitles.push(sub);
                const m3u8 = await resolveEmbed(e.url);
                if (process.env.ANIME_DEBUG) console.error(`[AniNeko] ${e.dub ? 'DUB' : 'SUB'} ${e.url.slice(0, 45)} => ${m3u8 ? m3u8.slice(0, 55) : 'NULL'}`);
                if (m3u8 && !streams.find((s) => s.link === m3u8)) {
                    const host = (() => { try { return new URL(e.url).hostname; } catch { return 'AniNeko'; } })();
                    streams.push({
                        server: `AniNeko ${e.dub ? 'DUB' : 'SUB'} · ${host}`,
                        link: m3u8, type: 'm3u8',
                        headers: { Referer: `${BASE}/`, Origin: BASE },
                    });
                }
            }));
        } catch (e: any) {
            console.error('Error in AniNeko extractor:', e?.message || e);
        }
        return { streams, subtitles };
    },
};
