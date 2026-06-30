import axios from 'axios';
import { Provider, LinkData, ExtractorResult } from '../types';
import { encDecGet, encDecPost, USER_AGENT } from '../utils/encdec';

const VIDFAST_API = 'https://vidfast.pro';

/**
 * VidFast — ported from invokeVidFast (StreamPlayExtractor.kt).
 *
 * Flow:
 *   1. GET the watch page, scrape the `\"en\":\"<token>\"` blob.
 *   2. enc-vidfast?text=<token>&version=1  -> { result: { servers, stream, token } }
 *   3. POST <servers> with X-CSRF-Token    -> encrypted servers blob
 *   4. POST dec-vidfast { text, version }   -> { result: [ { name, data } ] }
 *   5. For each server: POST <stream>/<data> -> encrypted, then dec-vidfast -> { result: { url, tracks } }
 */
export const VidFastProvider: Provider = {
    id: 'vidfast',
    name: 'VidFast',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.id) return result;

        const version = '1';

        try {
            const requestUrl = data.season == null
                ? `${VIDFAST_API}/movie/${data.id}`
                : `${VIDFAST_API}/tv/${data.id}/${data.season}/${data.episode}`;

            const baseHeaders: Record<string, string> = {
                'User-Agent': USER_AGENT,
                'Referer': `${VIDFAST_API}/`,
                'X-Requested-With': 'XMLHttpRequest'
            };

            // Step 1: page + token
            const pageRes = await axios.get(requestUrl, { headers: baseHeaders, timeout: 15000 });
            const encodedText = /\\"en\\":\\"(.*?)\\"/.exec(pageRes.data)?.[1];
            if (!encodedText) return result;

            // Step 2: decrypt token -> servers/stream/csrf
            const encJson = await encDecGet(`enc-vidfast?text=${encodedText}&version=${version}`);
            const meta = encJson?.result;
            if (!meta?.servers || !meta?.stream || !meta?.token) return result;

            const { servers: serversUrl, stream: streamBase, token } = meta;
            const postHeaders = { ...baseHeaders, 'X-CSRF-Token': token };

            // Step 3 + 4: encrypted servers list -> decrypt
            const serversEncrypted = (await axios.post(serversUrl, {}, { headers: postHeaders, timeout: 15000 })).data;
            if (!serversEncrypted) return result;

            const serversRoot = await encDecPost('dec-vidfast', { text: serversEncrypted, version });
            const serversList: any[] = serversRoot?.result ?? [];
            if (serversList.length === 0) return result;

            // Step 5: each server's stream is itself encrypted; decrypt to get final URL + subs
            await Promise.all(serversList.map(async (server: any, index: number) => {
                const name = server.name || `Server ${index + 1}`;
                if (!server.data) return;

                try {
                    const streamUrl = `${streamBase}/${server.data}`;
                    const streamEncrypted = (await axios.post(streamUrl, {}, { headers: postHeaders, timeout: 15000 })).data;
                    if (!streamEncrypted) return;

                    const streamRoot = await encDecPost('dec-vidfast', { text: streamEncrypted, version });
                    const finalUrl = streamRoot?.result?.url;
                    if (!finalUrl) return;

                    result.streams.push({
                        server: `VidFast [${name}]`,
                        link: finalUrl,
                        type: finalUrl.includes('.m3u8') ? 'm3u8' : 'mp4',
                        quality: '1080p',
                        headers: { 'Referer': `${VIDFAST_API}/` }
                    });

                    for (const track of streamRoot?.result?.tracks ?? []) {
                        if (track.file && track.label) {
                            result.subtitles.push({ language: track.label, url: track.file });
                        }
                    }
                } catch { /* skip this server */ }
            }));
        } catch (error: any) {
            console.error('Error in VidFast extractor:', error?.message || error);
        }

        return result;
    }
};
