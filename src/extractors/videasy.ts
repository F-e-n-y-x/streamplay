import axios from 'axios';
import { Provider, LinkData, ExtractorResult } from '../types';

const VIDEASY_API = 'https://api.videasy.net';

export const VidEasyProvider: Provider = {
    id: 'videasy',
    name: 'VidEasy',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.title || !data.id) return result;

        const headers = {
            "Accept": "*/*",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
            "Origin": "https://www.cineby.sc",
            "Referer": "https://www.cineby.sc/"
        };

        const servers = [
            "myflixerzupcloud",
            "1movies",
            "moviebox",
            "primewire",
            "m4uhd",
            "hdmovie",
            "cdn",
            "primesrcme",
            "visioncine",
            "overflix",
            "superflix",
            "cuevana",
            "lamovie",
            "mb-flix",
        ];

        const encTitle = encodeURIComponent(encodeURIComponent(data.title));

        // Let's run servers concurrently to be fast
        const promises = servers.map(async (server) => {
            try {
                const url = data.season == null
                    ? `${VIDEASY_API}/${server}/sources-with-title?title=${encTitle}&mediaType=movie&year=${data.year}&tmdbId=${data.id}&imdbId=${data.imdbId}`
                    : `${VIDEASY_API}/${server}/sources-with-title?title=${encTitle}&mediaType=tv&year=${data.year}&tmdbId=${data.id}&episodeId=${data.episode}&seasonId=${data.season}&imdbId=${data.imdbId}`;

                const res = await axios.get(url, { headers, timeout: 10000 });
                const encdata = res.data;

                if (!encdata || typeof encdata !== 'string') return;

                // Decrypt using enc-dec.app
                const jsonBody = { text: encdata, id: data.id };
                const decResponse = await axios.post("https://enc-dec.app/api/dec-videasy", jsonBody, { timeout: 10000 });
                
                const decResult = decResponse.data?.result;
                if (!decResult) return;

                if (decResult.sources && Array.isArray(decResult.sources)) {
                    for (const source of decResult.sources) {
                        const link = source.url;
                        const type = link.includes(".m3u8") ? 'm3u8' : (link.includes(".mp4") || link.includes(".mkv") ? 'mp4' : 'iframe');
                        
                        result.streams.push({
                            server: `VidEasy [${server}]`,
                            link,
                            type: type as any,
                            quality: source.quality,
                            headers
                        });
                    }
                }

                if (decResult.subtitles && Array.isArray(decResult.subtitles)) {
                    for (const sub of decResult.subtitles) {
                        if (sub.url) {
                            result.subtitles.push({
                                language: sub.language || 'Unknown',
                                url: sub.url
                            });
                        }
                    }
                }
            } catch (e) {
                // Ignore individual server failure
            }
        });

        await Promise.all(promises);
        return result;
    }
};
