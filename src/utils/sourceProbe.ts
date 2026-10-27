import { fetchUpstream } from '../routes/proxy';
import { USER_AGENT } from './encdec';
import { guardUrl } from './ssrf';

/**
 * Playability probe + source scoring for the SSE resolver.
 *
 * A provider "returning a link" says nothing about whether it plays: CDNs 403 our
 * egress, tokens expire, hosts serve an HTML error page as a segment. The probe walks
 * the same path the player will (through the proxy's fetch, same headers, same WARP
 * fallback): HLS master → first variant → first segment's first bytes; MP4/MKV a ranged
 * GET. Results are cached per URL and probes run with bounded concurrency.
 */

/** `inconclusive`: the CDN rate-limited the probe itself (429) — says nothing about the source. */
export interface ProbeResult { ok: boolean; latencyMs: number; height?: number; format?: string; error?: string; inconclusive?: boolean; hevc?: boolean; at?: number; kbps?: number }

const MAX_CONCURRENT = 6;
const PROBE_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX = 2000;
const TEXT_MAX = 2 * 1024 * 1024;
const HEAD_BYTES = 4096;
/** First media bytes read to measure real download speed — a 4 KB read can't tell a
 *  server that trickles at 150 kbps (endless buffering) from a fast one. */
const SPEED_BYTES = 256 * 1024;

/** What container do these leading bytes look like? null = not media (HTML error page, JSON, garbage). */
export function sniffMedia(b: Buffer): string | null {
    if (b.length < 4) return null;
    if (/^\s*[<{\[]/.test(b.toString('latin1', 0, 64))) return null;   // HTML/XML/JSON error body
    // MPEG-TS: 0x47 sync byte every 188 bytes. Scan a little in case the CDN disguises the
    // segment behind a fake image header (common); require 3 syncs to rule out text that happens to contain 'G'.
    for (let i = 0; i < 1024 && i + 376 < b.length; i++) if (b[i] === 0x47 && b[i + 188] === 0x47 && b[i + 376] === 0x47) return 'ts';
    if (b[0] === 0x47 && b.length < 377) return 'ts';   // short read of a real TS packet
    if (b.length >= 8 && /^(ftyp|moof|styp|sidx|moov|free|wide|mdat|skip|pdin|emsg|prft)$/.test(b.toString('latin1', 4, 8))) return 'mp4';
    if (b.readUInt32BE(0) === 0x1a45dfa3) return 'mkv';
    if (b.toString('latin1', 0, 3) === 'ID3') return 'id3';   // packed audio (AAC) segment
    return null;
}

/** Parse what we need from a playlist: max advertised height, the first variant, or the first media resource. */
export function parsePlaylist(body: string, base: string): { master: boolean; height?: number; next?: string; encrypted: boolean; hevc?: boolean } {
    const abs = (u: string) => { try { return new URL(u, base).toString(); } catch { return undefined; } };
    const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const master = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
    if (master) {
        let height = 0, next: string | undefined;
        lines.forEach((l, i) => {
            if (!l.startsWith('#EXT-X-STREAM-INF')) return;
            // Class by the larger of height and width·9/16: a 1920x800 scope encode is "1080p", not 800p.
            const [, w, h] = /RESOLUTION=(\d+)x(\d+)/i.exec(l) || [];
            height = Math.max(height, Number(h) || 0, Math.round((Number(w) || 0) * 9 / 16));
            const uri = lines.slice(i + 1).find((x) => !x.startsWith('#'));
            if (!next && uri) next = abs(uri);
        });
        // Every variant that declares CODECS is HEVC → browsers without HEVC decode can't play it.
        const codecs = lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF') && /CODECS=/i.test(l));
        const hevc = codecs.length > 0 && codecs.every((l) => /CODECS="[^"]*\b(hvc1|hev1)/i.test(l));
        return { master, height: height || undefined, next, encrypted: false, ...(hevc ? { hevc } : {}) };
    }
    // fMP4 HLS starts with the EXT-X-MAP init segment (ftyp); TS starts at the first segment.
    const map = lines.map((l) => /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(l)?.[1]).find(Boolean);
    const seg = lines.find((l) => !l.startsWith('#'));
    const encrypted = lines.some((l) => /^#EXT-X-KEY:.*METHOD=(?!NONE)/i.test(l));
    return { master, next: abs(map || seg || ''), encrypted: encrypted && !map };
}

/** HEVC sample-entry fourcc in an MP4 head / fMP4 init segment (when moov is up front).
 *  ponytail: TS segments aren't parsed (PMT stream_type 0x24) — label/URL tokens cover most. */
const hevcIn = (b: Buffer): boolean => /hvc1|hev1/.test(b.toString('latin1'));

const readHead = (stream: any, n: number): Promise<Buffer> => new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let len = 0, settled = false;
    const done = () => { if (settled) return; settled = true; stream.destroy?.(); resolve(Buffer.concat(chunks)); };
    stream.on('data', (c: Buffer) => { chunks.push(c); len += c.length; if (len >= n) done(); });
    stream.on('end', done);
    stream.on('error', (e: any) => (len ? done() : (settled = true, reject(e))));
});

async function runProbe(url: string, type: string, extra: Record<string, string> | undefined, signal: AbortSignal): Promise<Omit<ProbeResult, 'latencyMs'>> {
    const headers = { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity', ...(extra || {}) };
    const getText = async (u: string) => {
        if (guardUrl(u)) throw new Error('blocked url');
        const r = await fetchUpstream(u, { headers, responseType: 'text', timeout: PROBE_TIMEOUT_MS, maxContentLength: TEXT_MAX, transformResponse: (x: any) => x, signal });
        return String(r.data);
    };
    const getHead = async (u: string, n = HEAD_BYTES) => {
        if (guardUrl(u)) throw new Error('blocked url');
        const r = await fetchUpstream(u, { headers: { ...headers, Range: `bytes=0-${n - 1}` }, responseType: 'stream', decompress: false, timeout: PROBE_TIMEOUT_MS, validateStatus: () => true, signal });
        if (r.status >= 400) { r.data?.destroy?.(); throw new Error(`HTTP ${r.status}`); }
        return readHead(r.data, n);
    };

    // timed media read; on the probe deadline readHead keeps what arrived (a slow server scores low, not failed)
    const media = async (u: string) => { const t = Date.now(); const b = await getHead(u, SPEED_BYTES); return { head: b, kbps: Math.round((b.length * 8) / Math.max(1, Date.now() - t)) }; };
    if (type !== 'm3u8') {
        const { head, kbps } = await media(url);
        const fmt = sniffMedia(head);
        return fmt ? { ok: true, format: fmt, kbps, ...(hevcIn(head) ? { hevc: true } : {}) } : { ok: false, error: 'not a media file' };
    }
    let body = await getText(url), base = url;
    if (!body.includes('#EXTM3U')) return { ok: false, error: 'not a playlist' };
    let pl = parsePlaylist(body, base);
    const { height, hevc } = pl;
    if (pl.master) {
        if (!pl.next) return { ok: false, error: 'empty master', height };
        base = pl.next; body = await getText(base);
        if (!body.includes('#EXTM3U')) return { ok: false, error: 'variant not a playlist', height };
        pl = parsePlaylist(body, base);
    }
    if (!pl.next) return { ok: false, error: 'no segments', height };
    const { head, kbps } = await media(pl.next);
    const fmt = sniffMedia(head);
    // AES-128 segments are ciphertext — a non-HTML 2xx body is the best we can check.
    if (fmt || (pl.encrypted && head.length && head[0] !== 0x3c)) return { ok: true, format: fmt || 'encrypted', height, kbps, ...(hevc || hevcIn(head) ? { hevc: true } : {}) };
    return { ok: false, error: 'segment is not media', height };
}

// ── bounded concurrency + per-URL cache ─────────────────────────────────────
let active = 0;
const waiting: (() => void)[] = [];
const acquire = async () => { if (active < MAX_CONCURRENT) active++; else await new Promise<void>((r) => waiting.push(r)); };
const release = () => { const next = waiting.shift(); if (next) next(); else active--; };   // hand the slot straight over

const cache = new Map<string, { at: number; p: Promise<ProbeResult> }>();

/** Probe a raw upstream stream URL (not the /api/proxy one). Never throws. */
export function probeStream(url: string, type: string, headers?: Record<string, string>): Promise<ProbeResult> {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.p;
    const p = (async (): Promise<ProbeResult> => {
        await acquire();
        const t = Date.now();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
        try {
            const r = await runProbe(url, type, headers, ac.signal);
            return { ...r, latencyMs: Date.now() - t, at: Date.now() };
        } catch (e: any) {
            const error = ac.signal.aborted ? 'probe timed out' : String(e?.message || e).slice(0, 80);
            return { ok: false, latencyMs: Date.now() - t, error, inconclusive: / 429$/.test(error), at: Date.now() };
        } finally {
            clearTimeout(timer);
            release();
        }
    })();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);   // oldest insertion
    cache.set(url, { at: Date.now(), p });
    return p;
}

// ── scoring ─────────────────────────────────────────────────────────────────
const LANGS = ['Hindi', 'English', 'Tamil', 'Telugu', 'Malayalam', 'Kannada', 'Bengali', 'Punjabi', 'Marathi', 'Spanish', 'French', 'German', 'Korean', 'Japanese', 'Chinese', 'Arabic', 'Russian', 'Italian', 'Portuguese', 'Vietnamese'];
/** Audio language named in a source label (same rules as the client's detectAudio). */
export function detectAudio(name: string): string {
    if (/\bvietsub\b/i.test(name)) return 'Vietnamese';
    if (/\bdual\b/i.test(name)) return 'Dual';
    if (/\bmulti(-?audio)?\b/i.test(name)) return 'Multi';
    return LANGS.find((l) => new RegExp('\\b' + l + '\\b', 'i').test(name)) || '';
}
const DUB_RE = /\b(dub|dubbed|hindi|english|tamil|telugu|malayalam|kannada|dual|multi)\b/i;
const SUB_RE = /\b(sub|subbed|subtitle|japanese|jpn|jp|original|raw)\b/i;

const ISO: Record<string, string> = {
    Hindi: 'hi', English: 'en', Tamil: 'ta', Telugu: 'te', Malayalam: 'ml', Kannada: 'kn', Bengali: 'bn', Punjabi: 'pa', Marathi: 'mr',
    Spanish: 'es', French: 'fr', German: 'de', Korean: 'ko', Japanese: 'ja', Chinese: 'zh', Arabic: 'ar', Russian: 'ru', Italian: 'it',
    Portuguese: 'pt', Vietnamese: 'vi', Dual: 'mul', Multi: 'mul',
};
export interface AudioTrack { lang: string; label: string; dub?: boolean }
/** Structured audio for the UI: [] when unknown. `lang` is ISO-639-1, or 'mul' (Dual/Multi) /
 *  'und' (a dub of unstated language). `dub` is set for anime only. */
export function audioTracks(name: string, audio: string, isAnime?: boolean): AudioTrack[] {
    const text = `${name} ${audio}`;
    const dub = isAnime ? (DUB_RE.test(text) ? true : SUB_RE.test(text) ? false : undefined) : undefined;
    const label = audio === 'Dual' ? 'Dual audio' : audio === 'Multi' ? 'Multi audio' : audio;
    if (audio) return [{ lang: ISO[audio] || 'und', label, ...(dub !== undefined ? { dub } : {}) }];
    if (dub === false) return [{ lang: 'ja', label: 'Japanese', dub: false }];
    if (dub) return [{ lang: 'und', label: 'Dub', dub: true }];
    return [];
}

export type FailReason = 'timeout' | 'http' | 'decode' | 'geo';
/** Bucket a probe/playback error string for the UI's "Failed …" / "Blocked in your region" copy. */
export function failReason(err?: string): FailReason {
    const e = err || '';
    if (/geo|region|country|\b451\b/i.test(e)) return 'geo';
    if (/time(d)?\s?out|timeout|abort/i.test(e)) return 'timeout';
    if (/decode|codec|SRC_NOT_SUPPORTED/i.test(e)) return 'decode';
    return 'http';   // 4xx/5xx, HTML error page instead of media, empty playlist…
}

// Codecs/containers a browser <video> can't decode natively (MKV, HEVC, 10-bit, Dolby/DTS audio):
// playable only through the server's ffmpeg remux, so never auto-picked.
// "(VLC)"-tagged sources are meant for external players (the client already sinks them).
const NOT_WEB_RE = /\b(vlc|mkv|x265|h\.?265|hevc|10.?bit|ddp?(\s?[257]\.[01])?|dd\+|e-?ac-?3|truehd|dts(-hd)?|atmos)\b/i;
/** false = browser likely can't decode it (flag from the extractor, sniffed MKV, or codec tokens in the label). */
export const webReadyOf = (label: string, format?: string, notWebReady?: boolean): boolean =>
    !(notWebReady || format === 'mkv' || NOT_WEB_RE.test(label));
/** Bitrate hint ("~46.4 Mbps") from a stream label, else undefined. */
export const mbpsOf = (label: string): number | undefined => {
    const m = /(\d+(?:\.\d+)?)\s*Mbps/i.exec(label);
    return m ? Number(m[1]) : undefined;
};

export interface ScorePrefs { audio?: string[]; anime?: 'sub' | 'dub' }
export interface ScoreInput {
    verified: boolean | 'unknown'; type: string; quality?: number; latencyMs?: number;
    reliability: number;   // 0..1 provider reliability (playback reports + found rate)
    hidden?: boolean; name?: string; audio?: string;
    webReady?: boolean;    // false → needs server remux (see webReadyOf)
    mbps?: number;         // advertised bitrate; very high = stalls on a weak link
    kbps?: number;         // measured download speed of the first media bytes
}

/** Language fit: + for the preferred audio, − for a known mismatch, 0 when unknown. */
export function langScore(name: string, audio: string, prefs: ScorePrefs): number {
    if (prefs.anime) {
        const dub = DUB_RE.test(`${name} ${audio}`), sub = SUB_RE.test(`${name} ${audio}`);
        return prefs.anime === 'dub' ? (dub ? 15 : sub ? -25 : -10) : (dub && !sub ? -25 : 0);   // unmarked anime is usually JP audio
    }
    const want = (prefs.audio || []).map((a) => a.toLowerCase());
    if (!want.length || !audio) return 0;
    if (audio === 'Dual' || audio === 'Multi') return 8;
    const i = want.indexOf(audio.toLowerCase());
    return i === 0 ? 15 : i > 0 ? 8 : -25;
}

/**
 * Higher = better. Roughly 0..115:
 *   verified +40 (unknown +10, failed −100) · format HLS 10 / MP4 8 / iframe 0 ·
 *   quality ≥1080 20, 720 14, unknown 8, SD 6 · reliability 0..20 · latency 0..10 ·
 *   language −25..+15 · not web-ready −40 · heavy bitrate −6/−12 · measured speed −25..+6 · hidden provider −50.
 */
export function scoreSource(s: ScoreInput, prefs: ScorePrefs = {}): number {
    const q = s.quality || 0;
    let score = s.verified === true ? 40 : s.verified === 'unknown' ? 10 : -100;
    score += s.type === 'm3u8' ? 10 : s.type === 'mp4' ? 8 : 0;
    score += q >= 1080 ? 20 : q >= 720 ? 14 : q === 0 ? 8 : 6;
    score += 20 * Math.min(Math.max(s.reliability, 0), 1);
    if (s.latencyMs != null) score += 10 * (1 - Math.min(s.latencyMs, PROBE_TIMEOUT_MS) / PROBE_TIMEOUT_MS);
    score += langScore(s.name || '', s.audio || '', prefs);
    if (s.webReady === false) score -= 40;
    // Heavy streams stall on ordinary links: a verified fast 1080p should beat a 46 Mbps 4K.
    if (s.mbps) score -= s.mbps > 25 ? 12 : s.mbps > 15 ? 6 : 0;
    else if (q >= 2160 && (s.latencyMs ?? 0) > 2500) score -= 6;
    // measured speed: under ~1.5 Mbps even 720p buffers; a fast server should win ties
    if (s.kbps != null) score += s.kbps < 1500 ? -25 : s.kbps < 4000 ? -8 : s.kbps >= 15000 ? 6 : 0;
    if (s.hidden) score -= 50;
    return Math.round(score * 10) / 10;
}

/** Score at/above which a VERIFIED source is good enough to auto-start without waiting for others. */
export const GOOD_SCORE = 85;

// ── client playback reports ─────────────────────────────────────────────────
export type PlayOutcome = 'played' | 'failed' | 'stalled';
export interface PlayReport { provider: string; outcome: PlayOutcome; url?: string; ttffMs?: number; error?: string }

/** Validate/clamp a POST /sources/report body. `known` = valid provider ids. */
export function parseReport(body: any, known: Set<string>): PlayReport | { invalid: string } {
    if (!body || typeof body !== 'object') return { invalid: 'JSON object required' };
    const { provider, outcome, url, ttffMs, error } = body;
    if (typeof provider !== 'string' || !known.has(provider)) return { invalid: 'unknown provider' };
    if (outcome !== 'played' && outcome !== 'failed' && outcome !== 'stalled') return { invalid: 'outcome must be played|failed|stalled' };
    const r: PlayReport = { provider, outcome };
    if (url !== undefined) {
        if (typeof url !== 'string' || url.length > 4096 || !/^(\/api\/|https?:\/\/)/.test(url)) return { invalid: 'bad url' };
        r.url = url;
    }
    if (ttffMs !== undefined) {
        if (typeof ttffMs !== 'number' || !Number.isFinite(ttffMs)) return { invalid: 'bad ttffMs' };
        r.ttffMs = Math.round(Math.min(Math.max(ttffMs, 0), 120_000));
    }
    if (typeof error === 'string') r.error = error.slice(0, 200);
    return r;
}
