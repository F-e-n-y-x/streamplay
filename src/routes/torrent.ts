import { Router, Request, Response } from 'express';
import { pipeline } from 'stream';
import { addTorrent, pickVideoFile, remuxToMp4, remuxReadableToMp4, hasFfmpeg, touch, torrentStats, getStatus } from '../utils/torrent';
import { guardUrl, guardedGet, pipeUpstream, setPassthroughSecurity } from '../utils/ssrf';
import { unb64 } from './proxy';

/**
 * Torrent streaming endpoints.
 *   GET /api/torrent/stream?magnet=<b64>&file=<idx>&remux=1
 *       - remux=1 (+ ffmpeg present): pipe a browser-playable fragmented MP4.
 *       - otherwise: serve the raw file with HTTP Range support (seekable; VLC/mp4).
 *   GET /api/torrent/info?magnet=<b64>   -> file list (diagnostics)
 *   GET /api/torrent/stats               -> active torrents
 */
const router = Router();
router.use((_req, res, next) => { setPassthroughSecurity(res); next(); });

/** Pipe a remux's ffmpeg stdout to the client; SIGKILL ffmpeg the moment the client goes. */
const sendRemux = (ff: any, res: Response): void => {
    res.status(200).set('Content-Type', 'video/mp4').set('Cache-Control', 'no-store');
    const kill = () => { try { ff.kill('SIGKILL'); } catch { /* */ } };
    res.on('close', kill);
    ff.on('error', () => { if (!res.headersSent) res.status(500); res.destroy(); });
    pipeline(ff.stdout, res, kill);
};

/** Parse a single `bytes=` range (incl. suffix `bytes=-N`) against `total`.
 *  null = no/unsupported range (serve 200), 'bad' = unsatisfiable (416). */
export const parseRange = (range: string | undefined, total: number): { start: number; end: number } | null | 'bad' => {
    const m = /^bytes=(\d*)-(\d*)$/.exec((range || '').trim());
    if (!m || (!m[1] && !m[2])) return null;
    const start = m[1] ? parseInt(m[1]) : Math.max(0, total - parseInt(m[2]));
    const end = m[1] && m[2] ? Math.min(parseInt(m[2]), total - 1) : total - 1;
    return start >= total || start > end ? 'bad' : { start, end };
};

const gone = (req: Request) => req.destroyed;

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
    if (gone(req)) return;
    const file = pickVideoFile(torrent, fileIdx, wantEp);
    if (!file) return res.status(404).send('no video file in torrent');
    touch(magnet);

    // Browser path: remux mkv/HEVC -> fragmented MP4 (no seeking on a live remux, but
    // it plays inline). Falls back to raw if ffmpeg is missing.
    const wantRemux = req.query.remux === '1' && !/\.(mp4|webm)$/i.test(file.name) && (await hasFfmpeg());
    if (gone(req)) return;
    if (wantRemux) return sendRemux(remuxToMp4(file), res);

    // Raw path: full Range support (seekable; great for VLC and mp4 in-browser).
    const total = file.length;
    const r = parseRange(req.headers.range, total);
    res.set('Accept-Ranges', 'bytes');
    res.set('Content-Type', mimeOf(file.name));
    if (r === 'bad') return res.status(416).set('Content-Range', 'bytes */' + total).end();
    if (r) res.status(206).set('Content-Range', `bytes ${r.start}-${r.end}/${total}`);
    else res.status(200);
    res.set('Content-Length', String(r ? r.end - r.start + 1 : total));
    pipeline(file.createReadStream(r || undefined), res, () => { /* client gone / read error */ });
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

    const isMp4Like = /\.(mp4|webm|m4v)(\?|$)/i.test(url);
    const wantRemux = req.query.remux === '1' && !isMp4Like && (await hasFfmpeg());
    if (gone(req)) return;

    // Non-mp4 (mkv/…) → remux to fragmented MP4 (no seek on a live remux, but plays inline).
    // SECURITY: fetch through the SSRF-guarded agents + per-hop redirect guard and pipe
    // the stream into ffmpeg's stdin. Handing the URL to `ffmpeg -i <url>` instead would
    // let ffmpeg's own DNS/redirects reach internal targets (DNS-rebinding), bypassing the
    // guard the passthrough branch below relies on.
    if (wantRemux) {
        try {
            const upstream = await guardedGet(url, { responseType: 'stream', timeout: 30000, maxRedirects: 5, validateStatus: () => true });
            if (gone(req) || upstream.status >= 400) { upstream.data.destroy?.(); return gone(req) ? undefined : res.status(502).send('debrid fetch failed: ' + upstream.status); }
            sendRemux(remuxReadableToMp4(upstream.data), res);
        } catch (e: any) {
            if (!res.headersSent) res.status(502).send('debrid fetch failed: ' + (e?.message || e));
        }
        return;
    }

    // mp4/webm (or ffmpeg missing) → passthrough with Range so seeking works.
    try {
        const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
        if (req.headers.range) headers['Range'] = req.headers.range as string;
        const upstream = await guardedGet(url, { headers, responseType: 'stream', decompress: false, timeout: 30000, validateStatus: () => true, maxRedirects: 5 });
        pipeUpstream(upstream, req, res);
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
