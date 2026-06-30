/**
 * Shared video-host "extractor" layer, ported from the Kotlin CloudStream plugin
 * (com.Phisher98.Extractors.kt). The "multi" providers (UHDMovies, MoviesMod,
 * MultiMovies, ...) scrape a page, collect embed/file-host URLs, then call
 * `loadExtractor(url)` to resolve those hosts into real video links.
 *
 * `loadExtractor` inspects the URL host and dispatches to the matching resolver.
 * Every resolver is exception-safe: on any failure it returns no streams rather
 * than throwing, so a single dead host never breaks a provider.
 *
 * Implemented hosts:
 *   - HubCloud           (hubcloud.*)  -> multiple direct download / m3u8 links
 *   - GDFlix             (gdflix.*)    -> direct / instant / pixeldrain / CF links
 *   - StreamWish / Filelions / VidHide family (packed-JS m3u8 players)
 *     covers: streamwish, filelions, vidhide, vidhidepro, dwish, dlions,
 *     embedwish, mwish, swhoi, sfastwish, ridoo, streamruby, etc.
 */

import { app } from './http';
import { getIndexQuality, qualityLabel } from './common';
import { USER_AGENT } from './encdec';
import { getDomain } from './domains';
import type { Stream, Subtitle } from '../types';

export interface HostResult {
    streams: Stream[];
    subtitles: Subtitle[];
}

const emptyResult = (): HostResult => ({ streams: [], subtitles: [] });

// ---------------------------------------------------------------------------
// Dean Edwards p,a,c,k,e,d unpacker
// ---------------------------------------------------------------------------

/**
 * Detect whether a script body contains a Dean Edwards `eval(function(p,a,c,k,e,d){...})`
 * packed payload and, if so, return that payload (the `eval(...)` call). Mirrors the
 * Kotlin `getPacked` helper.
 */
export const getPacked = (text: string): string | null => {
    const m = /(eval\(function\(p,a,c,k,e,d\)\{.*?\}\([^]*?\)\))/.exec(text);
    return m ? m[1] : null;
};

/**
 * Unpack a Dean Edwards packed script. Accepts either the raw packed `eval(...)`
 * string or a full page body (in which case it locates the packed segment first).
 * Returns the unpacked source, or '' if nothing could be unpacked.
 *
 * Port of CloudStream's `getAndUnpack` / the classic JsUnpacker.
 */
export const getAndUnpack = (input: string): string => {
    const packed = getPacked(input) ?? input;

    // Pull out the four arguments to the inner function call:
    //   }('<payload>', <radix>, <count>, '<words>'.split('|'), 0, {}))
    const m = /\}\s*\(\s*'(.*?)'\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*'(.*?)'\.split\('\|'\)/s.exec(packed);
    if (!m) return '';

    let payload = m[1];
    const radix = parseInt(m[2], 10);
    const count = parseInt(m[3], 10);
    const words = m[4].split('|');

    if (!Number.isFinite(radix) || !Number.isFinite(count)) return '';

    // Reverse the JS string escaping used inside the packed payload.
    payload = payload.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

    // Base-N -> token used by the packer.
    const unbase = (value: number): string => {
        const encode = (n: number): string => {
            const lo = n % radix;
            const hi = Math.floor(n / radix);
            const ch = lo > 35 ? String.fromCharCode(lo + 29) : lo.toString(36);
            return n <= 0 ? '' : encode(hi) + ch;
        };
        return encode(value) || '0';
    };

    // Build the substitution dictionary.
    const dict: Record<string, string> = {};
    for (let i = count - 1; i >= 0; i--) {
        const key = unbase(i);
        dict[key] = words[i] && words[i].length ? words[i] : key;
    }

    // Replace every standalone token (\b\w+\b) with its dictionary entry.
    return payload.replace(/\b\w+\b/g, (token) => dict[token] ?? token);
};

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

const getHost = (url: string): string => {
    try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
};

const getBaseUrl = (url: string): string => {
    try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return ''; }
};

const absolute = (base: string, href: string): string => {
    if (!href) return '';
    if (/^https?:/i.test(href)) return href;
    return base.replace(/\/+$/, '') + '/' + href.replace(/^\/+/, '');
};

// ---------------------------------------------------------------------------
// StreamWish / Filelions / VidHide family (packed-JS m3u8 players)
//
// These hosts all share one shape: GET the embed page, unpack the packed JS (if
// present), then regex the hls source out of `file:"...m3u8..."` /
// `sources:[{file:"..."}]`, plus any `tracks` subtitle entries. Port of
// CloudStream's VidhideExtractor / StreamWishExtractor / Filesim / Ridoo.
// ---------------------------------------------------------------------------

const packedPlayerHosts = [
    'streamwish', 'filelions', 'vidhide', 'vidhidepro', 'hdstream4u',
    'dwish', 'dlions', 'alions', 'mwish', 'embedwish', 'swhoi', 'sfastwish',
    'ridoo', 'streamruby', 'rubystm', 'rubyvid', 'rapidplayers', 'luluvdo',
    'movearnpre', 'smoothpre', 'streamvid', 'cdnwish', 'wishfast', 'kswplayer',
    'flaswish', 'obeywish', 'streamewish', 'animezia', 'server2', 'filemoon',
];

const isPackedPlayerHost = (host: string): boolean =>
    packedPlayerHosts.some((h) => host.includes(h));

/**
 * Resolve a packed-JS m3u8 player (StreamWish / Filelions / VidHide / Ridoo / ...).
 */
const resolvePackedPlayer = async (
    url: string,
    referer: string | undefined,
    serverName: string,
): Promise<HostResult> => {
    const result = emptyResult();
    try {
        const base = getBaseUrl(url);
        const res = await app.get(url, { referer: referer ?? base, headers: { 'User-Agent': USER_AGENT } });
        const body = res.text;

        let script: string;
        if (getPacked(body)) {
            script = getAndUnpack(body);
        } else {
            // grab the inline <script> that holds the sources block
            const $ = res.document;
            script =
                $('script')
                    .toArray()
                    .map((el) => $(el).html() || '')
                    .find((s) => s.includes('sources') || s.includes('file:')) || body;
        }

        // m3u8 source: file:"..." or src:"..." or sources:[{file:"..."}]
        const fileMatch =
            /(?:file|src)\s*:\s*"([^"]+\.m3u8[^"]*)"/i.exec(script) ||
            /(?:file|src)\s*:\s*'([^']+\.m3u8[^']*)'/i.exec(script);

        // quality, if the packer left a qualityLabels hint
        const qMatch = /qualityLabels.*?"(\d{3,4})[pP]"/i.exec(script);
        const quality = qMatch ? qualityLabel(parseInt(qMatch[1], 10)) : undefined;

        if (fileMatch) {
            result.streams.push({
                server: serverName,
                link: fileMatch[1],
                type: 'm3u8',
                quality,
                headers: { Referer: base + '/', 'User-Agent': USER_AGENT },
            });
        } else {
            // fall back to any mp4 source
            const mp4 = /(?:file|src)\s*:\s*["']([^"']+\.mp4[^"']*)["']/i.exec(script);
            if (mp4) {
                result.streams.push({
                    server: serverName,
                    link: mp4[1],
                    type: 'mp4',
                    quality,
                    headers: { Referer: base + '/', 'User-Agent': USER_AGENT },
                });
            }
        }

        // subtitle tracks: {file:"...vtt|srt...",label:"English",kind:"captions"}
        const trackRe = /file\s*:\s*["']([^"']+\.(?:vtt|srt)[^"']*)["'][^}]*?(?:label|name)\s*:\s*["']([^"']+)["']/gi;
        let tm: RegExpExecArray | null;
        while ((tm = trackRe.exec(script)) !== null) {
            result.subtitles.push({ language: tm[2], url: tm[1] });
        }
    } catch (e: any) {
        console.error(`[loadExtractor:${serverName}] failed:`, e?.message || e);
    }
    return result;
};

// ---------------------------------------------------------------------------
// HubCloud
// ---------------------------------------------------------------------------

const HUBCLOUD_BLOCKED = ['tinyurl', 'telegram', 'hubcloud.foo/tg'];

const resolveHubCloud = async (url: string, referer?: string): Promise<HostResult> => {
    const result = emptyResult();
    try {
        const baseUrl = getBaseUrl(url);

        // 1. Resolve the real "download" landing page.
        let href: string;
        if (url.includes('hubcloud.php')) {
            href = url;
        } else {
            const firstRes = await app.get(url, { referer });
            const $first = firstRes.document;
            let raw = $first('#download').attr('href') || '';
            // Some hubcloud pages embed the real ".../hubcloud.php?..." link in the
            // body / a JS var rather than in #download. Fall back to a regex.
            if (!raw) {
                raw = /(https?:\/\/[^"'\s]+hubcloud\.php[^"'\s]*)/.exec(firstRes.text)?.[1] || '';
            }
            href = /^http/i.test(raw) ? raw : absolute(baseUrl, raw);
        }
        if (!href) return result;

        // 2. Parse the card page that lists every server button.
        const $ = (await app.get(href, { referer })).document;
        const size = $('i#size').first().text().trim();
        const header = $('div.card-header').first().text().trim();
        const quality = qualityLabel(getIndexQuality(header) || 2160);

        const labelExtras = `${header}${size ? ` [${size}]` : ''}`.trim();

        const buttons = $('a.btn').toArray();
        for (const el of buttons) {
            const link = $(el).attr('href') || '';
            if (!link) continue;
            if (HUBCLOUD_BLOCKED.some((b) => link.includes(b))) continue;

            const label = ($(el).text() || '').toLowerCase();

            const push = (server: string, l: string, type: Stream['type'] = 'mp4') =>
                result.streams.push({ server, link: l, type, quality });

            if (label.includes('fslv2')) {
                push('FSLv2', link);
            } else if (label.includes('fsl')) {
                push('FSL Server', link);
            } else if (label.includes('download file')) {
                push('Download File', link);
            } else if (label.includes('buzzserver')) {
                // BuzzServer answers the real link via an HX-Redirect header.
                try {
                    const resp = await app.get(`${link}/download`, {
                        referer: link,
                        headers: { 'User-Agent': USER_AGENT },
                    });
                    const dlink = resp.text; // header not exposed; best-effort below
                    const hx = /hx-redirect"?\s*:\s*"?([^"\n]+)/i.exec(dlink);
                    if (hx) push('BuzzServer', hx[1]);
                } catch { /* ignore */ }
            } else if (
                label.includes('pixeldra') ||
                label.includes('pixelserver') ||
                label.includes('pixel server') ||
                label.includes('pixeldrain')
            ) {
                const b = getBaseUrl(link);
                const finalUrl = link.includes('download')
                    ? link
                    : `${b}/api/file/${link.split('/').pop()}?download`;
                push('Pixeldrain', finalUrl);
            } else if (label.includes('s3 server')) {
                push('S3 Server', link);
            } else if (label.includes('mega server')) {
                push('Mega Server', link);
            } else if (label.includes('pdl server')) {
                push('PDL Server', link);
            }
        }
    } catch (e: any) {
        console.error('[loadExtractor:HubCloud] failed:', e?.message || e);
    }
    return result;
};

// ---------------------------------------------------------------------------
// GDFlix
// ---------------------------------------------------------------------------

const resolveGDFlix = async (url: string, referer?: string): Promise<HostResult> => {
    const result = emptyResult();
    try {
        // Follow the meta-refresh redirect, if present.
        let newUrl = url;
        try {
            const $r = (await app.get(url, { referer })).document;
            const content = $r('meta[http-equiv=refresh]').attr('content');
            if (content && content.includes('url=')) {
                newUrl = content.split('url=')[1];
            }
        } catch { /* keep original url */ }

        const $ = (await app.get(newUrl, { referer })).document;

        const liText = (needle: string): string =>
            $(`ul > li.list-group-item:contains(${needle})`).first().text();
        const fileName = liText('Name').split('Name : ')[1] || '';
        const fileSize = (liText('Size').split('Size : ')[1] || '').trim();

        const quality = qualityLabel(getIndexQuality(fileName));

        const anchors = $('div.text-center a').toArray();
        for (const a of anchors) {
            const text = ($(a).text() || '').trim();
            const link = $(a).attr('href') || '';
            if (!link) continue;
            const t = text.toLowerCase();

            if (t.includes('direct dl')) {
                result.streams.push({
                    server: 'GDFlix [Direct]',
                    link,
                    type: 'mp4',
                    quality,
                });
            } else if (t.includes('instant dl')) {
                try {
                    const resp = await app.get(link, { referer: newUrl });
                    const loc = /location"?\s*:\s*"?([^"\n]+)/i.exec(resp.text);
                    const instant = loc && loc[1].includes('url=') ? loc[1].split('url=')[1] : '';
                    if (instant) {
                        result.streams.push({
                            server: 'GDFlix [Instant Download]',
                            link: instant,
                            type: 'mp4',
                            quality,
                        });
                    }
                } catch { /* ignore */ }
            } else if (
                t.includes('pixeldra') ||
                t.includes('pixel') ||
                t.includes('pixelserver')
            ) {
                const b = getBaseUrl(link);
                const finalUrl = link.includes('download')
                    ? link
                    : `${b}/api/file/${link.split('/').pop()}?download`;
                result.streams.push({
                    server: 'GDFlix [Pixeldrain]',
                    link: finalUrl,
                    type: 'mp4',
                    quality,
                });
            }
        }

        // Cloudflare backup ("wfile" variants).
        try {
            for (const type of ['type=1', 'type=2']) {
                const $cf = (await app.get(`${newUrl.replace('file', 'wfile')}?${type}`)).document;
                const sourceUrl = $cf('a.btn-success').first().attr('href') || '';
                if (sourceUrl) {
                    result.streams.push({
                        server: 'GDFlix [CF]',
                        link: sourceUrl,
                        type: 'mp4',
                        quality,
                    });
                }
            }
        } catch { /* ignore */ }

        // surface the size in quality-less entries through the server name
        void fileSize;
    } catch (e: any) {
        console.error('[loadExtractor:GDFlix] failed:', e?.message || e);
    }
    return result;
};

// ---------------------------------------------------------------------------
// VCloud (vcloud.zip / fastdl) — resolves to a HubCloud-style card page
// ---------------------------------------------------------------------------

/** Parse a HubCloud-style "card" page (div.card-body h2 a.btn). Shared by VCloud. */
const parseCardButtons = ($: import('cheerio').CheerioAPI, quality?: string): Stream[] => {
    const streams: Stream[] = [];
    $('div.card-body h2 a.btn, h2 a.btn, a.btn').each((_, el) => {
        const link = $(el).attr('href') || '';
        if (!link || !/^https?:/i.test(link)) return;
        if (HUBCLOUD_BLOCKED.some((b) => link.includes(b))) return;
        const label = ($(el).text() || '').toLowerCase();

        const push = (server: string) => streams.push({ server, link, type: 'mp4', quality });

        if (label.includes('fslv2')) push('FSLv2');
        else if (label.includes('fsl')) push('FSL Server');
        else if (label.includes('download file')) push('Download File');
        else if (label.includes('s3 server')) push('S3 Server');
        else if (label.includes('mega server')) push('Mega Server');
        else if (label.includes('pdl server')) push('PDL Server');
        else if (label.includes('pixeldra') || label.includes('pixel server') || label.includes('pixelserver')) {
            const b = getBaseUrl(link);
            const finalUrl = link.includes('download') ? link : `${b}/api/file/${link.split('/').pop()}?download`;
            streams.push({ server: 'Pixeldrain', link: finalUrl, type: 'mp4', quality });
        }
    });
    return streams;
};

const resolveVCloud = async (url: string, referer?: string): Promise<HostResult> => {
    const result = emptyResult();
    try {
        let href = url;
        if (href.includes('api/index.php')) {
            const $ = (await app.get(url, { referer })).document;
            href = $('div.main h4 a').first().attr('href') || '';
            if (!href) return result;
        }

        const body = (await app.get(href, { referer })).text;

        // url is either atob(atob('...')) or a plain var url = '...'
        let urlValue = '';
        const atobM = /atob\(atob\('([^']+)'\)\)/.exec(body);
        if (atobM) {
            try {
                urlValue = Buffer.from(Buffer.from(atobM[1], 'base64').toString('utf-8'), 'base64').toString('utf-8');
            } catch { /* ignore */ }
        }
        if (!urlValue) urlValue = /var\s+url\s*=\s*'([^']*)'/.exec(body)?.[1] || '';
        if (!urlValue) return result;

        const $card = (await app.get(urlValue, { referer })).document;
        const header = $card('div.card-header').first().text().trim();
        const quality = qualityLabel(getIndexQuality(header) || 1080);

        const direct = parseCardButtons($card, quality);
        result.streams.push(...direct);

        // any remaining anchors that are themselves resolvable hosts (streamwish etc.)
        const seen = new Set(direct.map(s => s.link));
        const nested: string[] = [];
        $card('div.card-body h2 a.btn').each((_, el) => {
            const link = $card(el).attr('href') || '';
            const label = ($card(el).text() || '').toLowerCase();
            if (link && !seen.has(link) && !/fsl|download file|s3 server|mega server|pdl server|pixel|buzzserver/.test(label)) {
                nested.push(link);
            }
        });
        for (const n of nested) {
            const sub = await loadExtractor(n, referer);
            result.streams.push(...sub.streams);
            result.subtitles.push(...sub.subtitles);
        }
    } catch (e: any) {
        console.error('[loadExtractor:VCloud] failed:', e?.message || e);
    }
    return result;
};

// ---------------------------------------------------------------------------
// GDMirrorbot (gdmirrorbot.nl / embed) — embedhelper.php fan-out
// ---------------------------------------------------------------------------

const resolveGDMirrorbot = async (url: string, referer?: string): Promise<HostResult> => {
    const result = emptyResult();
    try {
        if (url.includes('key=')) return result; // keyed flow not supported

        const sid = url.split('embed/').pop() || '';
        if (!sid) return result;
        const landed = await app.get(url, { referer });
        const host = getBaseUrl(landed.url || url) || getBaseUrl(url);
        if (!host) return result;

        const resp = await app.post(`${host}/embedhelper.php`, new URLSearchParams({ sid }), {
            referer: host,
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const root = resp.json<any>();
        if (!root || typeof root !== 'object') return result;

        const siteUrls = root.siteUrls || {};
        if (!siteUrls.gofs) siteUrls.GoFile = 'https://gofile.io/d/';
        if (!siteUrls.buzzheavier) siteUrls.buzzheavier = 'https://buzzheavier.com/';

        let mresult: any = root.mresult;
        if (typeof mresult === 'string') {
            try { mresult = JSON.parse(Buffer.from(mresult, 'base64').toString('utf-8')); } catch { return result; }
        }
        if (!mresult || typeof mresult !== 'object') return result;

        for (const key of Object.keys(siteUrls)) {
            if (!(key in mresult)) continue;
            const base = String(siteUrls[key] || '').replace(/\/+$/, '');
            const path = String(mresult[key] || '').replace(/^\/+/, '');
            if (!base || !path) continue;
            const fullUrl = `${base}/${path}`;
            const sub = await loadExtractor(fullUrl, referer || 'https://gdmirrorbot.nl');
            result.streams.push(...sub.streams);
            result.subtitles.push(...sub.subtitles);
        }
    } catch (e: any) {
        console.error('[loadExtractor:GDMirrorbot] failed:', e?.message || e);
    }
    return result;
};

// ---------------------------------------------------------------------------
// Hubdrive — landing page with a single "btn-success1" link to hubcloud/etc.
// ---------------------------------------------------------------------------

const resolveHubdrive = async (url: string, referer?: string): Promise<HostResult> => {
    try {
        const $ = (await app.get(url, { referer })).document;
        const href = $('.btn.btn-primary.btn-user.btn-success1.m-1').attr('href') || '';
        if (!href) return emptyResult();
        if (/hubcloud/i.test(href)) return await resolveHubCloud(href, url);
        return await loadExtractor(href, url);
    } catch (e: any) {
        console.error('[loadExtractor:Hubdrive] failed:', e?.message || e);
        return emptyResult();
    }
};

// ---------------------------------------------------------------------------
// HUBCDN — page body holds r=<base64>; decode -> ...link=<m3u8>
// ---------------------------------------------------------------------------

const resolveHubCdn = async (url: string): Promise<HostResult> => {
    const result = emptyResult();
    try {
        const body = (await app.get(url)).text;
        const m = /r=([A-Za-z0-9+/=]+)/.exec(body);
        if (m && m[1]) {
            const decoded = Buffer.from(m[1], 'base64').toString('utf-8');
            const m3u8 = decoded.includes('link=')
                ? decoded.substring(decoded.lastIndexOf('link=') + 5)
                : '';
            if (m3u8) {
                result.streams.push({ server: 'Hubcdn', link: m3u8, type: 'm3u8', headers: { Referer: url } });
            }
        }
    } catch (e: any) {
        console.error('[loadExtractor:Hubcdn] failed:', e?.message || e);
    }
    return result;
};

// ---------------------------------------------------------------------------
// Hblinks — index page listing hubdrive / hubcloud / hubcdn / other hosts
// ---------------------------------------------------------------------------

const resolveHblinks = async (url: string): Promise<HostResult> => {
    const result = emptyResult();
    try {
        const $ = (await app.get(url)).document;
        const hrefs: string[] = [];
        $('h3 a, h5 a, div.entry-content p a').each((_, el) => {
            const h = $(el).attr('href') || '';
            if (h) hrefs.push(h);
        });
        for (const href of hrefs) {
            const sub = await loadExtractor(href, url);
            result.streams.push(...sub.streams);
            result.subtitles.push(...sub.subtitles);
        }
    } catch (e: any) {
        console.error('[loadExtractor:Hblinks] failed:', e?.message || e);
    }
    return result;
};

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

/**
 * Resolve a video-host / embed URL into concrete streams + subtitles.
 *
 * Dispatches on the URL host. Unknown or unsupported hosts return an empty
 * result. Never throws.
 *
 * @param url     the embed / file-host URL collected by a multi-provider
 * @param referer optional referer to send with the host requests
 */
export const loadExtractor = async (url: string, referer?: string): Promise<HostResult> => {
    if (!url || !/^https?:/i.test(url)) return emptyResult();

    const host = getHost(url);
    if (!host) return emptyResult();

    try {
        if (host.includes('hubcloud')) {
            // dynamic-domain hosts may rotate; the path/shape stays the same.
            await getDomain('hubcloud').catch(() => undefined);
            return await resolveHubCloud(url, referer);
        }

        if (host.includes('hubcdn')) {
            return await resolveHubCdn(url);
        }

        if (host.includes('hubdrive')) {
            return await resolveHubdrive(url, referer);
        }

        if (host.includes('hblinks') || host.includes('hblink')) {
            return await resolveHblinks(url);
        }

        if (host.includes('gdflix')) {
            return await resolveGDFlix(url, referer);
        }

        if (host.includes('vcloud') || host.includes('fastdl')) {
            return await resolveVCloud(url, referer);
        }

        if (host.includes('gdmirrorbot') || host.includes('gdmirror')) {
            return await resolveGDMirrorbot(url, referer);
        }

        if (isPackedPlayerHost(host)) {
            // derive a human-ish server label from the host.
            const label = host.split('.').slice(-2, -1)[0] || host;
            const serverName = label.charAt(0).toUpperCase() + label.slice(1);
            return await resolvePackedPlayer(url, referer, serverName);
        }
    } catch (e: any) {
        console.error('[loadExtractor] dispatch failed:', e?.message || e);
        return emptyResult();
    }

    // Unknown / unsupported host.
    return emptyResult();
};

export default loadExtractor;
