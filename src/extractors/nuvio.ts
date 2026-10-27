import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import axios from 'axios';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle, ContentKind } from '../types';
import { guardUrl, guardRedirect, ssrfAgents, setAllowedOrigins, isAllowedOrigin } from '../utils/ssrf';
import { warpAxios } from '../utils/warp';
import { currentSignal } from '../utils/reqctx';
import { getAddonUrls, getScraperOverrides } from '../utils/serverConfig';
import { getIndexQuality } from '../utils/common';

/**
 * Nuvio plugin support — runs NuvioMobile scrapers (https://github.com/NuvioMedia) as
 * StreamPlay providers. Manifest URLs come ONLY from admin config (NUVIO_PLUGINS env or
 * the admin-token-gated /api/config/nuvio), never from a request.
 *
 * SECURITY: each call runs in a fresh worker_threads Worker inside a `node:vm` context
 * that exposes exactly the Nuvio globals (no process / Buffer / real require, empty env).
 * `node:vm` is NOT a security boundary — `this.constructor.constructor('return process')()`
 * escapes it — so this is defence in depth, not isolation. Only configure plugin repos you
 * trust as much as the server itself (or run them in their own container, like the
 * thin-client servers the plugins call). Plugin fetches go through the SSRF guard; the
 * manifest origins themselves are allowlisted (the user's plugin servers live on the LAN).
 *
 * Runtime contract mirrored from NuvioMobile PluginRuntime.kt / JsBindings.kt:
 * `getStreams(tmdbId: string, 'movie'|'tv', season?, episode?)` from module.exports or
 * globalThis; code wrapped in an IIFE with `module`/`exports`; fetch().json() → null on a
 * parse error; require() = cheerio (+ aliases) / crypto-js only (+ `cheerio`/`CryptoJS`
 * globals); 60s per call. Beyond Nuvio (real scrapers use these): re-readable bodies,
 * a real `Headers` (getSetCookie), clone()/blob(), the non-standard `timeout` fetch option,
 * structuredClone/queueMicrotask, and `module.exports = fn` / esbuild `default` exports.
 * Deliberately NOT provided (parity, and bundles that sniff them switch to Node code paths):
 * process, Buffer, real require, XMLHttpRequest, response.body streams, SCRAPER_SETTINGS values.
 */

export interface NuvioScraper {
    id: string; name: string; filename: string; supportedTypes: ('movie' | 'tv')[]; enabled: boolean;
    description?: string; version?: string; logo?: string; contentLanguage?: string[]; formats?: string[]; hasSettings?: boolean;
}

/** Nuvio's normalizePluginType: series/show/other → tv; we also fold `anime` into tv. */
const normTypes = (t: unknown): ('movie' | 'tv')[] => {
    const out = new Set<'movie' | 'tv'>();
    for (const x of Array.isArray(t) ? t : []) {
        const v = String(x).toLowerCase();
        if (v === 'movie') out.add('movie');
        else if (['tv', 'series', 'show', 'other', 'anime'].includes(v)) out.add('tv');
    }
    return out.size ? [...out] : ['movie', 'tv'];
};

/**
 * `{scrapers:[…]}` (standard), a bare array (some repos), or the list under `providers`/`plugins`.
 * Drops invalid entries; drops manifest-disabled ones unless `all` (the inspect preview).
 */
export const parseManifest = (m: any, all = false): { name: string; version?: string; description?: string; scrapers: NuvioScraper[] } => {
    const list: any[] = Array.isArray(m) ? m : [m?.scrapers, m?.providers, m?.plugins].find(Array.isArray) || [];
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : undefined);
    return {
        name: String((!Array.isArray(m) && m?.name) || 'Nuvio'),
        version: str(m?.version), description: str(m?.description),
        scrapers: list.filter((s) => s && typeof s.id === 'string' && s.id && typeof s.filename === 'string' && s.filename && (all || s.enabled !== false))
            .map((s) => ({
                id: s.id, name: String(s.name || s.id), filename: s.filename, supportedTypes: normTypes(s.supportedTypes), enabled: s.enabled !== false,
                description: str(s.description), version: str(s.version), logo: str(s.logo), contentLanguage: strs(s.contentLanguage),
                formats: strs(s.formats), hasSettings: s.hasSettings === true || undefined,
            })),
    };
};

/** movie → movie; tv → series+anime+asian; both → undefined (= every kind). */
export const kindsFor = (types: string[]): ContentKind[] | undefined => {
    const movie = types.includes('movie'), tv = types.includes('tv');
    if (movie && tv) return undefined;
    return [...(movie ? ['movie' as const] : []), ...(tv ? ['series' as const, 'anime' as const, 'asian' as const] : [])];
};

const qualityOf = (s: any): string | undefined => {
    const q = typeof s.quality === 'number' ? `${s.quality}p` : String(s.quality || '');
    if (/^\d{3,4}p$/i.test(q)) return q.toLowerCase();
    const all = `${q} ${s.resolution || ''} ${s.name || ''} ${s.title || ''}`;
    if (/\b(4k|uhd)\b|2160/i.test(all)) return '2160p';
    const n = getIndexQuality(all);
    return n ? `${n}p` : undefined;
};

/** Map Nuvio stream objects to StreamPlay streams + subtitles (http(s) urls only). */
export const mapNuvioStreams = (label: string, items: any[]): ExtractorResult => {
    const streams: Stream[] = [], subtitles: Subtitle[] = [];
    for (const raw of Array.isArray(items) ? items : []) {
        // Nuvio also accepts `url: { url }` (PluginRuntime.parseJsonResults)
        const s = raw && typeof raw.url === 'object' && raw.url ? { ...raw, url: raw.url.url } : raw;
        if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) continue;   // magnets / infoHash-only dropped
        const fmt = `${s.type || ''} ${s.format || ''}`.toLowerCase();
        const name = String(s.name || s.provider || s.title || '').replace(/^\s*\d+\.\s*/, '').replace(/^[⭐★]\s*/, '').trim();
        const extra = [s.language && !name.toLowerCase().includes(String(s.language).toLowerCase()) ? s.language : '', typeof s.size === 'string' ? s.size : '']
            .filter(Boolean).join(' · ');
        const headers = s.headers && typeof s.headers === 'object'
            ? Object.fromEntries(Object.entries(s.headers).filter(([, v]) => typeof v === 'string')) as Record<string, string> : undefined;
        const quality = qualityOf(s);
        streams.push({
            server: [label, name !== label ? name : '', extra].filter(Boolean).join(' · '),
            link: s.url,
            ...(typeof s.title === 'string' && s.title !== name ? { description: s.title } : {}),
            type: /m3u8|hls/.test(fmt) || /\.m3u8(\?|$)/i.test(s.url) ? 'm3u8' : 'mp4',
            ...(quality ? { quality } : {}),
            ...(headers && Object.keys(headers).length ? { headers } : {}),
        });
        for (const t of Array.isArray(s.subtitles) ? s.subtitles : []) {
            if (t?.url && !subtitles.some((x) => x.url === t.url)) subtitles.push({ language: String(t.language || t.lang || t.name || 'Unknown'), url: String(t.url) });
        }
    }
    return { streams, subtitles };
};

// ── worker runtime ─────────────────────────────────────────────────────────────
// Plain JS (eval'd), so it runs the same under tsx and compiled dist/. No backticks in here.
const WORKER_SRC = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { code, scraperId, args, paths, tmdbKey, debug } = workerData;
const cheerio = require(paths.cheerio);
const CryptoJS = require(paths.cryptojs);
let seq = 0, fetches = 0;
const pending = new Map();
parentPort.on('message', (m) => { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); if (m.error) p.reject(new TypeError(m.error)); else p.resolve(m); });
const abortErr = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
const normHeaders = (h) => {
  const out = {};
  if (!h) return out;
  if (Array.isArray(h)) h.forEach((p) => { out[p[0]] = String(p[1]); });
  else if (typeof h.forEach === 'function') h.forEach((v, k) => { out[k] = String(v); });
  else Object.keys(h).forEach((k) => { out[k] = String(h[k]); });
  return out;
};
const normBody = (b) => {
  if (b == null) return null;
  if (typeof b === 'string') return b;
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice();
  if (Object.prototype.toString.call(b) === '[object ArrayBuffer]') return new Uint8Array(b.slice(0));
  return String(b);
};
async function fetch(input, opts) {
  opts = opts || {};
  const url = String(typeof input === 'string' ? input : (input && input.url) || input);
  if (++fetches > 200) throw new TypeError('fetch limit reached');
  const sig = opts.signal;
  if (sig && sig.aborted) throw abortErr();
  const id = ++seq;
  const r = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    if (sig && sig.addEventListener) sig.addEventListener('abort', () => { if (pending.delete(id)) reject(abortErr()); });
    parentPort.postMessage({ t: 'fetch', id, url, method: String(opts.method || 'GET').toUpperCase(), headers: normHeaders(opts.headers), body: normBody(opts.body),
      manual: opts.redirect === 'manual', timeout: typeof opts.timeout === 'number' ? opts.timeout : 0 });
  });
  return mkRes(r, url);
}
// Body readable any number of times (Nuvio caches it); headers are a real Headers, so
// get/has/forEach/entries/iteration and getSetCookie() (one entry per Set-Cookie) all work.
function mkRes(r, url) {
  let text;
  const getText = () => (text === undefined ? (text = new TextDecoder().decode(r.body)) : text);
  const headers = new Headers();
  r.headers.forEach((p) => { try { headers.append(p[0], p[1]); } catch (e) { /* invalid header value */ } });
  return {
    ok: r.status >= 200 && r.status < 300, status: r.status, statusText: r.statusText, url: r.url, redirected: r.url !== url, type: 'basic', bodyUsed: false,
    headers,
    text: async () => getText(),
    json: async () => { try { const t = getText(); return t ? JSON.parse(t) : null; } catch (e) { return null; } },
    arrayBuffer: async () => r.body.slice().buffer,
    blob: async () => new Blob([r.body], { type: headers.get('content-type') || '' }),
    clone: () => mkRes(r, url),
  };
}
const log = (...a) => { if (debug) console.error('[nuvio:' + scraperId + ']', ...a); };
const MODS = { cheerio, 'cheerio-without-node-native': cheerio, 'react-native-cheerio': cheerio, 'crypto-js': CryptoJS };
const sandbox = {
  fetch, console: { log, info: log, debug: log, warn: log, error: log, trace: log },
  setTimeout, clearTimeout, setInterval, clearInterval, AbortController, AbortSignal, queueMicrotask, structuredClone,
  atob, btoa, URL, URLSearchParams, TextEncoder, TextDecoder, Headers, Blob, crypto: webcrypto, CryptoJS, cheerio,
  SCRAPER_SETTINGS: {}, SCRAPER_ID: scraperId, TMDB_API_KEY: tmdbKey,
  require: (n) => { if (Object.prototype.hasOwnProperty.call(MODS, n)) return MODS[n]; throw new Error("Module '" + n + "' is not available"); },
};
const ctx = vm.createContext(sandbox);
(async () => {
  try {
    vm.runInContext('globalThis.global = globalThis.window = globalThis.self = globalThis;', ctx);
    new vm.Script('var module = { exports: {} }; var exports = module.exports;\n(function() {\n' + code + '\n})();', { filename: scraperId + '.js' })
      .runInContext(ctx, { timeout: 5000 });
    // module.exports.getStreams | exports.getStreams | esbuild default interop | globalThis.getStreams | module.exports = fn
    const ex = ctx.module && ctx.module.exports;
    const fn = (ex && (ex.getStreams || (ex.default && ex.default.getStreams))) || ctx.getStreams || (typeof ex === 'function' ? ex : null);
    if (typeof fn !== 'function') throw new Error('getStreams not found');
    const res = await fn(args[0], args[1], args[2] == null ? undefined : args[2], args[3] == null ? undefined : args[3]);
    parentPort.postMessage({ t: 'done', result: JSON.parse(JSON.stringify(Array.isArray(res) ? res : [])) });
  } catch (e) {
    parentPort.postMessage({ t: 'done', error: String((e && e.message) || e) });
  }
})();
`;

const CALL_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT = 4;
const MAX_BODY = 10 * 1024 * 1024;
const PATHS = (() => { try { return { cheerio: require.resolve('cheerio'), cryptojs: require.resolve('crypto-js') }; } catch { return null; } })();

let active = 0;
const queue: (() => void)[] = [];
// A queued call whose request is gone (tab closed / provider timed out) leaves the queue
// instead of later spawning a worker for nobody.
const acquire = (signal?: AbortSignal) => new Promise<void>((ok, fail) => {
    if (signal?.aborted) return fail(new Error('aborted'));
    if (active < MAX_CONCURRENT) { active++; return ok(); }
    const go = () => { signal?.removeEventListener('abort', drop); active++; ok(); };
    const drop = () => { const i = queue.indexOf(go); if (i >= 0) queue.splice(i, 1); fail(new Error('aborted')); };
    signal?.addEventListener('abort', drop, { once: true });
    queue.push(go);
});
const release = () => { active--; queue.shift()?.(); };

interface FetchMsg { id: number; url: string; method: string; headers: Record<string, string>; body: string | Uint8Array | null; manual: boolean; timeout: number }

/** A plugin fetch, executed on the main thread through the SSRF-guarded HTTP stack. */
async function bridgeFetch(m: FetchMsg, warp: ReturnType<typeof warpAxios>, signal?: AbortSignal) {
    const blocked = guardUrl(m.url);
    if (blocked) throw new Error(`fetch blocked: ${blocked}`);
    const r = await axios.request({
        url: m.url, method: m.method, headers: m.headers, data: m.body ?? undefined,
        responseType: 'arraybuffer', maxRedirects: m.manual ? 0 : 5, validateStatus: () => true,
        timeout: m.timeout > 0 ? Math.min(m.timeout, 20000) : 20000, maxContentLength: MAX_BODY, signal: signal as any,
        // allowlisted (often LAN) plugin servers are never routed through WARP
        ...((!isAllowedOrigin(m.url) && warp) || ssrfAgents()), beforeRedirect: guardRedirect,
    });
    const headers: [string, string][] = [];   // pairs: repeated Set-Cookie stay separate
    for (const [k, v] of Object.entries(r.headers || {})) if (v != null) for (const x of Array.isArray(v) ? v : [v]) headers.push([k.toLowerCase(), String(x)]);
    return { status: r.status, statusText: r.statusText || '', url: (r.request as any)?.res?.responseUrl || m.url, headers, body: new Uint8Array(r.data) };
}

/** Run one scraper call in a fresh worker. Resolves to the raw Nuvio stream array. */
export async function runNuvioScraper(code: string, scraperId: string, args: [string, 'movie' | 'tv', number?, number?]): Promise<any[]> {
    if (!PATHS) throw new Error('cheerio/crypto-js not installed');
    const warp = warpAxios();
    const signal = currentSignal();
    await acquire(signal);
    try {
        return await new Promise<any[]>((resolve, reject) => {
            const worker = new Worker(WORKER_SRC, {
                eval: true, env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 },
                workerData: { code, scraperId, args, paths: PATHS, tmdbKey: process.env.TMDB_API_KEY || '', debug: !!process.env.NUVIO_DEBUG },
            });
            let settled = false;
            const finish = (err: Error | null, v?: any[]) => {
                if (settled) return;
                settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
                void worker.terminate();
                if (err) reject(err); else resolve(v || []);
            };
            const onAbort = () => finish(new Error('aborted'));
            const timer = setTimeout(() => finish(new Error(`timed out after ${CALL_TIMEOUT_MS / 1000}s`)), CALL_TIMEOUT_MS);
            signal?.addEventListener('abort', onAbort);
            worker.on('message', (m: any) => {
                if (m?.t === 'done') return finish(m.error ? new Error(m.error) : null, m.result);
                if (m?.t !== 'fetch') return;
                bridgeFetch(m, warp, signal).then(
                    (r) => { if (!settled) worker.postMessage({ id: m.id, ...r }, [r.body.buffer as ArrayBuffer]); },
                    (e) => { if (!settled) worker.postMessage({ id: m.id, error: String(e?.message || e).slice(0, 200) }); },
                );
            });
            worker.on('error', (e) => finish(e));
            worker.on('exit', () => finish(new Error('worker exited')));
        });
    } finally {
        release();
    }
}

// ── manifest loading / provider registry ────────────────────────────────────────
const REFRESH_MS = 60 * 60 * 1000;
interface Entry { manifest: string; repo: string; scraper: NuvioScraper; provider: Provider }
let entries: Entry[] = [];
let repos: { manifest: string; name?: string; ok: boolean; error?: string }[] = [];

export const getText = async (url: string): Promise<string> => {
    const blocked = guardUrl(url);
    if (blocked) throw new Error(`blocked: ${blocked}`);
    const r = await axios.get(url, { ...ssrfAgents(), beforeRedirect: guardRedirect, timeout: 15000, responseType: 'text', transformResponse: (x) => x, maxContentLength: 5 * 1024 * 1024 });
    if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
    return String(r.data);
};

/** Stable per-repo key: host + a short hash of the manifest directory, so two repos on one host
 *  (raw.githubusercontent.com) don't collide — hashed because the path may carry a token and
 *  provider ids are public. `http://192.168.10.10:4001/manifest.json` → `192.168.10.10:4001`. */
export const repoKey = (manifestUrl: string): string => {
    const u = new URL('.', manifestUrl);
    const dir = u.pathname.replace(/\/+$/, '');
    return dir ? `${u.host}~${createHash('sha1').update(dir).digest('hex').slice(0, 8)}` : u.host;
};

const EMPTY: ExtractorResult = { streams: [], subtitles: [] };
function makeProvider(manifestUrl: string, s: NuvioScraper, name: string): Provider {
    // Code is fetched on first use (a 66-scraper repo costs one request per reload, not 67);
    // a failed fetch isn't cached.
    let code: Promise<string> | undefined;
    return {
        id: `nuvio:${repoKey(manifestUrl)}:${s.id}`, name, kinds: kindsFor(s.supportedTypes),
        invoke: async (data: LinkData): Promise<ExtractorResult> => {
            if (!s.supportedTypes.includes(data.type)) return EMPTY;
            code ??= getText(new URL(s.filename, manifestUrl).href).catch((e) => { code = undefined; throw e; });
            return mapNuvioStreams(s.name, await runNuvioScraper(await code, s.id, [String(data.id), data.type, data.season, data.episode]));
        },
    };
}

/** Enabled = admin override (serverConfig) if set, else the manifest's `enabled`. */
const isOn = (e: Entry): boolean => getScraperOverrides()[e.provider.id] ?? e.scraper.enabled;

/** (Re)load every configured manifest. Scraper code loads lazily. Safe to call repeatedly. */
export async function reloadNuvio(): Promise<void> {
    const urls = getAddonUrls('nuvio');
    setAllowedOrigins('nuvio', urls);
    const res = await Promise.all(urls.map(async (manifest) => {
        try {
            const m = parseManifest(JSON.parse(await getText(manifest)), true);
            return { manifest, name: m.name, ok: true, scrapers: m.scrapers };
        } catch (e: any) {
            return { manifest, ok: false, error: String(e?.message || e).slice(0, 200), scrapers: [] as NuvioScraper[] };
        }
    }));
    // The same scraper name in two repos (4KHDHub…) gets the repo name appended.
    const seen = new Map<string, number>();
    for (const r of res) for (const s of r.scrapers) seen.set(s.name, (seen.get(s.name) || 0) + 1);
    const next = res.flatMap((r) => r.scrapers.map((s): Entry => ({
        manifest: r.manifest, repo: r.name || '', scraper: s,
        provider: makeProvider(r.manifest, s, (seen.get(s.name) || 0) > 1 ? `${s.name} · ${r.name}` : s.name),
    })));
    // Keep the previous providers for a manifest that failed transiently (refresh, not removal).
    const failed = new Set(res.filter((r) => !r.ok).map((r) => r.manifest));
    entries = [...next, ...entries.filter((e) => failed.has(e.manifest))];
    repos = res.map(({ manifest, name, ok, error }) => ({ manifest, name, ok, ...(error ? { error } : {}) }));
}

export const nuvioProviders = (): Provider[] => entries.filter(isOn).map((e) => e.provider);
export const nuvioStatus = () => repos.map((r) => ({ ...r, scrapers: entries.filter((e) => e.manifest === r.manifest && isOn(e)).map((e) => e.provider.id) }));
/** Every scraper of every configured repo (incl. disabled) — for the per-scraper toggles. */
export const nuvioScrapers = () => repos.map((r) => ({
    ...r,
    scrapers: entries.filter((e) => e.manifest === r.manifest).map((e) => ({
        id: e.provider.id, scraperId: e.scraper.id, name: e.scraper.name, enabled: isOn(e), manifestEnabled: e.scraper.enabled,
        supportedTypes: e.scraper.supportedTypes, description: e.scraper.description, version: e.scraper.version,
        contentLanguage: e.scraper.contentLanguage, formats: e.scraper.formats, logo: e.scraper.logo,
    })),
}));

if (getAddonUrls('nuvio').length) void reloadNuvio();
setInterval(() => { if (getAddonUrls('nuvio').length || entries.length) void reloadNuvio(); }, REFRESH_MS).unref();
