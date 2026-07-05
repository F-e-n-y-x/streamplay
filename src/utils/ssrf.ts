import http from 'http';
import https from 'https';
import dns from 'dns';
import type { LookupFunction } from 'net';
import { dohEnabled, dohLookup } from './dns';

/**
 * SSRF guard for outbound fetches that use a caller/scrape-supplied URL
 * (the playback proxy and the host extractors).
 *
 * Two layers:
 *   1. `guardUrl` — a cheap up-front scheme + literal-host check that also
 *      normalises the sneaky IPv4 encodings (decimal `2130706433`, hex, octal)
 *      and IPv4-mapped IPv6 so `http://2130706433/` can't smuggle 127.0.0.1 past.
 *   2. `ssrfAgents` — http(s) agents whose DNS `lookup` rejects any hostname
 *      that RESOLVES to a private/loopback/link-local address. This is the part
 *      that actually stops (a) DNS rebinding and (b) a public URL that
 *      302-redirects to an internal target — every socket connection, including
 *      redirect hops, resolves through this guard.
 */

// ── IP classification ─────────────────────────────────────────────────────────
const isPrivateV4 = (a: number, b: number): boolean =>
    a === 127 || a === 10 || a === 0 ||
    (a === 169 && b === 254) ||          // link-local + cloud metadata (169.254.169.254)
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127);  // CGNAT

/** Parse a bare IPv4 in dotted / decimal / hex / octal form → [a,b,c,d], or null. */
const parseV4 = (h: string): [number, number, number, number] | null => {
    // dotted quad
    const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (dotted) {
        const o = dotted.slice(1).map(Number);
        if (o.every((n) => n <= 255)) return o as [number, number, number, number];
        return null;
    }
    // single-integer forms: decimal (2130706433), hex (0x7f000001), octal (017700000001)
    let n: number | null = null;
    if (/^0x[0-9a-f]+$/i.test(h)) n = parseInt(h, 16);
    else if (/^0[0-7]+$/.test(h)) n = parseInt(h, 8);
    else if (/^\d+$/.test(h)) n = parseInt(h, 10);
    if (n === null || !Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
};

/** True if an ADDRESS (already an IP literal) points somewhere internal. */
export const isPrivateAddress = (addr: string): boolean => {
    let h = addr.toLowerCase().replace(/^\[|\]$/g, '').replace(/%.+$/, ''); // strip brackets + zone id
    // IPv4-mapped / -compatible IPv6 → test the embedded v4
    const mappedDot = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(h);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
    if (mappedDot) {
        h = mappedDot[1];                                   // ::ffff:127.0.0.1
    } else if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16);              // ::ffff:7f00:0001 → 127.0.0.1
        return isPrivateV4((hi >> 8) & 255, hi & 255);
    }
    if (h.includes(':')) {
        // IPv6: loopback ::1, unspecified ::, link-local fe80::/10, ULA fc00::/7
        if (h === '::1' || h === '::') return true;
        if (/^fe[89ab][0-9a-f]?:/i.test(h) || /^f[cd][0-9a-f]{2}:/i.test(h)) return true;
        return false;
    }
    const v4 = parseV4(h);
    if (v4) return isPrivateV4(v4[0], v4[1]);
    return false;
};

/** True if a HOST (name or IP) is one we must never fetch server-side. */
export const isBlockedHost = (host: string): boolean => {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    return isPrivateAddress(h);
};

/** Validate a caller-supplied URL. Returns a reason string when blocked, else null. */
export const guardUrl = (raw: string): string | null => {
    let u: URL;
    try { u = new URL(raw); } catch { return 'bad url'; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'blocked scheme';
    if (isBlockedHost(u.hostname)) return 'blocked host';
    return null;
};

// ── guarded DNS lookup + agents ───────────────────────────────────────────────
const guardedLookup: LookupFunction = ((hostname: string, options: any, cb: any) => {
    const base = dohEnabled ? dohLookup : (dns.lookup as LookupFunction);
    const check = (addr: string) => isPrivateAddress(addr);
    base(hostname, { ...(typeof options === 'object' ? options : {}) }, ((err: any, address: any, family: any) => {
        if (err) return cb(err);
        if (Array.isArray(address)) {
            const bad = address.find((r: any) => check(r.address));
            if (bad) return cb(new Error(`blocked private address ${bad.address}`));
            return cb(null, address);
        }
        if (check(address)) return cb(new Error(`blocked private address ${address}`));
        cb(null, address, family);
    }) as any);
}) as LookupFunction;

const guardedHttp = new http.Agent({ lookup: guardedLookup, keepAlive: true });
const guardedHttps = new https.Agent({ lookup: guardedLookup, keepAlive: true });

/** Agents that reject any connection resolving to a private/loopback IP. Attach
 *  to axios (`httpAgent`/`httpsAgent`) on every proxy/scrape fetch so redirects
 *  and DNS-rebinding can't reach the internal network. */
export const ssrfAgents = (): { httpAgent: http.Agent; httpsAgent: https.Agent } =>
    ({ httpAgent: guardedHttp, httpsAgent: guardedHttps });
