import axios, { AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';
import { flareSolverrGet, isFlareSolverrConfigured } from './flaresolverr';
import { USER_AGENT } from './encdec';

/**
 * Thin HTTP layer mirroring the Kotlin plugin's `app` / `safeGet` helpers so the
 * ported providers read the same way.
 *
 *   app.get(url).text        -> response body
 *   app.get(url).document    -> cheerio root ($)
 *   app.get(url).json()      -> parsed JSON
 *
 * `safeGet` additionally routes through FlareSolverr when a Cloudflare challenge
 * is detected (or forced via `{ cloudflare: true }`).
 */

export interface SpResponse {
    status: number;
    text: string;
    url: string;
    cookieHeader?: string;
    /** Response headers (lower-cased keys), e.g. for location / hx-redirect. */
    responseHeaders: Record<string, string>;
    /** Parsed JSON body, or null if the body is not JSON. */
    json: <T = any>() => T | null;
    /** Cheerio root for HTML scraping. */
    document: cheerio.CheerioAPI;
    isSuccessful: boolean;
}

const buildResponse = (status: number, text: string, url: string, cookieHeader?: string, responseHeaders: Record<string, string> = {}): SpResponse => ({
    status,
    text,
    url,
    cookieHeader,
    responseHeaders,
    isSuccessful: status >= 200 && status < 300,
    json: <T = any>(): T | null => {
        try { return JSON.parse(text) as T; } catch { return null; }
    },
    get document() { return cheerio.load(text); }
} as SpResponse);

const DEFAULT_HEADERS = { 'User-Agent': USER_AGENT };

/**
 * Per-domain Cloudflare cookie jar. When FlareSolverr solves a challenge we
 * stash its cf_clearance cookies + matching User-Agent here, keyed by hostname,
 * and replay them on every subsequent request to that host. This mirrors the
 * Kotlin CloudflareKiller interceptor, which persists clearance across calls,
 * and is what lets multi-step scrapers (search page -> detail -> download) work.
 */
const cookieJar = new Map<string, { cookie: string; userAgent: string }>();

const hostOf = (url: string): string => {
    try { return new URL(url).hostname; } catch { return ''; }
};

export const setClearance = (url: string, cookie: string, userAgent: string) => {
    const host = hostOf(url);
    if (host && cookie) cookieJar.set(host, { cookie, userAgent });
};

const clearanceFor = (url: string) => cookieJar.get(hostOf(url));

const looksLikeCloudflare = (status: number, text: string): boolean =>
    status === 403 || status === 503 ||
    text.includes('Just a moment') ||
    text.includes('cf-browser-verification') ||
    text.includes('Checking your browser') ||
    text.includes('__cf_chl');

export interface GetOptions {
    headers?: Record<string, string>;
    timeout?: number;
    referer?: string;
    /** Force routing through FlareSolverr. */
    cloudflare?: boolean;
    params?: Record<string, any>;
}

const doRequest = async (config: AxiosRequestConfig): Promise<SpResponse> => {
    const res = await axios({
        ...config,
        // accept all statuses so we can inspect Cloudflare bodies instead of throwing
        validateStatus: () => true,
        // don't auto-follow redirects when the caller wants the location header
        transformResponse: r => r, // keep raw text
    });
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    const respHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers || {})) {
        respHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return buildResponse(res.status, text, config.url || '', undefined, respHeaders);
};

/** Merge any stored Cloudflare clearance (cookie + UA) for this URL's host. */
const withClearance = (url: string, headers: Record<string, string>): Record<string, string> => {
    const clz = clearanceFor(url);
    if (!clz) return headers;
    const existingCookie = headers['Cookie'] || headers['cookie'];
    return {
        ...headers,
        'User-Agent': clz.userAgent || headers['User-Agent'],
        Cookie: existingCookie ? `${existingCookie}; ${clz.cookie}` : clz.cookie,
    };
};

export const app = {
    get: async (url: string, opts: GetOptions = {}): Promise<SpResponse> => {
        const headers = withClearance(url, { ...DEFAULT_HEADERS, ...(opts.referer ? { Referer: opts.referer } : {}), ...opts.headers });
        return doRequest({ method: 'get', url, headers, timeout: opts.timeout ?? 15000, params: opts.params });
    },
    post: async (url: string, body?: any, opts: GetOptions = {}): Promise<SpResponse> => {
        const headers = withClearance(url, { ...DEFAULT_HEADERS, ...(opts.referer ? { Referer: opts.referer } : {}), ...opts.headers });
        return doRequest({ method: 'post', url, headers, data: body, timeout: opts.timeout ?? 15000 });
    },
};

/**
 * Cloudflare-aware GET. Tries a normal request first; if a challenge is detected
 * (or `cloudflare: true`), it re-fetches through FlareSolverr and returns the
 * solved HTML. The solved cookies are exposed on `cookieHeader` for follow-ups.
 */
export const safeGet = async (url: string, opts: GetOptions = {}): Promise<SpResponse> => {
    // Fast path: a normal request (auto-attaching any clearance we already hold).
    // If it isn't a challenge page, we're done — this also covers the case where
    // a previous FlareSolverr solve already primed the cookie jar for this host.
    try {
        const res = await app.get(url, opts);
        if (!looksLikeCloudflare(res.status, res.text)) return res;
    } catch { /* fall through to FlareSolverr */ }

    if (isFlareSolverrConfigured()) {
        const solved = await flareSolverrGet(url);
        if (solved) {
            // Persist clearance so follow-up app.get/post calls to this host succeed.
            setClearance(url, solved.cookieHeader, solved.userAgent);
            return buildResponse(solved.status, solved.html, solved.url, solved.cookieHeader);
        }
    }

    // Last resort: a plain GET (may still be a challenge page, but lets callers proceed/log).
    return app.get(url, opts);
};
