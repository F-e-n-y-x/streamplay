import { Router } from 'express';
import axios from 'axios';
import { addTorrent, pickVideoFile, remuxToMp4, remuxReadableToMp4, hasFfmpeg, touch, torrentStats, getStatus } from '../utils/torrent';
import { guardUrl, ssrfAgents, guardRedirect } from '../utils/ssrf';

/**
 * Torrent streaming endpoints.
 *   GET /api/torrent/stream?magnet=<b64>&file=<idx>&remux=1
 *       - remux=1 (+ ffmpeg present): pipe a browser-playable fragmented MP4.
 *       - otherwise: serve the raw file with HTTP Range support (seekable; VLC/mp4).
 *   GET /api/torrent/info?magnet=<b64>   -> file list (diagnostics)
 *   GET /api/torrent/stats               -> active torrents
 */
const router = Router();
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf-8');

const mimeOf = (name: string): string =>
    /\.webm$/i.test(name) ? 'video/webm' : /\.mkv$/i.test(name) ? 'video/x-matroska' : /\.avi$/i.test(name) ? 'video/x-msvideo' : 'video/mp4';

router.get('/stream', async (req, res) => {
    const raw = req.query.magnet as string;
    if (!raw) return res.status(400).send('missing magnet');
    let magnet: string;
    try { magnet = unb64(raw); } catch { return res.status(400).send('bad magnet'); }
    const fileIdx = req.query.file != null ? parseInt(req.query.file as string) : undefined;
    const wantEp = req.query.ep != null ? parseInt(req.query.ep as string) : undefined;

    let torrent: any;
    try { torrent = await addTorrent(magnet); } catch (e: any) { console.error('[torrent] stream failed:', e?.message || e); return res.status(504).send('torrent: ' + (e?.message || e)); }
    const file = pickVideoFile(torrent, fileIdx, wantEp);
    if (!file) return res.status(404).send('no video file in torrent');
    touch(magnet);
    res.set('Access-Control-Allow-Origin', '*');

    // Browser path: remux mkv/HEVC -> fragmented MP4 (no seeking on a live remux, but
    // it plays inline). Falls back to raw if ffmpeg is missing.
    const wantRemux = req.query.remux === '1' && !/\.(mp4|webm)$/i.test(file.name) && (await hasFfmpeg());
    if (wantRemux) {
        res.status(200);
        res.set('Content-Type', 'video/mp4');
        res.set('Cache-Control', 'no-store');
        const ff = remuxToMp4(file);
        ff.stdout.pipe(res);
        const kill = () => { try { ff.kill('SIGKILL'); } catch { /* */ } };
        req.on('close', kill);
        ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
        return;
    }

    // Raw path: full Range support (seekable; great for VLC and mp4 in-browser).
    const total = file.length;
    const range = req.headers.range as string | undefined;
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', mimeOf(file.name));
    if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = m ? parseInt(m[1]) : 0;
        const end = m && m[2] ? Math.min(parseInt(m[2]), total - 1) : total - 1;
        if (start >= total || start > end) return res.status(416).set('Content-Range', 'bytes */' + total).end();
        res.status(206);
        res.set('Content-Range', 'bytes ' + start + '-' + end + '/' + total);
        res.set('Content-Length', String(end - start + 1));
        const stream = file.createReadStream({ start, end });
        stream.on('error', () => { try { res.destroy(); } catch { /* */ } });
        req.on('close', () => { try { stream.destroy(); } catch { /* */ } });
        stream.pipe(res);
    } else {
        res.status(200);
        res.set('Content-Length', String(total));
        const stream = file.createReadStream();
        stream.on('error', () => { try { res.destroy(); } catch { /* */ } });
        req.on('close', () => { try { stream.destroy(); } catch { /* */ } });
        stream.pipe(res);
    }
});

/**
 * Stream a debrid-cached DIRECT http file (from Torrentio + a debrid key). Far more
 * reliable than P2P: the file is already on the debrid CDN. mp4/webm passes through
 * with Range support (seekable); mkv is remuxed to fragmented MP4 so the browser can
 * play it. SSRF-guarded like the proxy (the url is caller-supplied).
 *   GET /api/torrent/http?url=<b64>&remux=1
 */
router.get('/http', async (req, res) => {
    const raw = req.query.url as string;
    if (!raw) return res.status(400).send('missing url');
    let url: string;
    try { url = unb64(raw); } catch { return res.status(400).send('bad url'); }
    const blocked = guardUrl(url);
    if (blocked) return res.status(403).send(blocked);
    res.set('Access-Control-Allow-Origin', '*');

    const isMp4Like = /\.(mp4|webm|m4v)(\?|$)/i.test(url);
    const wantRemux = req.query.remux === '1' && !isMp4Like && (await hasFfmpeg());

    // Non-mp4 (mkv/…) → remux to fragmented MP4 (no seek on a live remux, but plays inline).
    // SECURITY: fetch through the SSRF-guarded agents + per-hop redirect guard and pipe
    // the stream into ffmpeg's stdin. Handing the URL to `ffmpeg -i <url>` instead would
    // let ffmpeg's own DNS/redirects reach internal targets (DNS-rebinding), bypassing the
    // guard the passthrough branch below relies on.
    if (wantRemux) {
        try {
            const upstream = await axios.get(url, { responseType: 'stream', timeout: 30000, maxRedirects: 5, validateStatus: () => true, beforeRedirect: guardRedirect, ...ssrfAgents() });
            if (upstream.status >= 400) { upstream.data.destroy?.(); return res.status(502).send('debrid fetch failed: ' + upstream.status); }
            res.status(200).set('Content-Type', 'video/mp4').set('Cache-Control', 'no-store');
            const ff = remuxReadableToMp4(upstream.data);
            ff.stdout.pipe(res);
            const kill = () => { try { ff.kill('SIGKILL'); } catch { /* */ } };
            req.on('close', kill);
            ff.on('error', () => { if (!res.headersSent) res.status(502).end(); });
        } catch (e: any) {
            if (!res.headersSent) res.status(502).send('debrid fetch failed: ' + (e?.message || e));
        }
        return;
    }

    // mp4/webm (or ffmpeg missing) → passthrough with Range so seeking works.
    try {
        const headers: Record<string, string> = {};
        if (req.headers.range) headers['Range'] = req.headers.range as string;
        const upstream = await axios.get(url, { headers, responseType: 'stream', timeout: 30000, validateStatus: () => true, maxRedirects: 5, ...ssrfAgents() });
        res.status(upstream.status);
        for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
            const v = upstream.headers[k]; if (v) res.set(k, v as string);
        }
        if (!upstream.headers['accept-ranges']) res.set('Accept-Ranges', 'bytes');
        req.on('close', () => { try { upstream.data.destroy(); } catch { /* */ } });
        upstream.data.on('error', () => { try { res.destroy(); } catch { /* */ } });
        upstream.data.pipe(res);
    } catch (e: any) {
        if (!res.headersSent) res.status(502).send('debrid fetch failed: ' + (e?.message || e));
    }
});

router.get('/info', async (req, res) => {
    const raw = req.query.magnet as string;
    if (!raw) return res.status(400).json({ error: 'missing magnet' });
    let magnet: string;
    try { magnet = unb64(raw); } catch { return res.status(400).json({ error: 'bad magnet' }); }
    try {
        const torrent = await addTorrent(magnet);
        res.json({ name: torrent.name, files: (torrent.files || []).map((f: any, i: number) => ({ i, name: f.name, size: f.length })), peers: torrent.numPeers });
    } catch (e: any) { res.status(504).json({ error: String(e?.message || e) }); }
});

router.get('/stats', async (_req, res) => res.json({ ...torrentStats(), ffmpeg: await hasFfmpeg() }));

// Live per-torrent stats for the player overlay (seeders, speed, progress, ETA).
// Returns {active:false} if the magnet hasn't been added yet (nothing streaming).
router.get('/status', (req, res) => {
    const raw = req.query.magnet as string;
    if (!raw) return res.status(400).json({ error: 'missing magnet' });
    let magnet: string;
    try { magnet = unb64(raw); } catch { return res.status(400).json({ error: 'bad magnet' }); }
    res.set('Cache-Control', 'no-store');
    res.json(getStatus(magnet) || { active: false });
});

export default router;
