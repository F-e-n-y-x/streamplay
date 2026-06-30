import axios from 'axios';
import * as cheerio from 'cheerio';
import { Provider, LinkData, ExtractorResult } from '../types';

const TWOEMBED_API = 'https://www.2embed.cc';

export const TwoEmbedProvider: Provider = {
    id: '2embed',
    name: '2Embed',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (data.isAnime) return result;
        if (!data.imdbId) return result;

        try {
            const url = data.season == null 
                ? `${TWOEMBED_API}/embed/${data.imdbId}` 
                : `${TWOEMBED_API}/embedtv/${data.imdbId}?s=${data.season}&e=${data.episode}`;

            const res = await axios.get(url, {
                headers: {
                    'Referer': url
                }
            });

            const $ = cheerio.load(res.data);
            const iframeSrc = $('iframe#iframesrc').attr('data-src');

            if (iframeSrc) {
                // Return iframe source so frontend can embed it
                // We mark type as 'iframe' - we should update types.ts to support 'iframe'
                result.streams.push({
                    server: '2Embed (Iframe)',
                    link: iframeSrc,
                    type: 'iframe' as any,
                });
            }
        } catch (error) {
            console.error('Error in 2Embed extractor:', error);
        }

        return result;
    }
};
