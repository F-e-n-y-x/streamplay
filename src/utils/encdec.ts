import axios from 'axios';

/**
 * Helpers for the `enc-dec.app` service that the StreamPlay providers use to
 * encrypt/decrypt the tokens and payloads exchanged with the upstream sites.
 *
 * Ported from the Kotlin plugin (StreamPlayExtractor.kt / StreamPlayUtils.kt).
 *
 * Because several providers (VidFast, Hexa, Vidlink, VidEasy) all call this
 * single free service concurrently, it rate-limits and returns empty/garbage
 * under load. We therefore funnel every call through a small concurrency gate
 * with a couple of retries so the providers stay reliable when invoked together.
 */

const ENC_DEC_API = 'https://enc-dec.app/api';

export const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const MAX_CONCURRENT = 4;
const MAX_RETRIES = 2;

let active = 0;
const queue: Array<() => void> = [];

const acquire = (): Promise<void> =>
    new Promise(resolve => {
        if (active < MAX_CONCURRENT) {
            active++;
            resolve();
        } else {
            queue.push(() => { active++; resolve(); });
        }
    });

const release = () => {
    active--;
    queue.shift()?.();
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Run an enc-dec request through the concurrency gate with retries. */
const gated = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    await acquire();
    try {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                return await fn();
            } catch {
                if (attempt < MAX_RETRIES) await sleep(300 * (attempt + 1));
            }
        }
        return null;
    } finally {
        release();
    }
};

/** GET an enc-dec endpoint and return the parsed JSON body (`{ status, result, ... }`). */
export const encDecGet = (path: string, headers?: Record<string, string>): Promise<any | null> =>
    gated(async () => {
        const res = await axios.get(`${ENC_DEC_API}/${path}`, { headers, timeout: 15000 });
        return res.data;
    });

/** POST a JSON body to an enc-dec endpoint and return the parsed JSON body. */
export const encDecPost = (path: string, body: any, headers?: Record<string, string>): Promise<any | null> =>
    gated(async () => {
        const res = await axios.post(`${ENC_DEC_API}/${path}`, body, { headers, timeout: 15000 });
        return res.data;
    });
