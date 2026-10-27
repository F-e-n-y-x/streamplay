import net from '../utils/net';
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

            const res = await net.get(url, {
                headers: {
                    'Referer': url,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
                },
                timeout: 15000,
            });

            const $ = cheerio.load(res.data);
            const iframeSrc = $('iframe#iframesrc').attr('data-src');

            if (iframeSrc) {
                // Return the iframe source so the frontend can embed it. ('iframe'
                // is a first-class Stream type — see types.ts.)
                result.streams.push({
                    server: '2Embed (Iframe)',
                    link: iframeSrc,
                    type: 'iframe',
                });
            }
        } catch (error) {
            console.error('Error in 2Embed extractor:', error);
        }

        return result;
    }
};
