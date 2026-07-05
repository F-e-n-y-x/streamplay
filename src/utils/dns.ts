import http from 'http';
import https from 'https';
import dns from 'dns';
import axios from 'axios';
import type { LookupFunction } from 'net';

/**
 * DNS-over-HTTPS (DoH) resolver.
 *
 * Many provider CDNs fail to resolve on a NAS/home network because the local or
 * ISP resolver blocks / poisons them (this shows up as `/api/proxy` 502s with
 * ENOTFOUND / EAI_AGAIN). Routing name resolution over HTTPS to a public
 * resolver (Google / Cloudflare / Quad9) sidesteps that.
 *
 * Enable with `DOH_ENABLED=true` in `.env`. Everything else has sane defaults.
 *   DOH_ENABLED       true|false                     (default: false)
 *   DOH_PROVIDER      google|cloudflare|quad9         (default: google)
 *   DOH_URL           override the JSON endpoint      (optional)
 *   DOH_BOOTSTRAP_IP  IP of the DoH host itself       (optional; presets cover the defaults)
 *
 * The DoH endpoint is reached by a hard-coded bootstrap IP so it works even when
 * the system resolver is completely broken — and provider lookups never recurse
 * back into DoH (only the shared agents below use the DoH lookup).
 */

const truthy = (v?: string) => /^(1|true|yes|on)$/i.test(v || '');
export const dohEnabled = truthy(process.env.DOH_ENABLED);

const PROVIDER = (process.env.DOH_PROVIDER || 'google').toLowerCase();
const PRESETS: Record<string, { url: string; ip: string }> = {
    google: { url: 'https://dns.google/resolve', ip: '8.8.8.8' },
    cloudflare: { url: 'https://cloudflare-dns.com/dns-query', ip: '1.1.1.1' },
    quad9: { url: 'https://dns.quad9.net:5053/dns-query', ip: '9.9.9.9' },
};
const preset = PRESETS[PROVIDER] || PRESETS.google;
const DOH_URL = process.env.DOH_URL || preset.url;
const DOH_HOST = (() => { try { return new URL(DOH_URL).hostname; } catch { return 'dns.google'; } })();
const DOH_BOOTSTRAP_IP = process.env.DOH_BOOTSTRAP_IP || preset.ip;

const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

// --- Reach the DoH endpoint itself without depending on the system resolver. ---
const bootstrapLookup: LookupFunction = ((hostname: string, options: any, cb: any) => {
    if (hostname === DOH_HOST && DOH_BOOTSTRAP_IP) {
        const rec = { address: DOH_BOOTSTRAP_IP, family: 4 };
        return typeof options === 'object' && options?.all ? cb(null, [rec]) : cb(null, rec.address, rec.family);
    }
    return dns.lookup(hostname, options, cb);
}) as LookupFunction;
const bootstrapAgent = new https.Agent({ lookup: bootstrapLookup, keepAlive: true });
const dohClient = axios.create({ timeout: 8000, httpsAgent: bootstrapAgent, headers: { Accept: 'application/dns-json' } });

interface CacheEntry { ips: { address: string; family: number }[]; expires: number }
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<{ address: string; family: number }[]>>();
const now = () => Date.now();

async function resolveDoH(hostname: string): Promise<{ address: string; family: number }[]> {
    if (isIp(hostname)) return [{ address: hostname, family: hostname.includes(':') ? 6 : 4 }];
    const hit = cache.get(hostname);
    if (hit && hit.expires > now()) return hit.ips;
    // In-flight dedup: concurrent first-time lookups of the same host share ONE DoH
    // request instead of each firing their own (a stampede on a cold cache).
    const pending = inflight.get(hostname);
    if (pending) return pending;

    const task = (async () => {
        try {
            const res = await dohClient.get(DOH_URL, { params: { name: hostname, type: 'A' } });
            const answers: any[] = res.data?.Answer || [];
            const aRecords = answers.filter((a) => a.type === 1 && a.data);
            const ips = aRecords.map((a) => ({ address: String(a.data), family: 4 }));
            // Positives: honour TTL (30-300s). Negatives (DoH answered but no A record):
            // cache empty briefly so a dead host doesn't re-hit DoH on every request —
            // dohLookup treats [] as "fall back to the system resolver".
            const ttl = ips.length ? Math.max(30, Math.min(300, ...aRecords.map((a) => Number(a.TTL) || 300))) : 30;
            cache.set(hostname, { ips, expires: now() + ttl * 1000 });
            return ips;
        } finally {
            inflight.delete(hostname);
        }
    })();
    inflight.set(hostname, task);
    return task;
}

// Node-compatible lookup that resolves via DoH and falls back to the system
// resolver on any failure, so a DoH hiccup never makes things worse.
// Exported so the SSRF guard (utils/ssrf.ts) can reuse DoH resolution while
// rejecting private/loopback targets at connection time.
export const dohLookup: LookupFunction = ((hostname: string, options: any, cb: any) => {
    const wantAll = typeof options === 'object' && options?.all;
    const fallback = () => dns.lookup(hostname, options, cb);
    resolveDoH(hostname)
        .then((ips) => {
            if (!ips.length) return fallback();
            if (wantAll) return cb(null, ips);
            cb(null, ips[0].address, ips[0].family);
        })
        .catch(fallback);
}) as LookupFunction;

/**
 * Shared keep-alive agents that resolve via DoH. `undefined` when DoH is off, so
 * callers can spread them into an axios config unconditionally and get default
 * behaviour when disabled.
 */
export const httpAgent = dohEnabled ? new http.Agent({ lookup: dohLookup, keepAlive: true }) : undefined;
export const httpsAgent = dohEnabled ? new https.Agent({ lookup: dohLookup, keepAlive: true }) : undefined;

/** Spread into any axios request/instance config to route DNS through DoH. */
export const dohAxios = (): { httpAgent?: http.Agent; httpsAgent?: https.Agent } =>
    dohEnabled ? { httpAgent, httpsAgent } : {};

if (dohEnabled) {
    // eslint-disable-next-line no-console
    console.log(`[dns] DoH enabled via ${DOH_HOST} (${DOH_URL})`);
}
