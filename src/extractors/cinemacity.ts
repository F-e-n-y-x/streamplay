import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult } from '../types';

import { safeGet } from '../utils/http';

const CINEMACITY_API = 'https://cinemacity.cc';

export const CineMacityProvider: Provider = {
    id: 'cinemacity',
    name: 'CineMacity',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.imdbId) return result;

        try {
            const searchUrl = `${CINEMACITY_API}/?do=search&subaction=search&search_start=0&full_search=0&story=${data.imdbId}`;
            const headers = {
                "Cookie": Buffer.from("ZGxlX3VzZXJfaWQ9MzI3Mjk7IGRsZV9wYXNzd29yZD04OTQxNzFjNmE4ZGFiMThlZTU5NGQ1YzY1MjAwOWEzNTs=", 'base64').toString('utf-8'),
                "User-Agent": "Mozilla/5.0"
            };

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

            const configJson = JSON.parse(playerjsMatch[1]);
            const fileData = configJson.file;

            if (fileData) {
                // fileData could be a string or array of arrays
                let files = [];
                try {
                    files = JSON.parse(fileData);
                } catch(e) {
                    if (typeof fileData === 'string') {
                        files = [{ file: fileData }];
                    }
                }

                if (Array.isArray(files)) {
                    for (const f of files) {
                        if (f.file) {
                            const url = f.file;
                            const isM3u8 = url.includes('.m3u8');
                            result.streams.push({
                                server: 'CineMacity',
                                link: url,
                                type: isM3u8 ? 'm3u8' : 'mp4',
                                quality: f.title || 'Unknown'
                            });
                        }
                    }
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
