import { Router } from 'express';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { proxyWarpAgent } from '../utils/warp';
import { guardUrl, ssrfAgents } from '../utils/ssrf';

/**
 * Fetch an upstream URL for the proxy, retrying through WARP when the direct
 * fetch fails. Some provider CDNs (e.g. AnimeWorld's zephyrflick, its subtitle
 * host) are blocked/poisoned on the direct egress and only reachable via WARP —
 * the providers already egress through WARP, so playback must be able to as well.
 *
 * The direct path uses the SSRF-guarded agents: their DNS lookup rejects any
 * host that resolves to a private/loopback IP, so a redirect to (or a rebinding
 * of) an internal address is refused at connect time — not just at guardUrl.
 * The WARP fallback egresses through Cloudflare, which can't reach the LAN.
 */
async function fetchUpstream(url: string, config: AxiosRequestConfig): Promise<AxiosResponse> {
    try {
        return await axios.get(url, { ...config, ...ssrfAgents() });
    } catch (e) {
        const agent = proxyWarpAgent();
        if (!agent) throw e;
        return await axios.get(url, { ...config, httpAgent: agent, httpsAgent: agent });
    }
}

/** ENOTFOUND/EAI_AGAIN => the upstream host didn't resolve; DoH usually fixes it. */
const proxyErr = (e: any): string => {
    const code = e?.code || '';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return `proxy error: DNS lookup failed (${code}). Set DOH_ENABLED=true in .env to resolve provider hosts over HTTPS.`;
    }
    return `proxy error: ${e?.message || e}`;
};

/**
 * Stream proxy.
 *
 * Provider .m3u8 / .mp4 links are hotlink/CORS-protected and carry per-source
 * Referer/Origin headers a browser can't set, so they won't play directly in a
 * <video>. This proxy fetches them server-side with the right headers and:
 *   - rewrites HLS manifests so every segment/key/variant routes back through
 *     the proxy (carrying the same headers), and
 *   - streams binary segments / mp4 through with Range support for seeking.
 *
 *   GET /api/proxy?url=<b64>&h=<b64-json-headers>&m3u8=1
 *   GET /api/proxy/sub?url=<b64>           (subtitles, srt->vtt)
 */

const router = Router();

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf-8');

const decodeHeaders = (h?: string): Record<string, string> => {
    if (!h) return {};
    try { return JSON.parse(unb64(h)); } catch { return {}; }
};

/** Build a /api/proxy URL for a child resource, preserving headers. */
const proxify = (absUrl: string, hB64: string, isPlaylist: boolean): string => {
    const params = new URLSearchParams({ url: b64(absUrl) });
    if (hB64) params.set('h', hB64);
    if (isPlaylist) params.set('m3u8', '1');
    return `/api/proxy?${params.toString()}`;
};

/**
 * Rewrite an HLS manifest so all referenced URIs flow back through the proxy.
 * When `forceAudio` is set, the matching EXT-X-MEDIA audio rendition is made the
 * DEFAULT (and the others un-defaulted) so players that pick the default audio
 * play the requested track — this is how we deliver dub/sub per source.
 */
const rewriteManifest = (body: string, baseUrl: string, hB64: string, forceAudio?: string): string => {
    const isMaster = body.includes('#EXT-X-STREAM-INF');
    const resolve = (u: string) => { try { return new URL(u, baseUrl).toString(); } catch { return u; } };

    const audioMatches = (line: string): boolean => {
        const name = (/NAME="([^"]+)"/.exec(line) || [])[1] || '';
        const lang = (/LANGUAGE="([^"]+)"/.exec(line) || [])[1] || '';
        return name.toLowerCase() === (forceAudio || '').toLowerCase() || lang.toLowerCase() === (forceAudio || '').toLowerCase();
    };
    // Only re-default audio if the requested track actually exists — otherwise we'd
    // strip DEFAULT=YES from every rendition and leave the group with no default.
    if (forceAudio) {
        const anyMatch = body.split('\n').some((l) => /#EXT-X-MEDIA:/i.test(l) && /TYPE=AUDIO/i.test(l) && audioMatches(l));
        if (!anyMatch) forceAudio = undefined;
    }

    const setDefault = (line: string, on: boolean): string => {
        let out = line;
        out = /DEFAULT=(YES|NO)/.test(out) ? out.replace(/DEFAULT=(YES|NO)/, `DEFAULT=${on ? 'YES' : 'NO'}`) : out.replace('#EXT-X-MEDIA:', `#EXT-X-MEDIA:DEFAULT=${on ? 'YES' : 'NO'},`);
        // Force AUTOSELECT to match DEFAULT so players don't auto-pick an un-defaulted track.
        out = /AUTOSELECT=(YES|NO)/.test(out) ? out.replace(/AUTOSELECT=(YES|NO)/, `AUTOSELECT=${on ? 'YES' : 'NO'}`) : out.replace('#EXT-X-MEDIA:', `#EXT-X-MEDIA:AUTOSELECT=${on ? 'YES' : 'NO'},`);
        return out;
    };
    // Set DEFAULT=YES on only the FIRST matching rendition and NO on all others —
    // otherwise two tracks sharing a LANGUAGE (or the same NAME) would both become
    // default, which is invalid HLS and leaves audio selection undefined.
    let forcedOne = false;
    const applyForceAudio = (line: string): string => {
        if (!forceAudio || !/#EXT-X-MEDIA:/i.test(line) || !/TYPE=AUDIO/i.test(line)) return line;
        const match = audioMatches(line) && !forcedOne;
        if (match) forcedOne = true;
        return setDefault(line, match);
    };

    // URI="..." attributes (keys, media renditions, maps)
    const rewriteAttrUris = (line: string): string =>
        line.replace(/URI="([^"]+)"/g, (_m, uri) => {
            const abs = resolve(uri);
            // audio/subtitle renditions point at playlists; keys & maps are binary
            const playlist = /#EXT-X-MEDIA/i.test(line);
            return `URI="${proxify(abs, hB64, playlist)}"`;
        });

    return body
        .split('\n')
        .map((line) => {
            const trimmed = line.trim();
            if (!trimmed) return line;
            if (trimmed.startsWith('#')) {
                const rewritten = /URI="/.test(trimmed) ? rewriteAttrUris(line) : line;
                return applyForceAudio(rewritten);
            }
            // a bare URI line: variant playlist (master) or segment (media)
            return proxify(resolve(trimmed), hB64, isMaster);
        })
        .join('\n');
};

router.get('/', async (req, res) => {
    const rawUrl = req.query.url as string;
    if (!rawUrl) return res.status(400).send('missing url');

    let url: string;
    try { url = unb64(rawUrl); } catch { return res.status(400).send('bad url'); }
    const blocked = guardUrl(url);
    if (blocked) return res.status(403).send(blocked);

    const headers: Record<string, string> = {
        'User-Agent': DEFAULT_UA,
        ...decodeHeaders(req.query.h as string),
    };
    if (req.headers.range) headers['Range'] = req.headers.range as string;

    const isM3u8 = req.query.m3u8 === '1' || /\.m3u8(\?|$)/i.test(url);

    try {
        if (isM3u8) {
            const upstream = await fetchUpstream(url, { headers, responseType: 'text', timeout: 20000, transformResponse: r => r });
            const rewritten = rewriteManifest(String(upstream.data), url, (req.query.h as string) || '', req.query.audio as string | undefined);
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Cache-Control', 'no-store');
            return res.send(rewritten);
        }

        // binary passthrough (segments, keys, mp4) with Range support
        const upstream = await fetchUpstream(url, { headers, responseType: 'stream', timeout: 30000, validateStatus: () => true });
        res.status(upstream.status);
        res.set('Access-Control-Allow-Origin', '*');
        for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
            const v = upstream.headers[k];
            if (v) res.set(k, v as string);
        }
        if (!upstream.headers['accept-ranges']) res.set('Accept-Ranges', 'bytes');
        // Destroy the upstream socket if the client disconnects mid-stream, so an
        // abandoned seek/tab doesn't leak an open connection to the provider CDN.
        req.on('close', () => { try { upstream.data.destroy(); } catch { /* */ } });
        upstream.data.on('error', () => { try { res.destroy(); } catch { /* */ } });
        upstream.data.pipe(res);
    } catch (e: any) {
        res.status(502).send(proxyErr(e));
    }
});

/** Convert SubStation Alpha (.ass/.ssa) to WebVTT. Browsers' <track> only speaks VTT. */
const assToVtt = (ass: string): string => {
    const toTime = (t: string): string => {
        const m = /(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/.exec(t.trim());
        if (!m) return '00:00:00.000';
        const cs = m[4].padEnd(3, '0').slice(0, 3);           // centiseconds -> ms
        return `${m[1].padStart(2, '0')}:${m[2]}:${m[3]}.${cs}`;
    };
    const clean = (s: string): string => s
        .replace(/\{[^}]*\}/g, '')            // {\pos..}, {\i1} override tags
        .replace(/\\N/gi, '\n').replace(/\\h/gi, ' ')
        .trim();
    let fmt: string[] = [];
    let inEvents = false;
    const cues: string[] = [];
    for (const line of ass.split(/\r?\n/)) {
        if (/^\[Events\]/i.test(line)) { inEvents = true; continue; }
        if (/^\[/.test(line)) { inEvents = false; continue; }
        if (!inEvents) continue;
        if (/^Format:/i.test(line)) { fmt = line.slice(7).split(',').map((s) => s.trim().toLowerCase()); continue; }
        if (/^Dialogue:/i.test(line)) {
            const si = fmt.indexOf('start'), ei = fmt.indexOf('end'), ti = fmt.indexOf('text');
            if (ti < 0 || si < 0 || ei < 0) continue;   // malformed Format line — skip, don't crash
            const parts = line.slice(9).split(',');
            const text = clean(parts.slice(ti).join(','));
            if (text) cues.push(`${toTime(parts[si])} --> ${toTime(parts[ei])}\n${text}`);
        }
    }
    return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
};

/** Subtitle proxy + srt/ass -> vtt conversion. */
router.get('/sub', async (req, res) => {
    const rawUrl = req.query.url as string;
    if (!rawUrl) return res.status(400).send('missing url');
    let url: string;
    try { url = unb64(rawUrl); } catch { return res.status(400).send('bad url'); }
    const blocked = guardUrl(url);
    if (blocked) return res.status(403).send(blocked);

    try {
        let origin = '';
        try { origin = new URL(url).origin; } catch { /* */ }
        const upstream = await fetchUpstream(url, {
            // Referer = the sub's own origin avoids most CDN hotlink 403s.
            headers: { 'User-Agent': DEFAULT_UA, ...(origin ? { Referer: origin + '/' } : {}), ...decodeHeaders(req.query.h as string) },
            responseType: 'text', timeout: 15000, transformResponse: r => r,
        });
        let body = String(upstream.data);

        const looksAss = /\[Script Info\]|\[V4\+? Styles\]/i.test(body) || /^Dialogue:/im.test(body) || /\.(ass|ssa)(\?|$)/i.test(url);
        const looksSrt = !body.trimStart().startsWith('WEBVTT') && /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(body);
        if (looksAss) {
            body = assToVtt(body);
        } else if (looksSrt) {
            body = 'WEBVTT\n\n' + body
                .replace(/\r+/g, '')
                .replace(/^\d+\s*$/gm, '')                                   // drop cue numbers
                .replace(/\{\\[^}]*\}/g, '')                                 // strip {\an8} style override tags
                .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');           // comma -> dot
        }
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.send(body);
    } catch (e: any) {
        res.status(502).send(`sub ${proxyErr(e)}`);
    }
});

export default router;
export { b64 };
