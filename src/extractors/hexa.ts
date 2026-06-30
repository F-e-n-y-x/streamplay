import axios from 'axios';
import crypto from 'crypto';
import { Provider, LinkData, ExtractorResult } from '../types';
import { encDecGet, encDecPost, USER_AGENT } from '../utils/encdec';

const HEXA_API = 'https://theemoviedb.hexa.su';

const generateHexKey32 = (): string => crypto.randomBytes(32).toString('hex');

/**
 * HexaSU — ported from invokeHexa (StreamPlayExtractor.kt).
 *
 * Flow:
 *   1. Generate a random 32-byte hex api key.
 *   2. enc-hexa (with X-Api-Key) -> cap token.
 *   3. GET the images endpoint (with X-Cap-Token) -> encrypted blob.
 *   4. dec-hexa { text, key } -> { result: { sources: [ { server, url } ] } }
 */
export const HexaProvider: Provider = {
    id: 'hexasu',
    name: 'HexaSU',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (data.isAnime || !data.id) return result;

        try {
            const key = generateHexKey32();
            const baseHeaders: Record<string, string> = {
                'User-Agent': USER_AGENT,
                'Referer': 'https://hexa.su/',
                'Accept': 'text/plain',
                'X-Fingerprint-Lite': 'e9136c41504646444',
                'X-Api-Key': key
            };

            // Step 1 + 2: cap token
            const enc = await encDecGet('enc-hexa', baseHeaders);
            const token = enc?.result?.token;
            if (!token) return result;

            const headers = { ...baseHeaders, 'X-Cap-Token': token };

            // Step 3: encrypted sources blob
            const url = data.season == null
                ? `${HEXA_API}/api/tmdb/movie/${data.id}/images`
                : `${HEXA_API}/api/tmdb/tv/${data.id}/season/${data.season}/episode/${data.episode}/images`;

            const encrypted = (await axios.get(url, { headers, timeout: 15000 })).data;
            if (!encrypted) return result;

            // Step 4: decrypt
            const dec = await encDecPost('dec-hexa', { text: encrypted, key }, { 'Content-Type': 'application/json' });
            if (dec?.status !== 200) return result;

            for (const src of dec?.result?.sources ?? []) {
                if (!src?.url || !src?.server) continue;
                const name = src.server.charAt(0).toUpperCase() + src.server.slice(1);
                result.streams.push({
                    server: `HexaSU ${name}`,
                    link: src.url,
                    type: src.url.includes('.m3u8') ? 'm3u8' : 'mp4',
                    headers: { 'Referer': 'https://hexa.su/' }
                });
            }
        } catch (error: any) {
            console.error('Error in HexaSU extractor:', error?.message || error);
        }

        return result;
    }
};
