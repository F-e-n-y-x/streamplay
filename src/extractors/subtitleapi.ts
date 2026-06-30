import { Provider, LinkData, ExtractorResult } from '../types';
import { app } from '../utils/http';
import { getLanguage } from '../utils/common';

const SubtitlesAPI = 'https://opensubtitles-v3.strem.io';

interface OpenSubtitle {
    id: string;
    url: string;
    SubEncoding?: string;
    lang: string;
    m?: string;
    g?: string;
}

interface SubtitlesAPIResponse {
    subtitles: OpenSubtitle[];
    cacheMaxAge?: number;
}

/** Title-case the first character, mirroring Kotlin's replaceFirstChar { titlecase }. */
const titlecaseFirst = (s: string): string =>
    s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

/**
 * SubtitleAPI — ported from invokeSubtitleAPI (StreamPlayExtractor.kt).
 * Hits the opensubtitles-v3 Stremio addon keyed by IMDB id and emits each subtitle.
 */
export const SubtitleApiProvider: Provider = {
    id: 'subtitleapi',
    name: 'SubtitleAPI',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        const id = data.imdbId;
        if (!id) return result;

        try {
            const url = data.season == null
                ? `${SubtitlesAPI}/subtitles/movie/${id}.json`
                : `${SubtitlesAPI}/subtitles/series/${id}:${data.season}:${data.episode}.json`;

            const headers = {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
            };

            const response = await app.get(url, { headers, timeout: 10000 });
            if (response.status !== 200) return result;

            const parsed = response.json<SubtitlesAPIResponse>();
            if (!parsed?.subtitles) return result;

            for (const sub of parsed.subtitles) {
                if (!sub?.url) continue;
                const lang = titlecaseFirst(getLanguage(sub.lang));
                result.subtitles.push({ language: lang, url: sub.url });
            }
        } catch (e: any) {
            console.error('Error in SubtitleAPI:', e?.message || e);
        }

        return result;
    },
};
