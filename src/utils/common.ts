/**
 * Small helpers ported from StreamPlayUtils.kt, shared across providers.
 */

/** CloudStream Qualities enum values (px height; Unknown = 0). */
export const Qualities = {
    Unknown: 0,
    P360: 360,
    P480: 480,
    P540: 540,
    P576: 576,
    P720: 720,
    P1080: 1080,
    P1440: 1440,
    P2160: 2160,
} as const;

/** getIndexQuality(): pull a pixel height out of a filename/title. */
export const getIndexQuality = (str?: string): number => {
    const m = /\b(2160|1440|1080|720|576|540|480)\s*[pP]\b/.exec(str ?? '');
    return m ? parseInt(m[1]) : Qualities.Unknown;
};

/** getQualityFromName(): map a loose quality string to a pixel height. */
export const getQualityFromName = (str?: string): number => {
    const s = (str ?? '').toLowerCase();
    if (s.includes('2160') || s.includes('4k')) return Qualities.P2160;
    if (s.includes('1440')) return Qualities.P1440;
    if (s.includes('1080')) return Qualities.P1080;
    if (s.includes('720')) return Qualities.P720;
    if (s.includes('576')) return Qualities.P576;
    if (s.includes('540')) return Qualities.P540;
    if (s.includes('480')) return Qualities.P480;
    if (s.includes('360')) return Qualities.P360;
    const n = parseInt(s);
    return Number.isFinite(n) && n > 0 ? n : Qualities.Unknown;
};

export const qualityLabel = (q?: number): string | undefined =>
    q && q > 0 ? `${q}p` : undefined;

/** String.createSlug(): keep letters/digits/whitespace, trim, spaces->'-', lowercase. */
export const createSlug = (str?: string): string | undefined =>
    str
        ?.split('').filter(c => /\s/.test(c) || /[\p{L}\p{N}]/u.test(c)).join('')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase();

export const base64Decode = (s: string): string => Buffer.from(s, 'base64').toString('utf-8');
export const base64Encode = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

/** Map a language code/name to a display label (best-effort subset). */
const languageMap: Record<string, string[]> = {
    English: ['en', 'eng', 'english'],
    Hindi: ['hi', 'hin', 'hindi'],
    Tamil: ['ta', 'tam', 'tamil'],
    Telugu: ['te', 'tel', 'telugu'],
    Spanish: ['es', 'spa', 'spanish', 'espanol', 'español'],
    French: ['fr', 'fre', 'fra', 'french'],
    Arabic: ['ar', 'ara', 'arabic'],
    Japanese: ['ja', 'jpn', 'japanese'],
    Korean: ['ko', 'kor', 'korean'],
    Chinese: ['zh', 'chi', 'zho', 'chinese'],
    German: ['de', 'ger', 'deu', 'german'],
    Portuguese: ['pt', 'por', 'portuguese'],
    Russian: ['ru', 'rus', 'russian'],
    Indonesian: ['id', 'ind', 'indonesian'],
    Malay: ['ms', 'may', 'msa', 'malay'],
    Italian: ['it', 'ita', 'italian'],
};

/** ROT13, port of hdhubpen(). */
const rot13 = (value: string): string =>
    value.replace(/[a-zA-Z]/g, c => {
        const base = c <= 'Z' ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
    });

/**
 * getRedirectLinks() — port of StreamPlayUtils.kt#getRedirectLinks.
 * HDHub4u / 4kHDHub "tech" redirect pages embed the real host URL behind a
 * ROT13 + multi-layer base64 obfuscation. Returns the resolved URL, or the
 * original url on any failure.
 */
export const getRedirectLinks = async (url: string): Promise<string> => {
    const { app } = await import('./http');
    try {
        const doc = (await app.get(url)).text;
        const re = /s\('o','([A-Za-z0-9+/=]+)'|ck\('_wp_http_\d+','([^']+)'/g;
        let combined = '';
        let m: RegExpExecArray | null;
        while ((m = re.exec(doc)) !== null) {
            const v = m[1] || m[2];
            if (v) combined += v;
        }
        if (!combined) return url;

        const decodedString = base64Decode(rot13(base64Decode(base64Decode(combined))));
        const obj = JSON.parse(decodedString);
        const encodedurl = base64Decode(obj.o || '').trim();
        const dataDecoded = base64Decode(obj.data || '').trim();
        const wphttp1 = (obj.blog_url || '').trim();

        let directlink = '';
        if (wphttp1) {
            try {
                directlink = (await app.get(`${wphttp1}?re=${dataDecoded}`.trim())).document('body').text().trim();
            } catch { /* ignore */ }
        }
        return encodedurl || directlink || url;
    } catch {
        return url;
    }
};

export const getLanguage = (code: string): string => {
    const lower = (code || '').toLowerCase();
    for (const [name, codes] of Object.entries(languageMap)) {
        if (codes.includes(lower)) return name;
    }
    return code || 'Unknown';
};
