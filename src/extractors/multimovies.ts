import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet, app } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';
import { createSlug } from '../utils/common';

/**
 * MultiMovies — ported from invokeMultimovies (StreamPlayExtractor.kt ~112).
 *
 * Standard WordPress / "Dooplay" pattern:
 *   1. build /movies/<slug> or /episodes/<slug>-<season>x<episode>
 *   2. read the player options (ul#playeroptionsul li)
 *   3. POST admin-ajax (doo_player_ajax) per option to resolve an embed_url
 *   4. loadExtractor each embed host.
 */
export const MultiMoviesProvider: Provider = {
    id: 'multimovies',
    name: 'MultiMovies',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        try {
            const api = await getDomain('multiMovies');
            if (!api) return result;

            const slug = createSlug(data.title);
            if (!slug) return result;

            const url = data.season == null
                ? `${api}/movies/${slug}`
                : `${api}/episodes/${slug}-${data.season}x${data.episode}`;

            const res = await safeGet(url, { cloudflare: true });
            if (res.status !== 200) return result;
            if (/just a moment/i.test(res.text)) return result;

            const $ = res.document;
            const options: Array<{ post: string; nume: string; type: string }> = [];
            $('ul#playeroptionsul li').each((_, el) => {
                options.push({
                    post: $(el).attr('data-post') || '',
                    nume: $(el).attr('data-nume') || '',
                    type: $(el).attr('data-type') || '',
                });
            });

            for (const opt of options) {
                if (/trailer/i.test(opt.nume)) continue;
                try {
                    const body = new URLSearchParams({
                        action: 'doo_player_ajax',
                        post: opt.post,
                        nume: opt.nume,
                        type: opt.type,
                    });
                    const postRes = await app.post(`${api}/wp-admin/admin-ajax.php`, body, {
                        referer: url,
                        headers: {
                            'X-Requested-With': 'XMLHttpRequest',
                            'Content-Type': 'application/x-www-form-urlencoded',
                        },
                    });
                    if (postRes.status !== 200) continue;

                    const json = postRes.json<{ embed_url?: string }>();
                    let embedUrl = (json?.embed_url || '').trim().replace(/^"|"$/g, '');
                    if (!embedUrl.startsWith('http')) continue;
                    if (/youtube/i.test(embedUrl)) continue;

                    const hosted = await loadExtractor(embedUrl, `${api}/`);
                    result.streams.push(...hosted.streams.map(s => ({ ...s, server: `MultiMovies ${s.server}` })));
                    result.subtitles.push(...hosted.subtitles);
                } catch { /* skip this option */ }
            }
        } catch (e: any) {
            console.error('Error in MultiMovies extractor:', e?.message || e);
        }
        return result;
    },
};
