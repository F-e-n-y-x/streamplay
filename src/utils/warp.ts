import { AsyncLocalStorage } from 'async_hooks';
import axios from 'axios';
import type http from 'http';

// socks-proxy-agent ships an `exports` map that this project's classic CommonJS
// module resolution can't see at the type level; require it at runtime (the
// project emits CommonJS, so this is exactly how it loads anyway).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { SocksProxyAgent } = require('socks-proxy-agent') as { SocksProxyAgent: new (url: string, opts?: any) => http.Agent };

/**
 * Cloudflare WARP proxy support.
 *
 * Some hosts hard-block a home/datacenter egress IP (e.g. Kwik/AnimePahe returns
 * "your IP is banned for this site"), or an ISP/NAS DNS poisons provider CDNs.
 * Routing outbound traffic through a Cloudflare WARP proxy (e.g. the warp-docker
 * container, https://github.com/cmj2002/warp-docker) gives a clean egress IP that
 * usually clears both problems.
 *
 * WARP is opt-in and has FOUR modes, chosen from the Settings page (sent per
 * request) or via WARP_MODE as the default:
 *   off       — never use WARP.
 *   required  — only providers that declare `requiresWarp` use it (e.g. AnimePahe).
 *   fallback  — try normally first; if a provider yields nothing, retry via WARP.
 *   all       — route every provider request through WARP.
 *
 * Two independent transports (either/both can be configured):
 *   WARP_PROXY_URL         a SOCKS5 (or http) proxy for our DIRECT node requests,
 *                          e.g. socks5://192.168.10.10:1080  (warp-docker default).
 *   WARP_FLARESOLVERR_URL  a FlareSolverr instance whose container egresses through
 *                          WARP — used for the Cloudflare SOLVE step (this is what
 *                          fixes Kwik, since the block happens in the browser solve,
 *                          not our direct request).
 *
 * The active MODE is carried per-request via AsyncLocalStorage so the existing
 * `app`/`safeGet`/FlareSolverr helpers can consult it without every provider having
 * to thread a context argument through.
 */

export type WarpMode = 'off' | 'required' | 'fallback' | 'all';

const VALID: WarpMode[] = ['off', 'required', 'fallback', 'all'];
export const DEFAULT_WARP_MODE: WarpMode =
    VALID.includes((process.env.WARP_MODE || '').trim() as WarpMode) ? (process.env.WARP_MODE!.trim() as WarpMode) : 'off';

// WARP transports. Both accept a comma/space-separated LIST so you can run several
// warp+flaresolverr PAIRS (one SOCKS proxy + one WARP-backed FlareSolverr per WARP
// instance, index-matched). We pin ONE pair per provider invocation (round-robin),
// so a provider's FlareSolverr SOLVE and its own follow-up requests egress through
// the SAME WARP IP — which the cf_clearance that multi-step scrapers reuse requires
// — while different providers spread across the pairs.
const parseList = (v?: string) => (v || '').split(/[\s,]+/).map((u) => u.trim()).filter(Boolean);
const WARP_SOCKS_URLS = parseList(process.env.WARP_PROXY_URL);
const WARP_FS_ENDPOINTS = parseList(process.env.WARP_FLARESOLVERR_URL).map((u) => `${u.replace(/\/+$/, '')}/v1`);
const PAIR_COUNT = Math.max(WARP_SOCKS_URLS.length, WARP_FS_ENDPOINTS.length);
let pairRR = 0;

/** Is any WARP transport configured at all? (drives whether the UI toggle does anything) */
export const warpConfigured = (): boolean => PAIR_COUNT > 0;

export const normalizeWarpMode = (m?: string): WarpMode =>
    VALID.includes((m || '') as WarpMode) ? (m as WarpMode) : DEFAULT_WARP_MODE;

interface WarpCtx {
    mode: WarpMode;
    /** provider declared it needs WARP (for `required` mode). */
    requiresWarp?: boolean;
    /** set during a `fallback`-mode retry to force this pass through WARP. */
    forceWarp?: boolean;
    /** WARP pair pinned for this invocation (assigned lazily on first WARP use). */
    pairIndex?: number;
}

const als = new AsyncLocalStorage<WarpCtx>();

/** Run `fn` with a WARP context so nested app/safeGet calls can consult it. */
export const runWithWarp = <T>(ctx: WarpCtx, fn: () => T): T => als.run(ctx, fn);

/** Should the request currently in flight be routed through WARP? */
export const warpActive = (): boolean => {
    if (!warpConfigured()) return false;
    const s = als.getStore();
    const mode = s?.mode ?? DEFAULT_WARP_MODE;
    if (mode === 'all') return true;
    if (mode === 'required') return !!s?.requiresWarp;
    if (mode === 'fallback') return !!s?.forceWarp;
    return false;
};

// --- SOCKS agents, one per WARP proxy (lazy) ---
const socksAgents: (http.Agent | undefined)[] = [];
const getSocksAgent = (i: number): http.Agent | undefined => {
    if (!WARP_SOCKS_URLS.length) return undefined;
    const idx = i % WARP_SOCKS_URLS.length;
    if (!socksAgents[idx]) {
        // Force socks5h (remote DNS): resolve hostnames AT the WARP proxy, not on the
        // local container. Otherwise a host the ISP resolver blocks/poisons (e.g.
        // short.icu) fails with ENOTFOUND even though WARP could reach it — which
        // defeats the whole purpose of routing through WARP.
        const url = WARP_SOCKS_URLS[idx].replace(/^socks5?:\/\//i, 'socks5h://');
        socksAgents[idx] = new SocksProxyAgent(url, { keepAlive: true });
    }
    return socksAgents[idx];
};

/**
 * The WARP pair index pinned for the current invocation. Assigned once (round-robin)
 * on first use and stored on the ALS ctx, so every WARP request within one provider
 * run — the FlareSolverr solve AND StreamPlay's own follow-ups — uses the same WARP.
 */
const pairIndex = (): number => {
    const s = als.getStore();
    const pick = () => pairRR++ % (PAIR_COUNT || 1);
    if (!s) return pick();
    if (s.pairIndex == null) s.pairIndex = pick();
    return s.pairIndex;
};

/**
 * Axios agent override for the current request: this invocation's WARP SOCKS agent
 * when WARP is active AND a proxy is configured, else null (caller uses DoH agents).
 */
export const warpAxios = (): { httpAgent: http.Agent; httpsAgent: http.Agent } | null => {
    if (!warpActive() || !WARP_SOCKS_URLS.length) return null;
    const a = getSocksAgent(pairIndex());
    return a ? { httpAgent: a, httpsAgent: a } : null;
};

/** The FlareSolverr endpoint to SOLVE with right now: this invocation's WARP-backed
 *  instance when WARP is active, else null (caller uses its normal pool). */
export const warpFlareSolverrEndpoint = (): string | null => {
    if (!warpActive() || !WARP_FS_ENDPOINTS.length) return null;
    return WARP_FS_ENDPOINTS[pairIndex() % WARP_FS_ENDPOINTS.length];
};

/**
 * A WARP SOCKS agent for the playback proxy to RETRY with (round-robin), or null if
 * no SOCKS proxy is configured. `/api/proxy` fetches direct by default (fast, and the
 * proxy has no per-request WARP context); when a host is blocked/poisoned on the
 * direct egress (e.g. AnimeWorld's zephyrflick CDN) it retries through this.
 */
export const proxyWarpAgent = (): http.Agent | null => {
    if (!WARP_SOCKS_URLS.length) return null;
    return getSocksAgent(pairRR++) || null;
};

/** Config snapshot for diagnostics. */
export const warpConfig = () => ({ mode: DEFAULT_WARP_MODE, socks: [...WARP_SOCKS_URLS], flaresolverr: [...WARP_FS_ENDPOINTS] });

/**
 * Diagnostics probe for ONE WARP SOCKS proxy: reach an IP-echo THROUGH the proxy
 * and report the egress IP + latency. This is how you confirm StreamPlay's own
 * requests are actually leaving via WARP (the IP should be a Cloudflare WARP IP,
 * not your home/NAS IP).
 */
export const probeWarpSocks = async (socksUrl: string): Promise<{ up: boolean; latencyMs: number; ip?: string; error?: string }> => {
    const start = Date.now();
    try {
        const agent = new SocksProxyAgent(socksUrl, { timeout: 8000 });
        const r = await axios.get('https://api.ipify.org?format=json', { httpAgent: agent, httpsAgent: agent, timeout: 10000 });
        return { up: true, latencyMs: Date.now() - start, ip: r.data?.ip };
    } catch (e: any) {
        return { up: false, latencyMs: Date.now() - start, error: String(e?.code || e?.message || e).slice(0, 60) };
    }
};

if (warpConfigured()) {
    // eslint-disable-next-line no-console
    console.log(`[warp] configured — default mode: ${DEFAULT_WARP_MODE}, ${PAIR_COUNT} pair(s) (${WARP_SOCKS_URLS.length} socks, ${WARP_FS_ENDPOINTS.length} flaresolverr)`);
    if (WARP_SOCKS_URLS.length && WARP_FS_ENDPOINTS.length && WARP_SOCKS_URLS.length !== WARP_FS_ENDPOINTS.length) {
        // eslint-disable-next-line no-console
        console.warn(`[warp] WARN: WARP_PROXY_URL (${WARP_SOCKS_URLS.length}) and WARP_FLARESOLVERR_URL (${WARP_FS_ENDPOINTS.length}) have different lengths — pairs won't line up index-for-index, so a provider's solve and its follow-up may egress through different WARP IPs (breaks cf_clearance reuse). Use equal-length, index-matched lists.`);
    }
}
