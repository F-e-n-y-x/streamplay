import { Provider, LinkData, ExtractorResult } from '../types';
import { app } from '../utils/http';
import { getIndexQuality, qualityLabel } from '../utils/common';

const dahmerMoviesAPI = 'https://a.111477.xyz';

/** getIndexQualityTags() port: pull the release tags out of a filename. */
const getIndexQualityTags = (str?: string): string => {
    const m = /\d{3,4}[pP]\.?(.*?)\.(mkv|mp4|avi)/i.exec(str ?? '');
    return m?.[1]?.replace(/\./g, ' ').trim() || (str ?? '');
};

const pad2 = (n?: number): string => (n != null && n < 10 ? `0${n}` : `${n}`);

/**
 * DahmerMovies — ported from invokeDahmerMovies (StreamPlayExtractor.kt).
 * Browses an Apache-style directory listing and picks the matching files.
 */
export const DahmerMoviesProvider: Provider = {
    id: 'dahmermovies',
    name: 'DahmerMovies',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };

        try {
            const season = data.type === 'tv' ? data.season : undefined;
            const episode = data.type === 'tv' ? data.episode : undefined;
            const title = data.title;
            const year = data.year;

            const url = season == null
                ? `${dahmerMoviesAPI}/movies/${title.replace(/:/g, '')} (${year})/`
                : `${dahmerMoviesAPI}/tvs/${title.replace(/:/g, ' -')}/Season ${season}/`;

            const req = await app.get(encodeURI(url), { timeout: 60000 });
            if (!req.isSuccessful) return result;

            const $ = req.document;
            const epRegex = season == null
                ? /(1080p|2160p)/i
                : new RegExp(`S${pad2(season)}E${pad2(episode)}`, 'i');

            $('a').each((_, el) => {
                const text = $(el).text();
                const href = $(el).attr('href') || '';
                if (!epRegex.test(text)) return;

                const quality = getIndexQuality(text);
                const tags = getIndexQualityTags(text);
                const link = href.includes(dahmerMoviesAPI)
                    ? href
                    : dahmerMoviesAPI + (href.startsWith('/') ? href : '/' + href);

                result.streams.push({
                    server: `DahmerMovies ${tags}`.trim(),
                    link,
                    type: link.includes('.m3u8') ? 'm3u8' : 'mp4',
                    quality: qualityLabel(quality),
                });
            });
        } catch (e: any) {
            console.error('Error in DahmerMovies extractor:', e?.message || e);
        }

        return result;
    }
};
