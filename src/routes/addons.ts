import { Router } from 'express';
import { CATALOG } from '../addons/catalog';
import { getText, parseManifest, nuvioScrapers } from '../extractors/nuvio';
import { parseStremioManifest } from '../extractors/stremio';
import { getAddonUrls, setScraperOverrides } from '../utils/serverConfig';

/**
 * Addon discovery + management (mounted at /api/addons):
 *   GET  /catalog   curated Nuvio repos + Stremio addons (src/addons/catalog.ts)
 *   POST /inspect   {url} → manifest preview; fetches JSON only, never runs scraper code
 *   GET  /scrapers  every scraper of every configured Nuvio repo, with its on/off state
 *   POST /scrapers  {changes: {[providerId]: true|false|null}} → per-scraper overrides
 * Writes (and inspect, which fetches an arbitrary URL) need ADMIN_TOKEN set + X-Admin-Token,
 * same rule as /api/config/{nuvio,stremio}.
 */
const router = Router();

const admin = (req: any, res: any): boolean => {
    if (!process.env.ADMIN_TOKEN) { res.status(403).json({ ok: false, error: 'set ADMIN_TOKEN on the server to manage addons from the UI' }); return false; }
    if (req.get('x-admin-token') !== process.env.ADMIN_TOKEN) { res.status(403).json({ ok: false, error: 'admin token required' }); return false; }
    return true;
};
const isAdmin = (req: any) => !!process.env.ADMIN_TOKEN && req.get('x-admin-token') === process.env.ADMIN_TOKEN;
// manifest URLs can embed tokens (debrid keys, PenguPlay auth) → full URL only for the admin
const maskUrl = (u: string) => { try { return `${new URL(u).origin}/…`; } catch { return '…'; } };

router.get('/catalog', (_req, res) => {
    const added = new Set([...getAddonUrls('nuvio'), ...getAddonUrls('stremio')]);
    // a configured addon is installed under the user's personal URL (same site, token in the path)
    const origin = (u: string) => { try { return new URL(u).origin; } catch { return u; } };
    const origins = new Set([...added].map(origin));
    res.json({ entries: CATALOG.map((e) => ({ ...e, added: added.has(e.manifestUrl) || (!!e.needsConfig && origins.has(origin(e.manifestUrl))) })) });
});

router.post('/inspect', async (req, res) => {
    if (!admin(req, res)) return;
    const url = req.body?.url;
    let ok = false;
    try { ok = typeof url === 'string' && /^https?:$/.test(new URL(url).protocol); } catch { /* invalid */ }
    if (!ok) return res.status(400).json({ ok: false, error: 'url must be an http(s) URL' });
    let m: any;
    try { m = JSON.parse(await getText(url)); } catch (e: any) {
        return res.status(422).json({ ok: false, error: `manifest not reachable or not JSON: ${String(e?.message || e).slice(0, 200)}` });
    }
    const added = getAddonUrls('nuvio').includes(url) || getAddonUrls('stremio').includes(url);
    const nuvioList = Array.isArray(m) || [m?.scrapers, m?.providers, m?.plugins].some(Array.isArray);
    if (nuvioList) {
        const p = parseManifest(m, true);
        if (!p.scrapers.length) return res.status(422).json({ ok: false, error: 'Nuvio manifest has no valid scrapers' });
        return res.json({
            ok: true, kind: 'nuvio', added, name: p.name, version: p.version, description: p.description,
            scrapers: p.scrapers.map(({ filename: _f, ...s }) => s),
            warnings: p.scrapers.some((s) => s.hasSettings) ? ['Some scrapers have settings (debrid keys etc.); StreamPlay runs them with empty SCRAPER_SETTINGS.'] : [],
        });
    }
    if (m && typeof m === 'object' && (Array.isArray(m.resources) || typeof m.id === 'string')) {
        const s = parseStremioManifest(m);
        if (!s.stream && !s.subtitles) return res.status(422).json({ ok: false, error: 'Stremio addon has no stream or subtitles resource (catalog/meta-only addons add nothing here)' });
        return res.json({
            ok: true, kind: 'stremio', added, name: s.name, version: typeof m.version === 'string' ? m.version : undefined,
            description: typeof m.description === 'string' ? m.description : undefined, logo: typeof m.logo === 'string' ? m.logo : undefined,
            types: s.types, stream: s.stream, subtitles: s.subtitles, configurationRequired: s.configurationRequired,
            warnings: s.configurationRequired ? ['This addon must be configured first; paste the personal manifest URL from its configure page.'] : [],
        });
    }
    res.status(422).json({ ok: false, error: 'not a Nuvio plugin manifest or a Stremio addon manifest' });
});

const scrapersView = (req: any) => nuvioScrapers().map((r) => (isAdmin(req) ? r : { ...r, manifest: maskUrl(r.manifest) }));

router.get('/scrapers', (req, res) => res.json({ repos: scrapersView(req) }));

router.post('/scrapers', (req, res) => {
    if (!admin(req, res)) return;
    const c = req.body?.changes;
    const valid = c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length <= 500
        && Object.entries(c).every(([k, v]) => /^nuvio:/.test(k) && k.length <= 300 && (v === true || v === false || v === null));
    if (!valid) return res.status(400).json({ ok: false, error: 'changes must be {"nuvio:…": true|false|null}' });
    setScraperOverrides(c);
    res.json({ ok: true, repos: scrapersView(req) });
});

export default router;
