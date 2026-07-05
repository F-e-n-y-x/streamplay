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

const magnetHash = (m: string): string => (m.match(/btih:([a-z0-9]{32,40})/i) || [])[1]?.toLowerCase() || m;

/** Add (or reuse) a magnet and resolve once its metadata (file list) is ready. */
export async function addTorrent(magnetOrHash: string): Promise<any> {
    const client = await getClient();
    const hash = magnetHash(magnetOrHash);
    const existing = torrents.get(hash);
    if (existing) { existing.lastUsed = Date.now(); return existing.torrent; }
    // WebTorrent itself de-dupes by infoHash, but keep our own map for eviction.
    const already = client.get(magnetOrHash);
    if (already && already.ready) { torrents.set(hash, { torrent: already, lastUsed: Date.now() }); return already; }

    const torrent: any = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('torrent add timeout (no peers/metadata)')), ADD_TIMEOUT_MS);
        try {
            const t = client.add(magnetOrHash, { path: DOWNLOAD_DIR }, (ready: any) => {
                clearTimeout(timer);
                console.log(`[torrent] ready: "${ready.name}" — ${ready.files?.length || 0} files, ${ready.numPeers} peers`);
                resolve(ready);
            });
            t.on('error', (e: any) => { clearTimeout(timer); reject(e); });
        } catch (e) { clearTimeout(timer); reject(e); }
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
export function hasFfmpeg(): Promise<boolean> {
    if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
    return new Promise((resolve) => {
        try {
            const p = spawn('ffmpeg', ['-version']);
            p.on('error', () => { ffmpegOk = false; resolve(false); });
            p.on('close', (code) => { ffmpegOk = code === 0; resolve(ffmpegOk); });
        } catch { ffmpegOk = false; resolve(false); }
    });
}

/**
 * Remux a torrent file's read stream to fragmented MP4 for the browser. Copies the
 * video when it's already h264 (cheap) and transcodes audio to AAC; a VAAPI encoder
 * ($TORRENT_VAAPI=1, needs /dev/dri) handles HEVC. Returns the ffmpeg child; pipe
 * ffmpeg.stdout to the HTTP response.
 */
export function remuxToMp4(file: any): any {
    const input = file.createReadStream();
    const vaapi = /^(1|true|yes)$/i.test(process.env.TORRENT_VAAPI || '');
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        ...(vaapi ? ['-init_hw_device', 'vaapi=va:/dev/dri/renderD128', '-filter_hw_device', 'va'] : []),
        // copy h264 as-is; transcode anything else (HEVC) — VAAPI when available
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', vaapi ? 'h264_vaapi' : 'copy',
        '-c:a', 'aac', '-ac', '2',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4', 'pipe:1',
    ];
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'inherit'] });
    input.on('error', () => { try { ff.kill('SIGKILL'); } catch { /* */ } });
    input.pipe(ff.stdin).on('error', () => { /* client aborted */ });
    return ff;
}

/**
 * Remux a remote HTTP file (a debrid-cached .mkv link) to fragmented MP4 for the
 * browser. ffmpeg reads the URL directly (it follows redirects), so we don't manage
 * the fetch stream. Same codec policy as remuxToMp4. Returns the ffmpeg child.
 */
export function remuxUrlToMp4(url: string): any {
    const vaapi = /^(1|true|yes)$/i.test(process.env.TORRENT_VAAPI || '');
    const args = [
        '-hide_banner', '-loglevel', 'error',
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        ...(vaapi ? ['-init_hw_device', 'vaapi=va:/dev/dri/renderD128', '-filter_hw_device', 'va'] : []),
        '-i', url,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', vaapi ? 'h264_vaapi' : 'copy',
        '-c:a', 'aac', '-ac', '2',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4', 'pipe:1',
    ];
    return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'inherit'] });
}

// ── idle eviction ─────────────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [k, e] of torrents) {
        if (now - e.lastUsed > IDLE_MS) {
            try { e.torrent.destroy({ destroyStore: true }); } catch { /* */ }
            torrents.delete(k);
        }
    }
}, 60_000).unref?.();

export const torrentStats = () => ({ active: torrents.size, dir: DOWNLOAD_DIR });

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
