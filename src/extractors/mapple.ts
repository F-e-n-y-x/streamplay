import crypto from 'crypto';
import { Provider, LinkData, ExtractorResult } from '../types';
import { app, safeGet } from '../utils/http';
import { USER_AGENT } from '../utils/encdec';

const MAPPLE_API = 'https://mapple.uk';

/**
 * solvePowChallenge(): brute-force a nonce such that
 * SHA256(challenge + nonce) interpreted as a big-endian integer is below
 * 2^(256-difficulty). Mirrors StreamPlayUtils.solvePowChallenge.
 */
const solvePowChallenge = (challenge: string, difficulty: number): string | null => {
    // target = 1 << (256 - difficulty). Compare the leading `difficulty` bits being zero.
    // We compare the hash bytes against the target threshold directly.
    const fullBytes = Math.floor(difficulty / 8);
    const remBits = difficulty % 8;

    for (let nonce = 0; nonce <= 10_000_000; nonce++) {
        const hash = crypto.createHash('sha256').update(challenge + nonce).digest();
        // hashInt < 2^(256-difficulty)  <=>  the top `difficulty` bits are all zero.
        let ok = true;
        for (let i = 0; i < fullBytes; i++) {
            if (hash[i] !== 0) { ok = false; break; }
        }
        if (ok && remBits > 0) {
            // remaining high bits of the next byte must be zero
            if ((hash[fullBytes] >> (8 - remBits)) !== 0) ok = false;
        }
        if (ok) return nonce.toString();
    }
    return null;
};

/**
 * Mapple — ported from invokeMapple (StreamPlayExtractor.kt).
 * Scrapes a request token from the watch page, exchanges it (solving a SHA-256
 * proof-of-work if required) for a stream token, then queries each source.
 */
export const MappleProvider: Provider = {
    id: 'mapple',
    name: 'Mapple',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (!data.id) return result;

        try {
            const base = MAPPLE_API.replace(/\/$/, '');
            const mediaType = data.season == null ? 'movie' : 'tv';
            const tvSlug = data.season != null && data.episode != null ? `${data.season}-${data.episode}` : '';

            const headers: Record<string, string> = {
                'User-Agent': USER_AGENT,
                'Referer': `${base}/`,
                'Origin': base,
                'Accept': '*/*',
                'Content-Type': 'application/json',
            };

            const watchUrl = mediaType === 'movie'
                ? `${base}/watch/movie/${data.id}`
                : `${base}/watch/tv/${data.id}/${tvSlug}`;

            const page = (await safeGet(watchUrl, { headers })).text;
            const tokenMatch = /window\.__REQUEST_TOKEN__\s*=\s*"([^"]+)"/.exec(page);
            const requestToken = tokenMatch?.[1];
            if (!requestToken) return result;

            const body = JSON.stringify({ mediaId: data.id, mediaType, requestToken });
            const tokenRes1 = (await app.post(`${base}/api/stream-token`, body, { headers })).json<any>();
            if (!tokenRes1?.success) return result;

            let finalToken: string | undefined;
            if (tokenRes1.requiresPow) {
                const pow = tokenRes1.pow;
                const nonce = solvePowChallenge(String(pow.challenge), Number(pow.difficulty));
                if (!nonce) return result;

                const body2 = JSON.stringify({
                    mediaId: data.id,
                    mediaType,
                    requestToken,
                    pow: { challengeId: String(pow.challengeId), nonce },
                });
                const tokenRes2 = (await app.post(`${base}/api/stream-token`, body2, { headers })).json<any>();
                if (!tokenRes2?.success) return result;
                finalToken = tokenRes2.token;
            } else {
                finalToken = tokenRes1.token;
            }

            if (!finalToken) return result;

            const sources = ['mapple', 'willow', 'cherry', 'pines', 'oak', 'sequoia', 'sakura', 'magnolia'];

            await Promise.all(sources.map(async (source) => {
                try {
                    const streamUrl =
                        `${base}/api/stream?mediaId=${data.id}&mediaType=${mediaType}&tv_slug=${tvSlug}` +
                        `&source=${source}&apikey=mptv_sk_a8f29c4e7b3d1f` +
                        `&requestToken=${requestToken}&token=${finalToken}`;

                    const streamRes = (await safeGet(streamUrl, { headers })).json<any>();
                    if (!streamRes?.success) return;

                    const m3u8: string = streamRes?.data?.stream_url || '';
                    if (m3u8) {
                        result.streams.push({
                            server: `Mapple [${source.toUpperCase()}]`,
                            link: m3u8,
                            type: 'm3u8',
                            quality: '1080p',
                            headers,
                        });
                    }
                } catch {
                    /* skip source */
                }
            }));
        } catch (e: any) {
            console.error('Error in Mapple extractor:', e?.message || e);
        }

        return result;
    },
};
