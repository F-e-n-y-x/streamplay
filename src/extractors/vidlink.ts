import axios from 'axios';
import { Provider, LinkData, ExtractorResult } from '../types';

const VIDLINK_API = 'https://vidlink.pro';

export const VidlinkProvider: Provider = {
    id: 'vidlink',
    name: 'Vidlink',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (data.isAnime) return result;
        if (!data.id) return result;

        try {
            // Step 1: Encrypt TMDB ID using enc-dec.app
            const encUrl = `https://enc-dec.app/api/enc-vidlink?text=${data.id}`;
            const encResponse = await axios.get(encUrl, { timeout: 10000 });
            const encData = encResponse.data?.result;
            
            console.log("[Vidlink] encData:", encData);
            if (!encData) return result;

            const headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
                "Connection": "keep-alive",
                "Referer": `${VIDLINK_API}/`,
                "Origin": VIDLINK_API
            };

            const apiUrl = data.season == null 
                ? `${VIDLINK_API}/api/b/movie/${encData}` 
                : `${VIDLINK_API}/api/b/tv/${encData}/${data.season}/${data.episode}`;
            
            console.log("[Vidlink] Fetching API:", apiUrl);

            // Step 2: Fetch M3U8 endpoint
            const epResponse = await axios.get(apiUrl, { headers, timeout: 10000 });
            const streamData = epResponse.data?.stream;
            
            console.log("[Vidlink] StreamData:", !!streamData);
            
            if (!streamData || !streamData.playlist) return result;

            // Optional headers embedded in the query string
            const urlObj = new URL(streamData.playlist);
            const headersJsonStr = urlObj.searchParams.get('headers');
            
            const reqHeaders: Record<string, string> = { ...headers };
            if (headersJsonStr) {
                try {
                    const parsedHeaders = JSON.parse(decodeURIComponent(headersJsonStr));
                    Object.assign(reqHeaders, parsedHeaders);
                } catch(e) {}
            }

            result.streams.push({
                server: 'Vidlink',
                link: streamData.playlist,
                type: 'm3u8',
                headers: reqHeaders
            });

        } catch (error) {
            console.error('Error in Vidlink extractor:', error);
        }

        return result;
    }
};
