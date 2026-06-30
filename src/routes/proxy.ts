import { Router } from 'express';
import axios from 'axios';

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

/** Rewrite an HLS manifest so all referenced URIs flow back through the proxy. */
const rewriteManifest = (body: string, baseUrl: string, hB64: string): string => {
    const isMaster = body.includes('#EXT-X-STREAM-INF');
    const resolve = (u: string) => { try { return new URL(u, baseUrl).toString(); } catch { return u; } };

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
                return /URI="/.test(trimmed) ? rewriteAttrUris(line) : line;
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

    const headers: Record<string, string> = {
        'User-Agent': DEFAULT_UA,
        ...decodeHeaders(req.query.h as string),
    };
    if (req.headers.range) headers['Range'] = req.headers.range as string;

    const isM3u8 = req.query.m3u8 === '1' || /\.m3u8(\?|$)/i.test(url);

    try {
        if (isM3u8) {
            const upstream = await axios.get(url, { headers, responseType: 'text', timeout: 20000, transformResponse: r => r });
            const rewritten = rewriteManifest(String(upstream.data), url, (req.query.h as string) || '');
            res.set('Access-Control-Allow-Origin', '*');
            res.set('Content-Type', 'application/vnd.apple.mpegurl');
            res.set('Cache-Control', 'no-store');
            return res.send(rewritten);
        }

        // binary passthrough (segments, keys, mp4) with Range support
        const upstream = await axios.get(url, { headers, responseType: 'stream', timeout: 30000, validateStatus: () => true });
        res.status(upstream.status);
        res.set('Access-Control-Allow-Origin', '*');
        for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
            const v = upstream.headers[k];
            if (v) res.set(k, v as string);
        }
        if (!upstream.headers['accept-ranges']) res.set('Accept-Ranges', 'bytes');
        upstream.data.pipe(res);
    } catch (e: any) {
        res.status(502).send(`proxy error: ${e?.message || e}`);
    }
});

/** Subtitle proxy + srt->vtt conversion. */
router.get('/sub', async (req, res) => {
    const rawUrl = req.query.url as string;
    if (!rawUrl) return res.status(400).send('missing url');
    let url: string;
    try { url = unb64(rawUrl); } catch { return res.status(400).send('bad url'); }

    try {
        const upstream = await axios.get(url, {
            headers: { 'User-Agent': DEFAULT_UA, ...decodeHeaders(req.query.h as string) },
            responseType: 'text', timeout: 15000, transformResponse: r => r,
        });
        let body = String(upstream.data);

        // Convert SubRip to WebVTT if needed (browsers' <track> needs VTT).
        const looksSrt = !body.trimStart().startsWith('WEBVTT') && /\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(body);
        if (looksSrt) {
            body = 'WEBVTT\n\n' + body
                .replace(/\r+/g, '')
                .replace(/^\d+\s*$/gm, '')                                   // drop cue numbers
                .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');           // comma -> dot
        }
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.send(body);
    } catch (e: any) {
        res.status(502).send(`sub proxy error: ${e?.message || e}`);
    }
});

export default router;
export { b64 };
