import { dataFile, readJson, writeJsonAtomic } from './common';

/**
 * Runtime server configuration set from the UI (Settings → Torrent indexer), persisted
 * to disk alongside the sync data. Currently holds the Torznab (Jackett/Prowlarr) hookup
 * so users can wire a meta-indexer without editing env vars + rebuilding. Env vars remain
 * a fallback (and win only when nothing is configured here).
 */
interface Cfg {
    torznab?: { kind: 'jackett' | 'prowlarr' | 'torznab'; url: string; apiKey: string };
    /** Manifest URLs set from the UI; absent = fall back to the env var. */
    nuvio?: string[];
    stremio?: string[];
    /** Per-scraper on/off for Nuvio repos, keyed by provider id (`nuvio:<repo>:<scraper>`). Absent = manifest default. */
    nuvioScrapers?: Record<string, boolean>;
}

const FILE = process.env.SERVER_CONFIG_FILE || dataFile('server-config.json');
const cfg: Cfg = readJson(FILE) || {};
const save = () => writeJsonAtomic(FILE, cfg);

/** The active Torznab hookup: UI config first, then env vars. */
export function getTorznab(): { url?: string; apiKey?: string } {
    const c = cfg.torznab;
    if (c && c.url && c.apiKey) return { url: c.url, apiKey: c.apiKey };
    return {
        url: process.env.TORZNAB_URL || process.env.JACKETT_URL || process.env.PROWLARR_URL,
        apiKey: process.env.TORZNAB_API_KEY || process.env.JACKETT_API_KEY || process.env.PROWLARR_API_KEY,
    };
}

/** Save the Torznab hookup; a blank key keeps the saved one ("leave blank to keep"), a blank url clears. */
export function setTorznab(kind: 'jackett' | 'prowlarr' | 'torznab', url: string, apiKey: string): void {
    const key = apiKey.trim() || cfg.torznab?.apiKey || '';
    cfg.torznab = (url.trim() && key) ? { kind, url: url.trim(), apiKey: key } : undefined;
    save();
}

/** Public view (key never leaves the server — just whether one is set). */
export function torznabPublic(): { kind: string; url: string; hasKey: boolean; source: 'ui' | 'env' } | null {
    if (cfg.torznab?.url) return { kind: cfg.torznab.kind, url: cfg.torznab.url, hasKey: !!cfg.torznab.apiKey, source: 'ui' };
    const envUrl = process.env.TORZNAB_URL || process.env.JACKETT_URL || process.env.PROWLARR_URL;
    const envKey = process.env.TORZNAB_API_KEY || process.env.JACKETT_API_KEY || process.env.PROWLARR_API_KEY;
    if (envUrl) {
        const kind = process.env.JACKETT_URL ? 'jackett' : process.env.PROWLARR_URL ? 'prowlarr' : 'torznab';
        return { kind, url: envUrl, hasKey: !!envKey, source: 'env' };
    }
    return null;
}

// ── Addon manifest lists: Nuvio plugin repos + Stremio addons ─────────────────
export type AddonKind = 'nuvio' | 'stremio';
const ADDON_ENV: Record<AddonKind, string> = { nuvio: 'NUVIO_PLUGINS', stremio: 'STREMIO_ADDONS' };
const splitUrls = (v?: string): string[] => (v || '').split(',').map((x) => x.trim()).filter(Boolean);

/** Active manifest URLs: the UI list when one was saved, else the env var. */
export function getAddonUrls(k: AddonKind): string[] {
    return cfg[k] ?? splitUrls(process.env[ADDON_ENV[k]]);
}

/** Save the UI list (validated http(s), max 20), or `null` to fall back to the env var. */
export function setAddonUrls(k: AddonKind, urls: string[] | null): void {
    cfg[k] = urls === null ? undefined : [...new Set(urls.map((u) => String(u).trim()).filter((u) => {
        try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; }
    }))].slice(0, 20);
    save();
}

export function addonPublic(k: AddonKind): { urls: string[]; source: 'ui' | 'env' | 'none' } {
    const urls = getAddonUrls(k);
    return { urls, source: cfg[k] ? 'ui' : urls.length ? 'env' : 'none' };
}

export const getScraperOverrides = (): Record<string, boolean> => cfg.nuvioScrapers || {};

/** Merge overrides: `true`/`false` set one, `null` resets it to the manifest default. */
export function setScraperOverrides(changes: Record<string, boolean | null>): void {
    const m = { ...getScraperOverrides() };
    for (const [id, v] of Object.entries(changes)) if (v === null) delete m[id]; else m[id] = v;
    cfg.nuvioScrapers = Object.keys(m).length ? m : undefined;
    save();
}
