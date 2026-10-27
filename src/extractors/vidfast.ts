import net from '../utils/net';
import { Provider, LinkData, ExtractorResult } from '../types';
import { encDecGet, encDecPost, USER_AGENT } from '../utils/encdec';

const VIDFAST_API = 'https://vidfast.vc';   // vidfast.pro 301s here

/**
 * VidFast — ported from invokeVidFast (StreamPlayExtractor.kt).
 *
 * Flow:
 *   1. GET the watch page (WITHOUT X-Requested-With — that returns a 548-byte stub),
 *      scrape the `\"en\":\"<token>\"` blob.
 *   2. enc-vidfast?text=<token>&stage=1    -> { result: { stage1, token } }; POST stage1 (CSRF)
 *   3. enc-vidfast?text=<that>&stage=2     -> { result: { servers, stream, token } }
 *   4. POST <servers> (CSRF) -> dec-vidfast { text } -> { result: [ { name, data } ] }
 *   (smy778/EncDecEndpoints samples/vidfast.py)
 *   5. For each server: POST <stream>/<data> -> encrypted, then dec-vidfast -> { result: { url, tracks } }
 */
export const VidFastProvider: Provider = {
    id: 'vidfast',
    name: 'VidFast',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.id) return result;

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
            const pageRes = await net.get(requestUrl, { headers: { 'User-Agent': USER_AGENT }, timeout: 15000 });
            const encodedText = /\\"(?:en|token)\\":\\"(.*?)\\"/.exec(pageRes.data)?.[1];
            if (!encodedText) return result;

            // Step 2: stage 1 → POST → stage 2 → servers/stream/csrf
            const s1 = (await encDecGet(`enc-vidfast?text=${encodeURIComponent(encodedText)}&stage=1`))?.result;
            if (!s1?.stage1 || !s1?.token) return result;
            const stage1Text = (await net.post(s1.stage1, undefined, { headers: { ...baseHeaders, 'X-CSRF-Token': s1.token }, timeout: 15000, responseType: 'text' })).data;
            if (!stage1Text) return result;
            const meta = (await encDecGet(`enc-vidfast?text=${encodeURIComponent(stage1Text)}&stage=2`))?.result;
            if (!meta?.servers || !meta?.stream || !meta?.token) return result;

            const { servers: serversUrl, stream: streamBase, token } = meta;
            const postHeaders = { ...baseHeaders, 'X-CSRF-Token': token };

            // Step 3 + 4: encrypted servers list -> decrypt
            const serversEncrypted = (await net.post(serversUrl, undefined, { headers: postHeaders, timeout: 15000, responseType: 'text' })).data;
            if (!serversEncrypted) return result;

            const serversRoot = await encDecPost('dec-vidfast', { text: serversEncrypted });
            const serversList: any[] = serversRoot?.result ?? [];
            if (serversList.length === 0) return result;

            // Step 5: each server's stream is itself encrypted; decrypt to get final URL + subs
            // ponytail: first 6 servers — each costs 2 enc-dec round-trips through the shared gate
            await Promise.all(serversList.slice(0, 6).map(async (server: any, index: number) => {
                const name = server.name || `Server ${index + 1}`;
                if (!server.data) return;

                try {
                    const streamUrl = `${streamBase}/${server.data}`;
                    const streamEncrypted = (await net.post(streamUrl, undefined, { headers: postHeaders, timeout: 15000, responseType: 'text' })).data;
                    if (!streamEncrypted) return;

                    const streamRoot = await encDecPost('dec-vidfast', { text: streamEncrypted });
                    const finalUrl = streamRoot?.result?.url;
                    if (!finalUrl) return;

                    result.streams.push({
                        server: `VidFast [${name}]`,
                        link: finalUrl,
                        type: finalUrl.includes('.m3u8') ? 'm3u8' : 'mp4',
                        headers: streamRoot.result.noReferrer ? {} : { 'Referer': `${VIDFAST_API}/`, Origin: VIDFAST_API }
                    });

                    for (const track of streamRoot?.result?.tracks ?? []) {
                        if (track.file && track.label && !result.subtitles.some((x) => x.url === track.file)) {
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
