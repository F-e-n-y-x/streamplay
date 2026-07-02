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
/**
 * Persistent-session variant. Some sites (AnimePahe's DDoS-Guard XHR API, AniZone,
 * AllAnime) only stay unblocked when the *same* FlareSolverr browser session is
 * reused across requests, so its challenge cookies persist. We keep one session
 * alive and recreate it on error. Returns the solved HTML (or null).
 */
let sessionId: string | null = null;
let sessionCreating: Promise<string | null> | null = null;   // in-flight create, shared to avoid races

const createSession = async (): Promise<string | null> => {
    if (!ENDPOINT) return null;
    if (sessionId) return sessionId;
    // Coalesce concurrent callers onto one sessions.create so we don't spawn (and
    // leak) multiple FlareSolverr browser sessions under load.
    if (sessionCreating) return sessionCreating;
    sessionCreating = (async () => {
        try {
            const r = await axios.post(ENDPOINT!, { cmd: 'sessions.create' }, { timeout: 30000 });
            sessionId = r.data?.session || null;
            return sessionId;
        } catch { return null; }
        finally { sessionCreating = null; }
    })();
    return sessionCreating;
};

export const flareSolverrGetHtml = async (url: string, maxTimeout = 60000): Promise<string | null> => {
    if (!ENDPOINT) return null;
    const req = async (sid: string | null) => {
        const payload: any = { cmd: 'request.get', url, maxTimeout };
        if (sid) payload.session = sid;
        const r = await axios.post(ENDPOINT!, payload, { headers: { 'Content-Type': 'application/json' }, timeout: maxTimeout + 15000 });
        return r.data;
    };
    try {
        let sid = await createSession();
        let data: any;
        try {
            data = await req(sid);
        } catch {
            sessionId = null; sid = await createSession(); data = await req(sid);   // recover crashed session
        }
        if (data?.status !== 'ok' || (data.solution && data.solution.status >= 500)) {
            sessionId = null; sid = await createSession(); data = await req(sid);
        }
        return data?.status === 'ok' ? (data.solution?.response ?? null) : null;
    } catch (e: any) {
        console.error('[FlareSolverr] session request failed:', e?.message || e);
        sessionId = null;
        return null;
    }
};

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
