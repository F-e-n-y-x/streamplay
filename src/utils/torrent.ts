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
hasFfmpeg();   // probe at startup so proxify() knows whether seekable HLS conversion is on
/** NVENC present → converted files are served as seekable HLS (full-length slider, seeking). */
export const hlsReady = () => hwEnc === 'nvenc';

// ponytail: 1080p cap — 4K H.264 is black on many phones/tablets/iGPUs and heavy for the viewer's GPU
const NVENC_ARGS = ['-vf', 'scale=-2:min(1080\\,ih)', '-c:v', 'h264_nvenc', '-preset', 'p4', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-rc', 'vbr', '-cq', '23', '-maxrate', '8M', '-bufsize', '16M'];

/** The local passthrough of a remote file (/api/torrent/http without remux): ffmpeg/ffprobe read
 *  it with Range requests (seekable) while every upstream fetch still goes through the SSRF guard —
 *  ffmpeg never resolves the caller's URL itself. */
export const loopbackUrl = (url: string) => `http://127.0.0.1:${process.env.PORT || 3000}/api/torrent/http?url=${Buffer.from(url).toString('base64url')}`;
// ponytail: the password rides in ffmpeg's argv (visible to `ps` in the container); signed URLs if that matters
const LOOP_IN = ['-protocol_whitelist', 'http,tcp', ...(process.env.STREAMPLAY_PASSWORD ? ['-headers', `x-streamplay-key: ${process.env.STREAMPLAY_PASSWORD}\r\n`] : [])];

// ── Seekable HLS: one continuous GPU conversion per file (the Jellyfin model) ──────────────
// ffmpeg reads the file once, sequentially, and writes 10 s segments for the video and every
// audio track (s0_<n>.ts = video, s<k+1>_<n>.ts = audio track k). A request near the conversion
// is served as soon as its segment is written; a far seek restarts it right at that segment.
// `-copyts` + keyframes forced on the absolute 10 s grid keep every restart's timestamps on the
// same timeline; `-bf 0` because NVENC B-frames make the TS muxer shift a run that starts at 0.
export const HLS_SEG = 10;
const AHEAD = 30;        // pause the conversion 30 segments (5 min) ahead of the viewer
const KEEP_BEHIND = 6;   // delete segments more than a minute behind
interface HlsJob { dir: string; from: number; ff: any; exited: boolean; used: number; frontier: number; want: number; paused: boolean }
const hlsJobs = new Map<string, HlsJob>();
const segFile = (j: HlsJob, k: 'v' | number, i: number) => path.join(j.dir, `s${k === 'v' ? 0 : k + 1}_${i}.ts`);
const stopJob = (url: string, j: HlsJob) => {
    try { j.ff.kill('SIGKILL'); } catch { /* */ }
    fs.rm(j.dir, { recursive: true, force: true }, () => { /* */ });
    if (hlsJobs.get(url) === j) hlsJobs.delete(url);
};

function startHls(url: string, from: number, tracks: number): HlsJob {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-hls-'));
    const start = from * HLS_SEG;
    const args = [
        '-hide_banner', '-loglevel', 'error', ...LOOP_IN, '-reconnect', '1', '-reconnect_on_network_error', '1',
        '-probesize', '2M', '-analyzeduration', '1M', '-hwaccel', 'cuda', ...(start ? ['-ss', String(start)] : []), '-i', loopbackUrl(url), '-copyts',
        '-map', '0:v:0', ...Array.from({ length: tracks }, (_, k) => ['-map', `0:a:${k}`]).flat(),
        ...NVENC_ARGS, '-bf', '0', '-forced-idr', '1', '-force_key_frames', `expr:gte(t,${start}+n_forced*${HLS_SEG})`,
        '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-muxdelay', '0', '-muxpreload', '0',
        '-f', 'hls', '-hls_time', String(HLS_SEG), '-hls_playlist_type', 'event', '-hls_flags', 'temp_file', '-start_number', String(from),
        '-hls_segment_filename', path.join(dir, 's%v_%d.ts'),
        '-var_stream_map', ['v:0', ...Array.from({ length: tracks }, (_, k) => `a:${k}`)].join(' '), path.join(dir, 'p%v.m3u8'),
    ];
    const j: HlsJob = { dir, from, ff: spawn('ffmpeg', args, { stdio: 'ignore' }), exited: false, used: Date.now(), frontier: from - 1, want: from, paused: false };
    j.ff.on('close', () => { j.exited = true; });
    j.ff.on('error', () => { j.exited = true; });
    return j;
}

/** Path of finished segment `i` (video 'v' or audio track k) of `url`, or null if the conversion failed. */
export async function hlsSegmentFile(url: string, i: number, k: 'v' | number, tracks: number): Promise<string | null> {
    let j = hlsJobs.get(url);
    if (j) while (fs.existsSync(segFile(j, 'v', j.frontier + 1))) j.frontier++;
    // reuse the running conversion when `i` is already written or just ahead of it; else restart there
    const reusable = j && i >= j.from && (fs.existsSync(segFile(j, k, i)) || (!j.exited && i <= j.frontier + 3));
    if (!reusable) {
        if (j) stopJob(url, j);
        j = startHls(url, i, tracks);
        hlsJobs.set(url, j);
    }
    const job = j!;
    job.used = Date.now();
    if (k === 'v') {
        job.want = i;
        for (const f of fs.readdirSync(job.dir)) {   // drop what's well behind the viewer
            const n = Number(/_(\d+)\.ts$/.exec(f)?.[1]);
            if (n < i - KEEP_BEHIND) fs.rm(path.join(job.dir, f), { force: true }, () => { /* */ });
        }
    }
    if (job.paused && job.frontier < job.want + AHEAD) { job.ff.kill('SIGCONT'); job.paused = false; }
    const file = segFile(job, k, i);
    for (const until = Date.now() + 90_000; Date.now() < until;) {
        if (fs.existsSync(file)) return file;
        if (job.exited) return fs.existsSync(file) ? file : null;
        await new Promise((r) => setTimeout(r, 150));
    }
    return null;
}

// Pace and reap: pause a conversion far ahead of its viewer (saves GPU, disk, bandwidth), stop
// ones nobody has asked for in 2 minutes.
setInterval(() => {
    for (const [url, j] of hlsJobs) {
        if (Date.now() - j.used > 120_000) { stopJob(url, j); continue; }
        while (fs.existsSync(segFile(j, 'v', j.frontier + 1))) j.frontier++;
        if (!j.paused && !j.exited && j.frontier >= j.want + AHEAD) { j.ff.kill('SIGSTOP'); j.paused = true; }
    }
}, 2000).unref?.();

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
        ...(enc === 'nvenc' ? NVENC_ARGS
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

export interface AudioTrackInfo { index: number; lang: string; title: string; channels?: number; codec?: string }
export interface MediaInfo { video: string; audio: AudioTrackInfo[]; duration?: number }
/** Video codec + audio tracks (+ duration) of a media file: from its first bytes piped in (MKV
 *  headers sit at the start), or a loopback URL (seekable, so MP4 moov-at-end works too).
 *  Audio `index` is what the remux maps with `0:a:<index>`. Empty on failure. */
export function probeMedia(head: NodeJS.ReadableStream | string): Promise<MediaInfo> {
    return new Promise((resolve) => {
        const url = typeof head === 'string';
        const ff = spawn('ffprobe', ['-v', 'error', ...(url ? LOOP_IN : []), '-show_entries', 'stream=codec_type,codec_name,channels:stream_tags=language,title:format=duration', '-of', 'json', '-i', url ? head : 'pipe:0'], { stdio: [url ? 'ignore' : 'pipe', 'pipe', 'ignore'] });
        let out = '';
        const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, 20000);
        ff.stdout!.on('data', (c: Buffer) => { out += c; });
        ff.on('close', () => {
            clearTimeout(timer);
            try {
                const j = JSON.parse(out), streams: any[] = j.streams || [];
                const duration = Number(j.format?.duration) || undefined;
                resolve({
                    duration,
                    video: String(streams.find((s) => s.codec_type === 'video')?.codec_name || ''),
                    audio: streams.filter((s) => s.codec_type === 'audio').map((s, index) => ({
                        index, lang: String(s.tags?.language || ''), title: String(s.tags?.title || ''), codec: String(s.codec_name || ''), ...(s.channels ? { channels: s.channels } : {}),
                    })),
                });
            } catch { resolve({ video: '', audio: [] }); }
        });
        ff.on('error', () => resolve({ video: '', audio: [] }));
        if (typeof head === 'string') return;
        head.on('error', () => { /* upstream cut short: ffprobe works with what it got */ });
        head.pipe(ff.stdin!).on('error', () => { /* ffprobe stopped reading */ });
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
