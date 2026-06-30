import { Provider, LinkData, ExtractorResult } from '../types';
import { app, safeGet } from '../utils/http';

const allmovielandAPI = 'https://allmovieland.io';

interface AllMovielandPlaylist { file?: string; key?: string; href?: string; }
interface AllMovielandEpisodeFolder { title?: string; id?: string; file?: string; }
interface AllMovielandSeasonFolder { episode?: string; id?: string; folder?: AllMovielandEpisodeFolder[]; }
interface AllMovielandServer { title?: string; id?: string; file?: string; folder?: AllMovielandSeasonFolder[]; }

/**
 * AllMovieland — ported from invokeAllMovieland (StreamPlayExtractor.kt).
 *
 * 1. Fetch player.js, regex out AwsIndStreamDomain host.
 * 2. GET <host>/play/<imdbId>, grab the inline playlist JSON ({file, key}).
 * 3. POST/GET the json file (with X-CSRF-TOKEN) -> server list.
 * 4. For each server, POST <host>/playlist/<file>.txt -> m3u8 URL.
 */
export const AllMovielandProvider: Provider = {
    id: 'allmovieland',
    name: 'AllMovieLand',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        const imdbId = data.imdbId;
        if (!imdbId) return result;

        try {
            const season = data.type === 'tv' ? data.season : undefined;
            const episode = data.type === 'tv' ? data.episode : undefined;

            const playerResponse = await safeGet('https://allmovieland.link/player.js?v=60%20128');
            if (playerResponse.status !== 200) return result;
            const playerScript = playerResponse.text;
            const domainMatch = /const AwsIndStreamDomain.*'(.*)';/.exec(playerScript);
            const host = domainMatch?.[1];
            if (!host) return result;

            const resResponse = await safeGet(`${host}/play/${imdbId}`, { referer: `${allmovielandAPI}/` });
            if (resResponse.status !== 200) return result;

            // Find <script> containing "playlist" and slice the inline JSON.
            const $ = resResponse.document;
            let scriptData = '';
            $('script').each((_, el) => {
                const txt = $(el).html() || '';
                if (txt.includes('playlist') && !scriptData) scriptData = txt;
            });
            if (!scriptData) return result;

            // Kotlin sliced `{...}` heuristically; the live page embeds the config as
            // `let p3 = {...};`, so brace-match from the first `{` to get the full object.
            const start = scriptData.indexOf('{');
            if (start < 0) return result;
            let depth = 0, end = -1, inStr = false, esc = false;
            for (let i = start; i < scriptData.length; i++) {
                const ch = scriptData[i];
                if (inStr) {
                    if (esc) esc = false;
                    else if (ch === '\\') esc = true;
                    else if (ch === '"') inStr = false;
                } else if (ch === '"') inStr = true;
                else if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
            }
            if (end < 0) return result;
            let json: AllMovielandPlaylist | null = null;
            try { json = JSON.parse(scriptData.substring(start, end + 1)); } catch { return result; }
            if (!json || !json.file) return result;

            const headers = { 'X-CSRF-TOKEN': `${json.key}` };
            const jsonfile = json.file?.startsWith('http') ? json.file : host + json.file;

            const serverResponse = await safeGet(jsonfile, { headers, referer: `${allmovielandAPI}/` });
            if (serverResponse.status !== 200) return result;
            const list = serverResponse.json<AllMovielandServer[]>();
            if (!list) return result;

            let servers: Array<[string, string]> = [];
            if (season == null) {
                servers = list
                    .filter(s => s.file)
                    .map(s => [s.file as string, s.title || ''] as [string, string]);
            } else {
                const seasonObj = list.find(s => s.id === String(season));
                const epObj = seasonObj?.folder?.find(f => f.episode === String(episode));
                servers = (epObj?.folder || [])
                    .filter(f => f.file)
                    .map(f => [f.file as string, f.title || ''] as [string, string]);
            }

            await Promise.all(servers.map(async ([server, lang]) => {
                try {
                    const playlistResponse = await app.post(
                        `${host}/playlist/${server}.txt`,
                        undefined,
                        { headers, referer: `${allmovielandAPI}/` }
                    );
                    if (playlistResponse.status !== 200) return;
                    const playlistUrl = playlistResponse.text.trim();
                    if (!playlistUrl.startsWith('http')) return;

                    result.streams.push({
                        server: `AllMovieLand-${lang}`,
                        link: playlistUrl,
                        type: playlistUrl.includes('.m3u8') ? 'm3u8' : 'mp4',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                            'Accept': '*/*',
                            'Referer': allmovielandAPI,
                            'Origin': allmovielandAPI,
                        },
                    });
                } catch { /* skip server */ }
            }));
        } catch (e: any) {
            console.error('Error in AllMovieLand extractor:', e?.message || e);
        }

        return result;
    }
};
