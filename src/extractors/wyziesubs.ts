import { Provider, LinkData, ExtractorResult } from '../types';
import { app } from '../utils/http';
import { getLanguage } from '../utils/common';

const WYZIESubsAPI = 'https://sub.wyzie.ru';

interface WYZIESubtitle {
    url: string;
    display?: string;
    language?: string;
}

/**
 * WYZIESubs — ported from invokeWYZIESubs (StreamPlayExtractor.kt).
 * Queries sub.wyzie.ru by IMDB id. The upstream API requires an API key
 * (the Kotlin plugin reads it from the `wyzie_key` shared pref and returns
 * early if blank); here it comes from the WYZIE_KEY env var.
 */
export const WyzieSubsProvider: Provider = {
    id: 'wyziesubs',
    name: 'WYZIESubs',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        // Mirrors `val key = wyziekey.takeIf { !it.isNullOrBlank() } ?: return`.
        const key = process.env.WYZIE_KEY;
        if (!key) return result;

        const id = data.imdbId;
        if (!id) return result;

        try {
            const params: Record<string, any> = { id, source: 'all', key };
            if (data.season != null) {
                params.season = data.season;
                params.episode = data.episode;
            }

            const response = await app.get(`${WYZIESubsAPI}/search`, { params, timeout: 10000 });
            const subs = response.json<WYZIESubtitle[]>();
            if (!Array.isArray(subs)) return result;

            for (const sub of subs) {
                const lang = sub.language;
                if (!lang) continue;
                result.subtitles.push({
                    language: sub.display ?? getLanguage(lang),
                    url: sub.url,
                });
            }
        } catch (e: any) {
            console.error('Error in WYZIESubs:', e?.message || e);
        }

        return result;
    },
};
