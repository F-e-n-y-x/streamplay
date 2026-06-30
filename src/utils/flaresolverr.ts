import axios from 'axios';

/**
 * Client for a FlareSolverr instance (https://github.com/FlareSolverr/FlareSolverr).
 *
 * FlareSolverr runs a real headless browser and solves Cloudflare / DDoS-Guard
 * challenges, returning the final HTML plus the `cf_clearance` cookies and the
 * user-agent that must be reused for follow-up requests.
 *
 * The endpoint is configured via FLARESOLVERR_URL in `.env` so it can be moved
 * without touching code.
 */

const RAW_URL = process.env.FLARESOLVERR_URL?.trim();
// Normalise to the /v1 endpoint FlareSolverr exposes.
const ENDPOINT = RAW_URL ? `${RAW_URL.replace(/\/+$/, '')}/v1` : null;

export const isFlareSolverrConfigured = (): boolean => !!ENDPOINT;

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
export const flareSolverrGet = async (
    url: string,
    maxTimeout = 60000
): Promise<FlareSolverrSolution | null> => {
    if (!ENDPOINT) return null;

    try {
        const res = await axios.post(
            ENDPOINT,
            { cmd: 'request.get', url, maxTimeout },
            { headers: { 'Content-Type': 'application/json' }, timeout: maxTimeout + 15000 }
        );

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
