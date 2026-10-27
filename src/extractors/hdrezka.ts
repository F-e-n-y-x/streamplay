import net from '../utils/net';
import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';
import { norm } from '../utils/season';

/**
 * HDRezka (rezka.ag) — a very large movies + series catalogue with multiple audio
 * "translations" per title (original + many dubs). Ported from the hexated
 * CloudStream extractor. Flow (plain HTTP, no Cloudflare on rezka.ag):
 *
 *   /search/?do=search&subaction=search&q=<title>   → .b-content__inline_item cards
 *   <film page>                                      → #translators-list + default
 *                                                      translator (initCDN*Events)
 *   POST /ajax/get_cdn_series/?t=<ts>
 *        movie : id, translator_id, action=get_movie
 *        series: id, translator_id, season, episode, action=get_stream
 *        → { url: "[360p]a or b,[720p]c", subtitle: "[English]url,..." }
 *
 * The `url` is sometimes a base64 "trash" blob (clearTrash decodes it); often it's
 * already the plain "[quality]url or mirror,..." CSV. Each url is an HLS manifest
 * (…:hls:manifest.m3u8).
 */
const BASE = (process.env.HDREZKA_BASE_URL || 'https://rezka.ag').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: `${BASE}/`, 'Accept-Language': 'en-US,en;q=0.9' };

/**
 * Decode HDRezka's obfuscated stream string. Plain responses start with "[" and pass
 * through untouched. Otherwise: strip the "#h" markers, drop the base64 of every 2-
 * and 3-char combination of the "trash" alphabet (@ # ! ^ $), then base64-decode the
 * remainder. (Canonical hdrezka clearTrash algorithm.)
 */
function clearTrash(data: string): string {
    if (!data) return data;
    if (data.startsWith('[')) return data;
    const alphabet = ['@', '#', '!', '^', '$'];
    const combos: string[] = [];
    const build = (prefix: string, depth: number) => {
        if (depth === 0) { combos.push(prefix); return; }
        for (const c of alphabet) build(prefix + c, depth - 1);
    };
    build('', 2); build('', 3);   // 25 + 125 combinations
    let s = data.split('#h').join('').split('//_//').join('');
    for (const c of combos) s = s.split(Buffer.from(c, 'utf8').toString('base64')).join('');
    try { return Buffer.from(s + '===', 'base64').toString('utf8'); } catch { return ''; }
}

/** Parse a "[360p]a or b,[720p]c" CSV into {quality, url} (best mirror, prefer m3u8). */
function parseStreams(decoded: string): { quality: string; url: string }[] {
    const out: { quality: string; url: string }[] = [];
    for (const part of decoded.split(',')) {
        const m = part.match(/^\s*\[([^\]]+)\](.+)$/);
        if (!m) continue;
        const quality = (m[1].match(/\d{3,4}/) || [''])[0];
        const mirrors = m[2].split(' or ').map((u) => u.trim()).filter((u) => /^https?:\/\//.test(u));
        const url = mirrors.find((u) => /\.m3u8/i.test(u)) || mirrors[0];
        if (url) out.push({ quality, url });
    }
    return out;
}

/** Parse subtitle CSV "[English]url,[Русский]url" into tracks. */
function parseSubs(raw: unknown): Subtitle[] {
    if (typeof raw !== 'string' || !raw) return [];
    const out: Subtitle[] = [];
    for (const m of raw.matchAll(/\[([^\]]+)\](https?:\/\/[^,]+)/g)) {
        out.push({ language: m[1].trim(), url: m[2].trim() });
    }
    return out;
}

interface Hit { id: string; url: string; isSeries: boolean; year?: number; title: string }

function parseSearch(html: string): Hit[] {
    const $ = cheerio.load(html);
    const hits: Hit[] = [];
    $('.b-content__inline_item').each((_i, el) => {
        const a = $(el).find('.b-content__inline_item-link a').first();
        const href = a.attr('href') || '';
        const id = (href.match(/\/(\d+)-/) || [])[1];
        if (!id || !/\.html$/.test(href)) return;
        const title = a.text().trim();
        const meta = $(el).find('.b-content__inline_item-link div').first().text().trim();
        const year = Number((href.match(/-(\d{4})(?:-|\.)/) || meta.match(/(\d{4})/) || [])[1]) || undefined;
        hits.push({ id, url: href, isSeries: /\/series\//.test(href), year, title });
    });
    return hits;
}

/** POST the CDN ajax and return the decoded {streams, subs}. */
async function cdnAjax(body: Record<string, string>): Promise<{ streams: { quality: string; url: string }[]; subs: Subtitle[] }> {
    const form = new URLSearchParams({ ...body, is_camrip: '0', is_ads: '0', is_director: '0' }).toString();
    const r = await net.post(`${BASE}/ajax/get_cdn_series/?t=${Date.now()}`, form, {
        headers: { ...HEADERS, 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
    });
    if (!r.data?.success || !r.data?.url) return { streams: [], subs: [] };
    return { streams: parseStreams(clearTrash(String(r.data.url))), subs: parseSubs(r.data.subtitle) };
}

export const HDRezkaProvider: Provider = {
    id: 'hdrezka',
    name: 'HDRezka',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const streams: Stream[] = [];
        const subtitles: Subtitle[] = [];
        if (!data.title) return { streams, subtitles };

        try {
            // 1) search (try the original title too — HDRezka indexes both) → best hit
            const queries = [...new Set([data.title, data.orgTitle].filter(Boolean) as string[])];
            let hits: Hit[] = [];
            for (const q of queries) {
                const r = await net.get(`${BASE}/search/?do=search&subaction=search&q=${encodeURIComponent(q)}`, { headers: HEADERS, timeout: 15000 });
                hits = parseSearch(r.data);
                if (hits.length) break;
            }
            if (!hits.length) return { streams, subtitles };

            const wantSeries = data.type === 'tv';
            // Search cards carry the series' FIRST-air year, so compare against data.year
            // (seasonYear of S3 would penalise the right show).
            const wantYear = data.year;
            const want = norm(data.title), wantOrg = data.orgTitle ? norm(data.orgTitle) : '';
            const pick = hits.map((h) => {
                let s = h.isSeries === wantSeries ? 2 : -3;          // right medium first
                const t = norm(h.title);
                if (t === want || (wantOrg && t === wantOrg)) s += 2;
                else if (t.includes(want) || want.includes(t)) s += 1;
                if (wantYear && h.year) s += h.year === wantYear ? 2 : -Math.min(2, Math.abs(h.year - wantYear) * 0.5);
                return { h, s };
            }).sort((a, b) => b.s - a.s)[0];
            if (!pick || pick.s <= 0) return { streams, subtitles };
            const hit = pick.h;

            // 2) film page → translators (+ the default one from the CDN init call)
            const page = (await net.get(hit.url, { headers: HEADERS, timeout: 15000 })).data as string;
            const $ = cheerio.load(page);
            const translators: { id: string; name: string }[] = [];
            $('#translators-list li[data-translator_id]').each((_i, el) => {
                translators.push({ id: $(el).attr('data-translator_id') || '', name: $(el).text().trim() || 'HDRezka' });
            });
            const initDefault = (page.match(/initCDN(?:Movies|Series)Events\(\d+,\s*(\d+)/) || [])[1];
            if (initDefault && !translators.some((t) => t.id === initDefault)) translators.unshift({ id: initDefault, name: 'Original' });
            if (!translators.length && initDefault) translators.push({ id: initDefault, name: 'Original' });
            if (!translators.length) return { streams, subtitles };

            // 3) resolve up to 3 translations (each = one audio); dedupe streams by url.
            const chosen = translators.slice(0, 3);
            const results = await Promise.all(chosen.map(async (tr) => {
                try {
                    const body: Record<string, string> = data.type === 'tv'
                        ? { id: hit.id, translator_id: tr.id, season: String(data.season ?? 1), episode: String(data.episode ?? 1), action: 'get_stream' }
                        : { id: hit.id, translator_id: tr.id, action: 'get_movie' };
                    return { tr, ...(await cdnAjax(body)) };
                } catch { return { tr, streams: [] as { quality: string; url: string }[], subs: [] as Subtitle[] }; }
            }));

            const seen = new Set<string>();
            for (const res of results) {
                for (const sub of res.subs) if (!subtitles.find((x) => x.url === sub.url)) subtitles.push(sub);
                for (const st of res.streams) {
                    if (seen.has(st.url)) continue;
                    seen.add(st.url);
                    streams.push({
                        server: `HDRezka · ${res.tr.name}${st.quality ? ` ${st.quality}p` : ''}`,
                        link: st.url,
                        type: /\.m3u8/i.test(st.url) ? 'm3u8' : 'mp4',
                        quality: st.quality ? `${st.quality}p` : undefined,
                        headers: { Referer: `${BASE}/`, 'User-Agent': UA },
                    });
                }
            }
        } catch (e: any) {
            console.error('Error in HDRezka extractor:', e?.message || e);
        }
        return { streams, subtitles };
    },
};
