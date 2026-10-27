import { Router, Request, Response } from 'express';
import { pipeline } from 'stream';
import fs from 'fs';
import { addTorrent, pickVideoFile, remuxToMp4, remuxReadableToMp4, hasFfmpeg, touch, torrentStats, getStatus, probeMedia, AudioTrackInfo, MediaInfo, hlsReady, hlsSegmentFile, HLS_SEG, loopbackUrl } from '../utils/torrent';
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

/** `audio=<n>` (audio-relative track index) for a remux; out of range falls back to the first. */
const audioIdx = (req: Request) => Math.min(31, Math.max(0, parseInt(String(req.query.audio ?? '0'), 10) || 0));

// Video codec + audio tracks + duration per file URL (ffprobe over the loopback passthrough, so
// every byte still comes through the SSRF guard), cached 30 min.
const NO_INFO: MediaInfo = { video: '', audio: [] };
const trackCache = new Map<string, { at: number; p: Promise<MediaInfo> }>();
function mediaOf(url: string): Promise<MediaInfo> {
    const hit = trackCache.get(url);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.p;
    const p = probeMedia(loopbackUrl(url)).catch(() => NO_INFO);
    if (trackCache.size > 500) trackCache.delete(trackCache.keys().next().value!);
    trackCache.set(url, { at: Date.now(), p });
    return p;
}
const langNames = new Intl.DisplayNames(['en'], { type: 'language' });
const trackLang = (t: AudioTrackInfo) => { try { return t.lang && t.lang !== 'und' ? langNames.of(t.lang) || t.lang : ''; } catch { return t.lang; } };
/** First track matching the preference list (language names or codes, e.g. "Hindi,English"). */
const preferredTrack = (tracks: AudioTrackInfo[], prefs: string[]) => {
    for (const p of prefs.map((x) => x.trim().toLowerCase()).filter(Boolean)) {
        const t = tracks.find((t) => [trackLang(t), t.lang, t.title].some((v) => v && v.toLowerCase().includes(p)));
        if (t) return t.index;
    }
    return 0;
};

/** GET /api/torrent/tracks?url=<b64> → [{ index, lang, label, channels }] for a remuxed file. */
router.get('/tracks', async (req, res) => {
    let url: string;
    try { url = unb64(String(req.query.url || '')); } catch { return res.status(400).json({ error: 'bad url' }); }
    const blocked = guardUrl(url);
    if (blocked) return res.status(403).json({ error: blocked });
    if (!(await hasFfmpeg())) return res.json({ tracks: [] });
    const tracks = (await mediaOf(url)).audio;
    res.json({ chosen: req.query.alang ? preferredTrack(tracks, String(req.query.alang).split(',')) : 0, tracks: tracks.map((t) => ({ index: t.index, lang: t.lang, label: trackLabel(t), channels: t.channels })) });
});

const trackLabel = (t: AudioTrackInfo) => [trackLang(t) || `Track ${t.index + 1}`, t.title && !trackLang(t).includes(t.title) ? t.title : ''].filter(Boolean).join(' · ');

/**
 * Seekable HLS for files the browser can't decode (MKV / HEVC / DTS…), converted on the GPU in
 * 10 s segments. Unlike the one-shot remux the player knows the full length and can seek (a far
 * seek restarts the conversion right there — see hlsSegmentFile). Audio tracks are separate
 * renditions, so the player's audio menu switches them like any HLS stream.
 *   GET /api/torrent/hls.m3u8?url=<b64>&alang=Hindi,English   master playlist
 *   GET /api/torrent/hls-media.m3u8?url=&k=v|<audio>          media playlist
 *   GET /api/torrent/hls-seg.ts?url=&k=&i=<n>                 one segment
 */
const SEG = HLS_SEG;
const hlsUrl = (req: Request): string | null => {
    try { const u = unb64(String(req.query.url || '')); return guardUrl(u) ? null : u; } catch { return null; }
};
const sendM3u8 = (res: Response, lines: string[]) => res.set('Content-Type', 'application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(lines.join('\n') + '\n');
const hlsInfo = async (req: Request, res: Response) => {
    const url = hlsUrl(req);
    if (!url) { res.status(403).send('blocked'); return null; }
    if (!(await hasFfmpeg()) || !hlsReady()) { res.status(501).send('no GPU encoder'); return null; }
    const info = await mediaOf(url);
    if (!info.duration || !info.video) { res.status(502).send('could not read the file'); return null; }
    return { url, info, q: `url=${encodeURIComponent(String(req.query.url))}` };
};
router.get('/hls.m3u8', async (req, res) => {
    const h = await hlsInfo(req, res); if (!h) return;
    const def = req.query.alang ? preferredTrack(h.info.audio, String(req.query.alang).split(',')) : 0;
    const audio = h.info.audio.map((t) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="${trackLabel(t).replace(/"/g, "'")}",LANGUAGE="${t.lang || 'und'}",DEFAULT=${t.index === def ? 'YES' : 'NO'},AUTOSELECT=YES,URI="hls-media.m3u8?${h.q}&k=${t.index}"`);
    sendM3u8(res, ['#EXTM3U', '#EXT-X-VERSION:3', ...audio,
        `#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,CODECS="avc1.640028${audio.length ? ',mp4a.40.2",AUDIO="a"' : '"'}`, `hls-media.m3u8?${h.q}&k=v`]);
});
router.get('/hls-media.m3u8', async (req, res) => {
    const h = await hlsInfo(req, res); if (!h) return;
    const k = req.query.k === 'v' ? 'v' : String(Math.max(0, parseInt(String(req.query.k), 10) || 0));
    const n = Math.ceil(h.info.duration! / SEG);
    const segs = Array.from({ length: n }, (_, i) => [`#EXTINF:${Math.min(SEG, h.info.duration! - i * SEG).toFixed(3)},`, `hls-seg.ts?${h.q}&k=${k}&i=${i}`]).flat();
    sendM3u8(res, ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${SEG}`, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', ...segs, '#EXT-X-ENDLIST']);
});
router.get('/hls-seg.ts', async (req, res) => {
    const h = await hlsInfo(req, res); if (!h) return;
    const i = parseInt(String(req.query.i), 10);
    const start = i * SEG;
    if (!(i >= 0) || start >= h.info.duration!) return res.status(404).send('no such segment');
    const k = req.query.k === 'v' ? 'v' : Math.min(h.info.audio.length - 1, Math.max(0, parseInt(String(req.query.k), 10) || 0));
    const file = await hlsSegmentFile(h.url, i, k, h.info.audio.length);
    if (gone(req)) return;
    if (!file) return res.status(502).send('conversion failed');
    res.set('Content-Type', 'video/mp2t').set('Cache-Control', 'no-store');
    pipeline(fs.createReadStream(file), res, () => { /* client gone / file pruned */ });
});

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
    if (wantRemux) {
        const { video } = await probeMedia(file.createReadStream({ start: 0, end: 4194303 }));
        if (gone(req)) return;
        return sendRemux(remuxToMp4(file, audioIdx(req), video), res);
    }

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

    // mp4/webm pass through (seekable) unless ffprobe finds a codec browsers can't decode
    // (HEVC video, AC3/EAC3/DTS audio) or more than one audio track (only the remux can pick one)
    const isMp4Like = /\.(mp4|webm|m4v)(\?|$)/i.test(url);
    const playsAsIs = async () => {
        const { video, audio } = await mediaOf(url);
        return ['h264', 'vp9', 'av1', ''].includes(video) && audio.length < 2 && audio.every((a) => ['aac', 'mp3', 'opus', 'vorbis', ''].includes(a.codec || ''));
    };
    const wantRemux = req.query.remux === '1' && (await hasFfmpeg()) && (!isMp4Like || !(await playsAsIs()));
    if (gone(req)) return;

    // Non-mp4 (mkv/…) → remux to fragmented MP4 (no seek on a live remux, but plays inline).
    // SECURITY: fetch through the SSRF-guarded agents + per-hop redirect guard and pipe
    // the stream into ffmpeg's stdin. Handing the URL to `ffmpeg -i <url>` instead would
    // let ffmpeg's own DNS/redirects reach internal targets (DNS-rebinding), bypassing the
    // guard the passthrough branch below relies on.
    if (wantRemux) {
        try {
            // no explicit track: start in the viewer's language (alang=Hindi,English) when the file has several
            const info = await mediaOf(url);   // codec decides copy vs GPU transcode
            const audio = req.query.audio != null ? audioIdx(req) : req.query.alang ? preferredTrack(info.audio, String(req.query.alang).split(',')) : 0;
            if (gone(req)) return;
            const upstream = await guardedGet(url, { responseType: 'stream', timeout: 30000, maxRedirects: 5, validateStatus: () => true });
            if (gone(req) || upstream.status >= 400) { upstream.data.destroy?.(); return gone(req) ? undefined : res.status(502).send('debrid fetch failed: ' + upstream.status); }
            sendRemux(remuxReadableToMp4(upstream.data, audio, info.video), res);
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
