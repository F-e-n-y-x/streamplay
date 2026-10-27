import os from 'os';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';

/**
 * WebTorrent streaming manager.
 *
 * Torrents are the most durable anime source — Nyaa/AnimeTosho never rot, cover
 * sub AND dub in 1080p, and index by absolute episode (so they sidestep the
 * aired-vs-production season mess). This holds ONE shared WebTorrent client, adds
 * magnets on demand, streams the video file with HTTP range support, and idle-evicts
 * torrents to bound disk/memory.
 *
 * Most anime torrents are .mkv, which browsers can't play natively — so we optionally
 * remux to fragmented MP4 on the fly with ffmpeg (copy the h264/aac streams when
 * possible; the raw file is always available for VLC).
 *
 * NOTE: torrents seed while active, exposing the egress IP to peers — run behind WARP
 * (which this project already supports). Disk lives under TORRENT_DIR (tmp by default).
 */

const DOWNLOAD_DIR = process.env.TORRENT_DIR || path.join(os.tmpdir(), 'streamplay-torrents');
const IDLE_MS = Number(process.env.TORRENT_IDLE_MS) || 20 * 60 * 1000;   // evict a torrent unused for 20m
const ADD_TIMEOUT_MS = Number(process.env.TORRENT_ADD_TIMEOUT_MS) || 90000;  // TCP-only peer discovery can be slow
const MAX_ACTIVE = Number(process.env.TORRENT_MAX_ACTIVE) || 5;               // cap on concurrent torrents (disk/bandwidth)

try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch { /* */ }

let clientPromise: Promise<any> | null = null;
async function getClient(): Promise<any> {
    if (!clientPromise) {
        clientPromise = (async () => {
            try {
                // webtorrent is ESM-only; load it dynamically (works under tsx/CommonJS).
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore — no bundled types; treated as any
                const mod: any = await import('webtorrent');
                const WebTorrent = mod.default || mod;
                // maxConns 200 (vs default 55): more simultaneous peers = faster metadata
                // and fewer playback stalls on a thin swarm. DHT + uTP stay on (defaults)
                // for peer discovery beyond the trackers baked into each magnet.
                const c = new WebTorrent({ maxConns: 200 });
                // The client is an EventEmitter; a client-level 'error' (DHT/UDP bind
                // failure, fatal tracker error, …) with no listener is an unhandled
                // 'error' event that throws and crashes the whole server. Swallow it —
                // per-torrent errors are still handled where each torrent is added.
                c.on('error', (e: any) => console.error('[torrent] client error:', e?.message || e));
                console.log('[torrent] WebTorrent client ready (maxConns=200)');
                return c;
            } catch (e: any) {
                console.error('[torrent] FAILED to load webtorrent — is it installed?', e?.message || e);
                clientPromise = null;   // allow a retry next request
                throw e;
            }
        })();
    }
    return clientPromise;
}

interface Entry { torrent: any; lastUsed: number }
const torrents = new Map<string, Entry>();     // infoHash -> entry

// Lowercase the fallback too: a bare infohash and the same hash inside a magnet's
// `btih:` must map to ONE key, or dedup/eviction/getStatus see two entries.
const magnetHash = (m: string): string => (m.match(/btih:([a-z0-9]{32,40})/i) || [])[1]?.toLowerCase() || m.toLowerCase();

const inflight = new Map<string, Promise<any>>();   // infoHash -> pending add (concurrent requests share it)

const drop = (hash: string, t: any) => {
    torrents.delete(hash);
    try { t.destroy({ destroyStore: true }); } catch { /* */ }
};

/** Add (or reuse) a magnet and resolve once its metadata (file list) is ready. */
export async function addTorrent(magnetOrHash: string): Promise<any> {
    const hash = magnetHash(magnetOrHash);
    const existing = torrents.get(hash);
    if (existing) { existing.lastUsed = Date.now(); return existing.torrent; }
    let pending = inflight.get(hash);
    if (!pending) {
        if (inflight.size >= MAX_ACTIVE) throw new Error('too many torrents starting — try again shortly');
        pending = startAdd(hash, magnetOrHash).finally(() => inflight.delete(hash));
        inflight.set(hash, pending);
    }
    return pending;
}

async function startAdd(hash: string, magnetOrHash: string): Promise<any> {
    const client = await getClient();
    // Make room: evict least-recently-used torrents beyond the cap.
    // ponytail: LRU by last request, so a long single-request remux can be evicted by
    // MAX_ACTIVE newer adds; track open streams if that ever bites.
    while (torrents.size + inflight.size > MAX_ACTIVE && torrents.size) {
        const [k, e] = [...torrents].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        drop(k, e.torrent);
    }
    const torrent: any = await new Promise((resolve, reject) => {
        let t: any;
        const fail = (e: any) => { clearTimeout(timer); if (t) drop(hash, t); reject(e); };
        const timer = setTimeout(() => fail(new Error('torrent add timeout (no peers/metadata)')), ADD_TIMEOUT_MS);
        try {
            // deselect: download only the pieces a stream actually reads, never the whole torrent.
            t = client.add(magnetOrHash, { path: DOWNLOAD_DIR, deselect: true }, (ready: any) => {
                clearTimeout(timer);
                console.log(`[torrent] ready: "${ready.name}" — ${ready.files?.length || 0} files, ${ready.numPeers} peers`);
                resolve(ready);
            });
            t.on('error', fail);
        } catch (e) { fail(e); }
    });
    torrents.set(hash, { torrent, lastUsed: Date.now() });
    return torrent;
}

const VIDEO_RE = /\.(mkv|mp4|webm|avi|ts|m4v|mov)$/i;

/**
 * Pick the video file: explicit index, else the file matching `episode` (for BATCH
 * torrents — this is what stops "clicked ep 1, played ep 2"), else the largest.
 */
export function pickVideoFile(torrent: any, index?: number, episode?: number): any {
    const vids = (torrent.files || []).filter((f: any) => VIDEO_RE.test(f.name));
    const pool = vids.length ? vids : (torrent.files || []);
    if (index != null && !Number.isNaN(index) && pool[index]) return pool[index];
    if (episode != null && !Number.isNaN(episode) && pool.length > 1) {
        // Match " - 01 ", "E01", "x01", "Episode 1", etc. — but NOT a bare year/res.
        const epRe = new RegExp(`(?:^|[\\s\\-._([x])(?:e|ep|episode\\s*)?0*${episode}(?:[\\s\\-._)\\]v]|$)`, 'i');
        const m = pool.find((f: any) => epRe.test(f.name));
        if (m) return m;
    }
    return [...pool].sort((a: any, b: any) => (b.length || 0) - (a.length || 0))[0];
}

export const touch = (magnetOrHash: string) => { const e = torrents.get(magnetHash(magnetOrHash)); if (e) e.lastUsed = Date.now(); };

// ── ffmpeg (optional) — remux mkv → browser-playable fragmented mp4 ───────────
let ffmpegOk: boolean | null = null;
/** ffmpeg exits 0 for these args (spawn failure = false). */
const ffmpegRuns = (args: string[]): Promise<boolean> => new Promise((resolve) => {
    try {
        const p = spawn('ffmpeg', args, { stdio: 'ignore' });
        p.on('error', () => resolve(false));
        p.on('close', (code) => resolve(code === 0));
    } catch { resolve(false); }
});
// GPU encoder for non-h264 video, probed once. NVENC is picked up automatically when the
// container has an NVIDIA GPU (compose `gpus: all`). TORRENT_VAAPI is only honoured when the
// device really opens: on an NVIDIA render node every remux used to die with "I/O error".
let hwEnc: 'nvenc' | 'vaapi' | null = null;
export async function hasFfmpeg(): Promise<boolean> {
    if (ffmpegOk !== null) return ffmpegOk;
    ffmpegOk = await ffmpegRuns(['-version']);
    const src = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=256x256', '-t', '0.1'], sink = ['-f', 'null', '-'];
    if (ffmpegOk && await ffmpegRuns([...src, '-c:v', 'h264_nvenc', ...sink])) hwEnc = 'nvenc';
    else if (ffmpegOk && /^(1|true|yes)$/i.test(process.env.TORRENT_VAAPI || '')) {
        if (await ffmpegRuns(['-init_hw_device', 'vaapi=va:/dev/dri/renderD128', ...src, ...sink])) hwEnc = 'vaapi';
        else console.warn('[remux] TORRENT_VAAPI set but VAAPI did not initialise — using software remux');
    }
    if (hwEnc) console.log(`[remux] HEVC/AV1 → H.264 on the GPU (${hwEnc})`);
    return ffmpegOk;
}

/**
 * Remux any readable stream (a torrent file stream OR an SSRF-guarded HTTP fetch
 * stream) to fragmented MP4 for the browser, reading from ffmpeg's stdin. Feeding
 * ffmpeg via stdin — rather than `ffmpeg -i <url>` — is deliberate: ffmpeg does its
 * OWN DNS/redirects, so `-i <caller-url>` would bypass the SSRF guard entirely
 * (DNS-rebinding / redirect-to-internal). Callers fetch through the guarded agents
 * and pipe the result here. Returns the ffmpeg child; pipe `ff.stdout` to the response.
 */
export function remuxReadableToMp4(input: NodeJS.ReadableStream, audio = 0, video = ''): any {
    // h264 is copied (free, lossless); anything else (HEVC/AV1/unknown) goes through the GPU
    // encoder when there is one, else is copied as before (Safari/Edge still play HEVC).
    const enc = video === 'h264' ? null : hwEnc;
    const args = [
        '-hide_banner', '-loglevel', 'error',
        // NVDEC decodes when it can (Pascal: HEVC 8/10-bit), falls back to CPU otherwise (AV1)
        ...(enc === 'nvenc' ? ['-hwaccel', 'cuda'] : []),
        '-i', 'pipe:0',
        ...(enc === 'vaapi' ? ['-init_hw_device', 'vaapi=va:/dev/dri/renderD128', '-filter_hw_device', 'va'] : []),
        '-map', '0:v:0', '-map', `0:a:${audio}?`,   // one audio track (browsers can't switch muxed ones) — chosen by the client
        // ponytail: 10-bit HDR is squeezed to 8-bit without tone-mapping (colours look flat); add tonemap_cuda (jellyfin-ffmpeg) if that matters
        ...(enc === 'nvenc' ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-pix_fmt', 'yuv420p', '-rc', 'vbr', '-cq', '23']
            : enc === 'vaapi' ? ['-c:v', 'h264_vaapi'] : ['-c:v', 'copy']),
        '-c:a', 'aac', '-ac', '2',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4', 'pipe:1',
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    input.on('error', () => { try { ff.kill('SIGKILL'); } catch { /* */ } });
    // When ffmpeg exits (including a SIGKILL on client disconnect) destroy the source
    // stream too, so an aborted play doesn't leak the torrent/HTTP read stream until
    // the 20-minute idle evictor runs.
    ff.on('close', () => { try { (input as any).destroy?.(); } catch { /* */ } });
    input.pipe(ff.stdin).on('error', () => { /* client aborted / ffmpeg gone */ });
    return ff;
}

/** Remux a torrent file (mkv/HEVC) to fragmented MP4. */
export function remuxToMp4(file: any, audio = 0, video = ''): any {
    return remuxReadableToMp4(file.createReadStream(), audio, video);
}

export interface AudioTrackInfo { index: number; lang: string; title: string; channels?: number }
export interface MediaInfo { video: string; audio: AudioTrackInfo[] }
/** Video codec + audio tracks of a media file, from its first bytes (MKV/MP4 headers sit at
 *  the start). Audio `index` is what the remux maps with `0:a:<index>`. Empty on failure. */
export function probeMedia(head: NodeJS.ReadableStream): Promise<MediaInfo> {
    return new Promise((resolve) => {
        const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels:stream_tags=language,title', '-of', 'json', '-i', 'pipe:0'], { stdio: ['pipe', 'pipe', 'ignore'] });
        let out = '';
        const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, 20000);
        ff.stdout.on('data', (c: Buffer) => { out += c; });
        ff.on('close', () => {
            clearTimeout(timer);
            try {
                const streams: any[] = JSON.parse(out).streams || [];
                resolve({
                    video: String(streams.find((s) => s.codec_type === 'video')?.codec_name || ''),
                    audio: streams.filter((s) => s.codec_type === 'audio').map((s, index) => ({
                        index, lang: String(s.tags?.language || ''), title: String(s.tags?.title || ''), ...(s.channels ? { channels: s.channels } : {}),
                    })),
                });
            } catch { resolve({ video: '', audio: [] }); }
        });
        ff.on('error', () => resolve({ video: '', audio: [] }));
        head.on('error', () => { /* upstream cut short: ffprobe works with what it got */ });
        head.pipe(ff.stdin).on('error', () => { /* ffprobe stopped reading */ });
    });
}

// ── idle eviction ─────────────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [k, e] of torrents) {
        if (now - e.lastUsed > IDLE_MS) drop(k, e.torrent);
    }
}, 60_000).unref?.();

export const torrentStats = () => ({ active: torrents.size, max: MAX_ACTIVE, dir: DOWNLOAD_DIR });

/** Live stats for one active torrent (for the player overlay), or null if not added. */
export function getStatus(magnetOrHash: string): any | null {
    const e = torrents.get(magnetHash(magnetOrHash));
    if (!e) return null;
    const t = e.torrent;
    return {
        active: true,
        name: t.name,
        progress: t.progress,                 // 0..1
        downloaded: t.downloaded,
        length: t.length,
        downloadSpeed: t.downloadSpeed,       // bytes/s
        uploadSpeed: t.uploadSpeed,           // bytes/s
        numPeers: t.numPeers,
        timeRemaining: t.timeRemaining,       // ms (Infinity until it has a rate)
        ready: !!t.ready,
    };
}
