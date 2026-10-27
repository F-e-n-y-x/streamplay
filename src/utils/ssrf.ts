import http from 'http';
import https from 'https';
import dns from 'dns';
import net from 'net';
import { pipeline } from 'stream';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import type { LookupFunction } from 'net';
import { dohEnabled, dohLookup } from './dns';

/**
 * SSRF guard for outbound fetches that use a caller/scrape-supplied URL
 * (the playback proxy, the debrid passthrough and the extractor HTTP layer).
 *
 * Layers:
 *   1. `guardUrl` — a cheap up-front scheme + literal-host check. WHATWG `URL`
 *      already canonicalises sneaky IPv4 encodings (`2130706433`, `0x7f.1`) to
 *      dotted form, and IPv6 to compressed hex, before we look at the host.
 *   2. `ssrfAgents` — http(s) agents that refuse to connect to a private address,
 *      both when a NAME resolves to one (guarded DNS lookup → stops DNS rebinding)
 *      and when the host is a LITERAL IP (Node skips `lookup` for literals, so the
 *      agent's `createConnection` checks those itself). Every socket — including
 *      every redirect hop — goes through the agent.
 *   3. `guardRedirect` — re-validates each redirect target (also on the WARP
 *      branch, whose agents resolve remotely).
 * `guardedGet` bundles all three; use it for any caller-supplied URL.
 */

// ── IP classification ─────────────────────────────────────────────────────────
const isPrivateV4 = ([a, b, c]: number[]): boolean =>
    a === 127 || a === 10 || a === 0 ||
    (a === 169 && b === 254) ||          // link-local + cloud metadata (169.254.169.254)
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments 192.0.0/24
    a >= 224;                            // multicast 224/4 + reserved 240/4 + broadcast

const parseV4 = (h: string): number[] | null => {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    const o = m?.slice(1).map(Number);
    return o && o.every((n) => n <= 255) ? o : null;
};

/** Expand an IPv6 literal (any valid textual form, incl. trailing dotted v4) to 8 hextets. */
const parseV6 = (h: string): number[] | null => {
    const tail4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
    if (tail4) {
        const o = parseV4(tail4[2]);
        if (!o) return null;
        h = `${tail4[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    }
    const halves = h.split('::');
    if (halves.length > 2) return null;
    const groups = (s: string) => (s ? s.split(':') : []);
    const head = groups(halves[0]), tail = halves.length === 2 ? groups(halves[1]) : [];
    const fill = 8 - head.length - tail.length;
    if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
    const out = [...head, ...Array(fill).fill('0'), ...tail].map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN));
    return out.some(Number.isNaN) ? null : out;
};

const isPrivateV6 = (x: number[]): boolean => {
    const v4 = (hi: number, lo: number) => isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
    const zero = (from: number, to: number) => x.slice(from, to).every((n) => n === 0);
    if (zero(0, 5) && (x[5] === 0 || x[5] === 0xffff)) return v4(x[6], x[7]);       // ::, ::1, ::a.b.c.d, ::ffff:a.b.c.d
    if (zero(0, 4) && x[4] === 0xffff && x[5] === 0) return v4(x[6], x[7]);          // ::ffff:0:a.b.c.d (SIIT)
    if (x[0] === 0x64 && x[1] === 0xff9b && zero(2, 6)) return v4(x[6], x[7]);       // NAT64 64:ff9b::/96
    if (x[0] === 0x2002) return v4(x[1], x[2]);                                      // 6to4 2002::/16
    return x[0] >= 0xfc00;   // ULA fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8
};

/** True if an ADDRESS (already an IP literal) points somewhere internal. */
export const isPrivateAddress = (addr: string): boolean => {
    const h = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.+$/, ''); // strip brackets + zone id
    if (h.includes(':')) { const x = parseV6(h); return x ? isPrivateV6(x) : true; }  // unparseable v6 → refuse
    const v4 = parseV4(h);
    return v4 ? isPrivateV4(v4) : false;
};

/** True if a HOST (name or IP) is one we must never fetch server-side. */
export const isBlockedHost = (host: string): boolean => {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    return isPrivateAddress(h);
};

// ── admin-configured allowlist (Nuvio plugin / Stremio addon servers) ─────────
// The user's own plugin servers often live on the LAN (http://192.168.x.y:4001) and hand
// back stream URLs on that same origin, which /api/proxy must be able to play. Only the
// EXACT origins of admin-configured manifest URLs are allowed (scheme+host+port at the
// URL check; host+port at the socket) — every other private address stays blocked.
const allowSets = new Map<string, string[]>();
let allowedOrigins = new Set<string>();     // "http://192.168.10.10:4001"
let allowedSockets = new Set<string>();     // "192.168.10.10:4001"
let allowedNames = new Set<string>();       // hostnames (for the DNS-lookup guard)
/** Replace one source's (e.g. 'nuvio') allowlisted origins. */
export const setAllowedOrigins = (source: string, urls: string[]): void => {
    allowSets.set(source, urls);
    const us = [...allowSets.values()].flat().flatMap((x) => { try { return [new URL(x)]; } catch { return []; } })
        .filter((u) => u.protocol === 'http:' || u.protocol === 'https:');
    allowedOrigins = new Set(us.map((u) => u.origin));
    allowedSockets = new Set(us.map((u) => `${u.hostname.replace(/^\[|\]$/g, '')}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`));
    allowedNames = new Set(us.map((u) => u.hostname.toLowerCase()));
};

/** True when the URL's exact origin is on the admin allowlist. */
export const isAllowedOrigin = (raw: string): boolean => { try { return allowedOrigins.has(new URL(raw).origin); } catch { return false; } };

/** Validate a caller-supplied URL. Returns a reason string when blocked, else null. */
export const guardUrl = (raw: string): string | null => {
    let u: URL;
    try { u = new URL(raw); } catch { return 'bad url'; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'blocked scheme';
    if (allowedOrigins.has(u.origin)) return null;
    if (isBlockedHost(u.hostname)) return 'blocked host';
    return null;
};

/** Error code stamped on a guard rejection so callers can tell an SSRF block apart
 *  from an ordinary network error (e.g. so the proxy's WARP fallback doesn't retry it). */
export const SSRF_BLOCKED = 'SSRF_BLOCKED';
const blockedErr = (what: string) => Object.assign(new Error(`blocked private address ${what}`), { code: SSRF_BLOCKED });

/** axios `beforeRedirect` hook: re-validate every redirect hop's target. A 'bad url'
 *  from a reconstruction hiccup is ignored so legit redirects aren't broken; only an
 *  explicit blocked-host/scheme aborts. */
export const guardRedirect = (options: any): void => {
    const href = options.href || `${options.protocol || 'https:'}//${options.host || options.hostname || ''}${options.path || ''}`;
    const blocked = guardUrl(href);
    if (blocked && blocked !== 'bad url') throw Object.assign(new Error(`blocked redirect: ${blocked}`), { code: SSRF_BLOCKED });
};

// ── guarded DNS lookup + agents ───────────────────────────────────────────────
const strictLookup: LookupFunction = ((hostname: string, options: any, cb: any) => {
    const base = dohEnabled ? dohLookup : (dns.lookup as LookupFunction);
    base(hostname, { ...(typeof options === 'object' ? options : {}) }, ((err: any, address: any, family: any) => {
        if (err) return cb(err);
        if (Array.isArray(address)) {
            const bad = address.find((r: any) => isPrivateAddress(r.address));
            return bad ? cb(blockedErr(bad.address)) : cb(null, address);
        }
        if (isPrivateAddress(address)) return cb(blockedErr(address));
        cb(null, address, family);
    }) as any);
}) as LookupFunction;

const guardedLookup: LookupFunction = ((hostname: string, options: any, cb: any) => {
    if (allowedNames.has(String(hostname).toLowerCase())) return (dns.lookup as any)(hostname, options, cb);   // allowlisted plugin host (may be LAN-only DNS)
    return (strictLookup as any)(hostname, options, cb);
}) as LookupFunction;

/** Node never calls `lookup` for a literal-IP host, so check literals at connect time.
 *  An allowlisted NAME is only trusted on its allowlisted port: any other port gets the strict lookup. */
const guardLiterals = <A extends http.Agent>(agent: A): A => {
    const create = (agent as any).createConnection.bind(agent);
    (agent as any).createConnection = (opts: any, cb: any) => {
        const host = String(opts.host || opts.hostname || '').replace(/^\[|\]$/g, '');
        const pinned = allowedSockets.has(`${host}:${opts.port}`);
        if (net.isIP(host) && isPrivateAddress(host) && !pinned) { process.nextTick(cb, blockedErr(host)); return undefined; }
        if (!net.isIP(host) && !pinned && allowedNames.has(host.toLowerCase())) return create({ ...opts, lookup: strictLookup }, cb);
        return create(opts, cb);
    };
    return agent;
};

const guardedHttp = guardLiterals(new http.Agent({ lookup: guardedLookup, keepAlive: true }));
const guardedHttps = guardLiterals(new https.Agent({ lookup: guardedLookup, keepAlive: true }));

/** Agents that refuse any connection to a private/loopback IP (literal or resolved). */
export const ssrfAgents = (): { httpAgent: http.Agent; httpsAgent: https.Agent } =>
    ({ httpAgent: guardedHttp, httpsAgent: guardedHttps });

/** GET a caller-supplied URL through the guarded agents + per-hop redirect guard. */
export const guardedGet = (url: string, config: AxiosRequestConfig = {}): Promise<AxiosResponse> =>
    axios.get(url, { ...config, ...ssrfAgents(), beforeRedirect: guardRedirect });

// ── safe passthrough of upstream bodies on the app origin ─────────────────────
/** Upstream content types that are inert on our origin. Anything else (text/html,
 *  image/svg+xml, js…) is relabelled octet-stream: HLS CDNs often disguise segments
 *  as .png/.html, and hls.js / players ignore the type, so playback is unaffected. */
const SAFE_TYPE = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|octet-stream|mp4|dash\+xml)|binary\/octet-stream|text\/(vtt|plain))/i;
export const safeContentType = (ct?: string): string => (ct && SAFE_TYPE.test(ct) ? ct : 'application/octet-stream');

/** Headers for every response that carries proxied bytes: never sniff, never run script. */
export const setPassthroughSecurity = (res: http.ServerResponse): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', 'sandbox');
    res.setHeader('Access-Control-Allow-Origin', '*');   // <video>/hls.js/Chromecast fetch these cross-origin
};

/**
 * Pipe an axios `responseType: 'stream'` (fetched with `decompress: false`) to the
 * client: status + range headers, sanitised content type, content-encoding forwarded
 * (so Content-Length stays truthful), and `stream.pipeline` so a client disconnect
 * tears down the upstream socket (and vice versa).
 */
export const pipeUpstream = (upstream: AxiosResponse, req: http.IncomingMessage, res: http.ServerResponse): void => {
    if (req.destroyed) { upstream.data.destroy?.(); return; }
    res.statusCode = upstream.status;
    setPassthroughSecurity(res);
    for (const k of ['content-length', 'content-range', 'accept-ranges', 'cache-control', 'content-encoding']) {
        const v = upstream.headers[k];
        if (v) res.setHeader(k, v as string);
    }
    res.setHeader('Content-Type', safeContentType(upstream.headers['content-type'] as string | undefined));
    if (!upstream.headers['accept-ranges']) res.setHeader('Accept-Ranges', 'bytes');
    pipeline(upstream.data, res, () => { /* client gone or upstream error — both already destroyed */ });
};
