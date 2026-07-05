import fs from 'fs';
import path from 'path';

/**
 * Runtime server configuration set from the UI (Settings → Torrent indexer), persisted
 * to disk alongside the sync data. Currently holds the Torznab (Jackett/Prowlarr) hookup
 * so users can wire a meta-indexer without editing env vars + rebuilding. Env vars remain
 * a fallback (and win only when nothing is configured here).
 */
interface Cfg {
    torznab?: { kind: 'jackett' | 'prowlarr' | 'torznab'; url: string; apiKey: string };
}

const FILE = process.env.SERVER_CONFIG_FILE || path.join(path.dirname(process.env.SYNC_DATA_FILE || './x'), 'server-config.json');
let cfg: Cfg = {};
(function load() { try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf-8')) || {}; } catch { cfg = {}; } })();
const save = () => { try { fs.writeFile(FILE, JSON.stringify(cfg), () => { /* best effort */ }); } catch { /* */ } };

/** The active Torznab hookup: UI config first, then env vars. */
export function getTorznab(): { url?: string; apiKey?: string } {
    const c = cfg.torznab;
    if (c && c.url && c.apiKey) return { url: c.url, apiKey: c.apiKey };
    return {
        url: process.env.TORZNAB_URL || process.env.JACKETT_URL || process.env.PROWLARR_URL,
        apiKey: process.env.TORZNAB_API_KEY || process.env.JACKETT_API_KEY || process.env.PROWLARR_API_KEY,
    };
}

/** Save (or clear, when url/apiKey blank) the Torznab hookup. */
export function setTorznab(kind: 'jackett' | 'prowlarr' | 'torznab', url: string, apiKey: string): void {
    cfg.torznab = (url && apiKey) ? { kind, url: url.trim(), apiKey: apiKey.trim() } : undefined;
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
