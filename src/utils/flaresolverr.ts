import axios from 'axios';
import { warpFlareSolverrEndpoint } from './warp';
import { currentSignal } from './reqctx';

/**
 * Client for FlareSolverr (https://github.com/FlareSolverr/FlareSolverr).
 *
 * FlareSolverr runs a real headless browser and solves Cloudflare / DDoS-Guard
 * challenges, returning the final HTML plus the `cf_clearance` cookies and the
 * user-agent that must be reused for follow-up requests.
 *
 * POOL: a single FlareSolverr is ONE browser, so it becomes the bottleneck when
 * many providers need it at once (Cloudflare solves are slow, and it 500s /
 * serializes under load — the cause of anime sources timing out). `FLARESOLVERR_URL`
 * therefore accepts a comma/space-separated LIST of instances; we round-robin
 * across them so concurrent solves fan out over several browsers. A single URL
 * still works exactly as before.
 *   FLARESOLVERR_URL=http://fs1:8191/,http://fs2:8191/,http://fs3:8191/
 */

const ENDPOINTS = (process.env.FLARESOLVERR_URL || '')
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter(Boolean)
    .map((u) => `${u.replace(/\/+$/, '')}/v1`);

// ── Per-instance dispatch queue ──────────────────────────────────────────────
// A FlareSolverr instance is a SINGLE browser: hit one with concurrent solves and
// they serialize internally and, under load, 500 / time out (a real cause of anime
// sources stalling). So we run at most ONE solve per instance at a time and QUEUE
// the rest, dispatching each waiting solve to the LEAST-LOADED instance. Net effect:
// with N instances, at most N solves run at once (one per browser); the rest wait
// their turn instead of bombarding a busy browser.
const load = new Map<string, number>();          // endpoint -> queued + in-flight count
const tail = new Map<string, Promise<void>>();    // endpoint -> FIFO serialization chain

const leastLoaded = (endpoints: string[]): string =>
    endpoints.reduce((best, e) => ((load.get(e) || 0) < (load.get(best) || 0) ? e : best), endpoints[0]);

/**
 * The endpoint to solve on. When WARP is active and a WARP-behind FlareSolverr is
 * configured, use THAT (its browser egresses through a clean IP — this is what
 * unblocks Kwik, and it must stay pinned so cf_clearance matches the follow-ups).
 * Otherwise pick the least-loaded instance of the normal pool.
 */
const pickEndpoint = (): string | null => {
    const warp = warpFlareSolverrEndpoint();
    if (warp) return warp;
    return ENDPOINTS.length ? leastLoaded(ENDPOINTS) : null;
};

/** Run `fn` on `endpoint`, at most one job per endpoint at a time (FIFO queue). */
async function runOn<T>(endpoint: string, fn: () => Promise<T>): Promise<T> {
    load.set(endpoint, (load.get(endpoint) || 0) + 1);
    const prev = tail.get(endpoint) || Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    tail.set(endpoint, prev.then(() => mine));
    await prev.catch(() => { /* a prior job's failure must not wedge the queue */ });
    try {
        return await fn();
    } finally {
        release();
        load.set(endpoint, Math.max(0, (load.get(endpoint) || 1) - 1));
    }
}

/** How many solves are queued/running per instance (diagnostics). */
export const flareSolverrLoad = (): Record<string, number> => Object.fromEntries(load);

export const isFlareSolverrConfigured = (): boolean =>
    ENDPOINTS.length > 0 || !!warpFlareSolverrEndpoint();

/** The configured FlareSolverr /v1 endpoints (for diagnostics). */
export const flareSolverrEndpoints = (): string[] => [...ENDPOINTS];

/**
 * Diagnostics probe for ONE solver endpoint (FlareSolverr or Byparr): a real solve of
 * an IP-echo — proves it works AND shows the egress IP (WARP vs direct). Byparr ignores
 * `cmd`, so a `sessions.list` liveness check would wrongly report it down.
 */
export const probeFlareSolverr = async (endpoint: string): Promise<{ up: boolean; latencyMs: number; version?: string; ip?: string; error?: string }> => {
    const start = Date.now();
    try {
        const r = await axios.post(endpoint, { cmd: 'request.get', url: 'https://api.ipify.org?format=json', maxTimeout: 25000 }, { timeout: 40000 });
        const body: string = r.data?.solution?.response || '';
        const ip = (body.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/) || [])[1];
        return { up: r.data?.status === 'ok' || !!body, latencyMs: Date.now() - start, version: r.data?.version, ip };
    } catch (e: any) {
        return { up: false, latencyMs: Date.now() - start, error: String(e?.code || e?.message || e).slice(0, 60) };
    }
};

if (ENDPOINTS.length > 1) {
    // eslint-disable-next-line no-console
    console.log(`[FlareSolverr] load-balancing across ${ENDPOINTS.length} instances`);
}

export interface FlareSolverrSolution {
    url: string;
    status: number;
    html: string;
    cookies: Array<{ name: string; value: string; domain?: string }>;
    userAgent: string;
    /** Cookies pre-formatted as a `Cookie:` header value. */
    cookieHeader: string;
}

const cookiesToHeader = (cookies: Array<{ name: string; value: string }>): string =>
    cookies.map(c => `${c.name}=${c.value}`).join('; ');

/**
 * Solve a GET request through FlareSolverr.
 * Returns null if FlareSolverr is not configured or the request fails.
 */
/**
 * Fetch the solved HTML for a URL. SESSIONLESS by design.
 *
 * We used to reuse one persistent FlareSolverr session across every anime call to
 * keep challenge cookies warm — but a FlareSolverr session is a single browser, so
 * when several providers (AniZone + AnimePahe + AnimeWorld) hit that one session
 * concurrently the requests serialized and mostly failed (this was the real cause
 * of anime sources appearing only after 1-2 min, or not at all). Every request.get
 * solves the challenge fresh anyway, so we simply issue an independent, sessionless
 * solve here — exactly what safeGet/the Indian scrapers do, and they resolve
 * concurrently without stepping on each other. One retry on a transient failure.
 */
export const flareSolverrGetHtml = async (url: string, maxTimeout = 60000): Promise<string | null> => {
    if (!isFlareSolverrConfigured()) return null;
    // Each attempt queues on its instance (one solve per browser) and, when not
    // WARP-pinned, is dispatched to the least-loaded instance so we spread instead of
    // bombarding one browser.
    const attempt = async (endpoint: string): Promise<any> => {
        try {
            return await runOn(endpoint, async () => {
                const r = await axios.post(
                    endpoint, { cmd: 'request.get', url, maxTimeout },
                    { headers: { 'Content-Type': 'application/json' }, timeout: maxTimeout + 15000, signal: currentSignal() as any },
                );
                return r.data;
            });
        } catch (e: any) { console.error('[FlareSolverr] request failed:', e?.message || e); return null; }
    };
    const ep1 = pickEndpoint();
    if (!ep1) return null;
    let data = await attempt(ep1);
    if (!data || data.status !== 'ok' || (data.solution && data.solution.status >= 500)) {
        // One retry — re-picks the least-loaded instance (a different one if free),
        // except under WARP where the endpoint stays pinned for IP consistency.
        data = await attempt(pickEndpoint() || ep1);
    }
    return data?.status === 'ok' ? (data.solution?.response ?? null) : null;
};

export const flareSolverrGet = async (
    url: string,
    maxTimeout = 60000
): Promise<FlareSolverrSolution | null> => {
    const endpoint = pickEndpoint();
    if (!endpoint) return null;

    try {
        const res = await runOn(endpoint, () => axios.post(
            endpoint,
            { cmd: 'request.get', url, maxTimeout },
            { headers: { 'Content-Type': 'application/json' }, timeout: maxTimeout + 15000, signal: currentSignal() as any }
        ));

        const sol = res.data?.solution;
        if (res.data?.status !== 'ok' || !sol) return null;

        const cookies = sol.cookies ?? [];
        return {
            url: sol.url,
            status: sol.status,
            html: sol.response ?? '',
            cookies,
            userAgent: sol.userAgent ?? '',
            cookieHeader: cookiesToHeader(cookies)
        };
    } catch (e: any) {
        console.error('[FlareSolverr] request failed:', e?.message || e);
        return null;
    }
};
