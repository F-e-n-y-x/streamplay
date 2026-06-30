import { app } from './http';
import type { CheerioAPI } from 'cheerio';

/** getBaseUrl(): protocol + host of a URL. */
export const getBaseUrl = (url: string): string => {
    try { const u = new URL(url); return `${u.protocol}//${u.host}`; } catch { return ''; }
};

/** fixUrl(): resolve a possibly-relative path against a base. */
export const fixUrl = (path: string, base: string): string => {
    if (!path) return '';
    if (/^https?:/i.test(path)) return path;
    if (path.startsWith('//')) return 'https:' + path;
    return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
};

const getFormUrl = ($: CheerioAPI): string => $('form#landing').attr('action') || '';

const getFormData = ($: CheerioAPI): Record<string, string> => {
    const out: Record<string, string> = {};
    $('form#landing input').each((_, el) => {
        const name = $(el).attr('name');
        if (name) out[name] = $(el).attr('value') || '';
    });
    return out;
};

/**
 * bypassHrefli — ported from StreamPlayUtils.kt bypassHrefli().
 *
 * Walks the two-step `form#landing` POST chain used by href.li / unblockedgames
 * style gateways, then resolves the `?go=` token + meta-refresh redirect to the
 * real drive URL. Returns null on any dead end. Never throws.
 */
export const bypassHrefli = async (url: string): Promise<string | null> => {
    try {
        const host = getBaseUrl(url);

        let $ = (await app.get(url)).document;
        let formUrl = getFormUrl($);
        let formData = getFormData($);

        $ = (await app.post(formUrl, new URLSearchParams(formData), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        })).document;
        formUrl = getFormUrl($);
        formData = getFormData($);

        const res2 = await app.post(formUrl, new URLSearchParams(formData), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        // script containing "?go=<token>"
        let skToken: string | null = null;
        const $2 = res2.document;
        $2('script').each((_, el) => {
            const d = $2(el).html() || '';
            if (skToken == null && d.includes('?go=')) {
                skToken = d.split('?go=')[1]?.split('"')[0] || null;
            }
        });
        if (!skToken) return null;

        const wpHttp2 = formData['_wp_http2'] || '';
        const goRes = await app.get(`${host}?go=${skToken}`, {
            headers: { Cookie: `${skToken}=${wpHttp2}` },
        });
        const content = goRes.document('meta[http-equiv=refresh]').attr('content') || '';
        const driveUrl = content.includes('url=') ? content.split('url=')[1] : null;
        if (!driveUrl) return null;

        const finalText = (await app.get(driveUrl)).text;
        const path = finalText.includes('replace("')
            ? finalText.split('replace("')[1]?.split('")')[0] || ''
            : '';
        if (!path || path === '/404') return null;
        return fixUrl(path, getBaseUrl(driveUrl));
    } catch {
        return null;
    }
};
