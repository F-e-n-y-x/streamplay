import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult } from '../types';

import { safeGet } from '../utils/http';
import { seasonRe, episodeRe } from '../utils/season';

const CINEMACITY_API = 'https://cinemacity.cc';
// Logged-in DLE session (the player is members-only). Override via env when it expires;
// the built-in default keeps existing deployments working.
const COOKIE = process.env.CINEMACITY_COOKIE
    || Buffer.from('ZGxlX3VzZXJfaWQ9MzI3Mjk7IGRsZV9wYXNzd29yZD04OTQxNzFjNmE4ZGFiMThlZTU5NGQ1YzY1MjAwOWEzNTs=', 'base64').toString('utf-8');

interface PjItem { title?: string; file?: string; folder?: PjItem[] }

/**
 * Pick the playable entries from a Playerjs `file` list. Movies: every item with a
 * `file`. Series: the list is [{title:"Season N", folder:[{title:"Episode M", file}]}] —
 * return only that season's episode (never another season's / a movie's files).
 */
export function pickPlayerjsFiles(items: PjItem[], season?: number, episode?: number): PjItem[] {
    if (season == null) return items.filter((f) => f.file);
    const s = items.find((f) => Array.isArray(f.folder) && seasonRe(season).test(f.title || ''));
    const eRe = episodeRe(episode ?? 1);
    return (s?.folder || []).filter((e) => e.file && eRe.test(e.title || ''));
}

export const CineMacityProvider: Provider = {
    id: 'cinemacity',
    name: 'CineMacity',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.imdbId) return result;

        try {
            const searchUrl = `${CINEMACITY_API}/?do=search&subaction=search&search_start=0&full_search=0&story=${data.imdbId}`;
            const headers = { Cookie: COOKIE, 'User-Agent': 'Mozilla/5.0' };

            const searchRes = await safeGet(searchUrl, { headers, cloudflare: true });
            const $ = cheerio.load(searchRes.text);
            const pageUrl = $('div.dar-short_item > a').attr('href');

            if (!pageUrl) return result;

            const pageRes = await safeGet(pageUrl, { headers });
            const page$ = cheerio.load(pageRes.text);
            
            let playerJsData = '';
            page$('script').each((_, el) => {
                const scriptContent = page$(el).html() || '';
                if (scriptContent.includes('atob(')) {
                    playerJsData = scriptContent;
                }
            });

            if (!playerJsData) return result;

            // Extract the base64 payload from atob("...")
            const base64Match = /atob\("([^"]+)"\)/.exec(playerJsData);
            if (!base64Match) return result;

            const decoded = Buffer.from(base64Match[1], 'base64').toString('utf-8');
            
            // Extract the JSON config inside new Playerjs({...})
            const playerjsMatch = /new Playerjs\((.*?)\);/s.exec(decoded);
            if (!playerjsMatch) return result;

            // Playerjs is initialised with a JS object literal (unquoted keys), which
            // strict JSON.parse rejects — quote bare keys and retry before giving up
            // (previously this threw on every standard page and the provider yielded nothing).
            let configJson: any;
            try { configJson = JSON.parse(playerjsMatch[1]); }
            catch {
                try { configJson = JSON.parse(playerjsMatch[1].replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')); }
                catch { return result; }
            }
            const fileData = configJson.file;

            if (fileData) {
                // `file` is a plain URL (movie), a JSON string, or an already-parsed array.
                let files: PjItem[] = [];
                if (Array.isArray(fileData)) files = fileData;
                else if (typeof fileData === 'string') {
                    try { files = JSON.parse(fileData); } catch { files = [{ file: fileData }]; }
                }
                const season = data.type === 'tv' ? (data.season ?? 1) : undefined;
                for (const f of Array.isArray(files) ? pickPlayerjsFiles(files, season, data.episode) : []) {
                    result.streams.push({
                        server: season != null ? `CineMacity · ${f.title}` : 'CineMacity',
                        link: f.file!,
                        type: f.file!.includes('.m3u8') ? 'm3u8' : 'mp4',
                        quality: season != null ? undefined : f.title || undefined,
                    });
                }
            }

            if (configJson.subtitle) {
                // parse subtitles like "[EN]https://...vtt,[RU]https://..."
                const subs = configJson.subtitle.split(',');
                for (const sub of subs) {
                    const match = /\[(.*?)\](.*)/.exec(sub);
                    if (match) {
                        result.subtitles.push({
                            language: match[1],
                            url: match[2]
                        });
                    }
                }
            }

        } catch (error) {
            console.error('Error in CineMacity extractor:', error);
        }

        return result;
    }
};
