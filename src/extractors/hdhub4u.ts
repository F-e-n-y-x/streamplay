import { Provider, LinkData, ExtractorResult } from '../types';
import { safeGet } from '../utils/http';
import { getDomain } from '../utils/domains';
import { loadExtractor } from '../utils/hostextractors';
import { getRedirectLinks } from '../utils/common';

/**
 * HDHub4u — ported from invokehdhub4u (StreamPlayExtractor.kt ~3391).
 *
 * Flow:
 *   1. search via Typesense (search.pingora.fyi) by title -> hits[].document
 *      {post_title, permalink}; keep posts whose cleaned title contains the
 *      normalized query (+ season text / year as applicable).
 *   2. if imdbId given, narrow to posts whose page links to imdb.com/title/<imdbId>.
 *   3. movie: `h3/h4 a:matches(480|720|1080|2160|4K)` -> if href has `id=`,
 *             resolve via getRedirectLinks -> loadExtractor.
 *      tv:    `h3` blocks -> episode link matching `episode N` -> episode page ->
 *             h3/h4/h5 a host links (resolve `id=` via getRedirectLinks); plus a
 *             "watch" link.
 */
const normAlphaNum = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const QUALITY_RE = /480|720|1080|2160|4K/i;

export const HdHub4uProvider: Provider = {
    id: 'hdhub4u',
    name: 'HDHub4u',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        const title = data.title;
        if (!title) return result;

        try {
            const baseUrl = await getDomain('hdhub4u');

            const searchUrl =
                'https://search.pingora.fyi/collections/post/documents/search' +
                `?q=${encodeURIComponent(title)}` +
                '&query_by=post_title,category' +
                '&query_by_weights=4,2' +
                '&sort_by=sort_by_date:desc' +
                '&limit=20&highlight_fields=none&use_cache=true&page=1';

            const response = await safeGet(searchUrl, { referer: baseUrl });
            const json = response.json<any>();
            const hits: any[] = json?.hits || [];
            if (!hits.length) return result;

            const normalizedTitle = normAlphaNum(title);
            const seasonText = data.season != null ? `season ${data.season}` : null;

            const posts: string[] = [];
            for (const hit of hits) {
                const document = hit?.document;
                if (!document) continue;
                const postTitle = (document.post_title || '').toLowerCase();
                const rawPermalink = document.permalink || '';
                const permalink = /^http/i.test(rawPermalink) ? rawPermalink : (baseUrl || '') + rawPermalink;
                if (!postTitle || !permalink) continue;

                const cleanTitle = normAlphaNum(postTitle);
                let matches: boolean;
                if (data.season != null) {
                    matches = cleanTitle.includes(normalizedTitle) && postTitle.includes(seasonText!);
                } else if (data.year != null) {
                    matches = cleanTitle.includes(normalizedTitle) && postTitle.includes(data.year.toString());
                } else {
                    matches = cleanTitle.includes(normalizedTitle);
                }
                if (matches) posts.push(permalink);
            }

            let matchedPosts = posts;
            if (data.imdbId) {
                const narrowed: string[] = [];
                for (const postUrl of posts) {
                    const postDoc = (await safeGet(postUrl, { cloudflare: true })).document;
                    const imdbHref = postDoc(`a[href*="imdb.com/title/${data.imdbId}"]`).attr('href');
                    if (imdbHref) narrowed.push(postUrl);
                }
                matchedPosts = narrowed.length ? narrowed : posts;
            }

            const collected = new Set<string>();

            for (const el of matchedPosts) {
                const doc = (await safeGet(el, { cloudflare: true })).document;

                if (data.season == null) {
                    const qualityLinks = doc('h3 a, h4 a').toArray()
                        .filter(a => QUALITY_RE.test(doc(a).text()));
                    for (const linkEl of qualityLinks) {
                        const resolvedLink = doc(linkEl).attr('href') || '';
                        if (!resolvedLink) continue;
                        const resolved = resolvedLink.includes('id=')
                            ? await getRedirectLinks(resolvedLink)
                            : resolvedLink;
                        collected.add(resolved || resolvedLink);
                    }
                } else {
                    const epRe = /episode\s*(\d+)/i;
                    const h3s = doc('h3').toArray();
                    for (const h3 of h3s) {
                        const links = doc(h3).find('a[href]').toArray();
                        const episodeLink = links.find(a => /episode/i.test(doc(a).text()));
                        const watchLink = links.find(a => doc(a).text().trim().toLowerCase() === 'watch');

                        const epMatch = epRe.exec(episodeLink ? doc(episodeLink).text() : '');
                        const episodeNum = epMatch ? parseInt(epMatch[1], 10) : null;

                        if (episodeNum != null && (data.episode == null || data.episode === episodeNum)) {
                            if (episodeLink) {
                                const href = doc(episodeLink).attr('href') || '';
                                if (href) {
                                    const resolvedEp = href.includes('id=') ? await getRedirectLinks(href) : href;
                                    try {
                                        const episodeDoc = (await safeGet(resolvedEp || href, { cloudflare: true })).document;
                                        episodeDoc('h3 a[href], h4 a[href], h5 a[href]').each((_, a) => {
                                            const link = episodeDoc(a).attr('href') || '';
                                            if (link) collected.add(link);
                                        });
                                    } catch { /* ignore */ }
                                }
                            }
                            if (watchLink) {
                                const watchHref = doc(watchLink).attr('href') || '';
                                if (watchHref) {
                                    const resolvedWatch = watchHref.includes('id=') ? await getRedirectLinks(watchHref) : watchHref;
                                    collected.add(resolvedWatch || watchHref);
                                }
                            }
                        }
                    }
                }
            }

            // resolve any remaining id= entries collected from episode pages
            for (const link of collected) {
                const finalLink = link.includes('id=') ? await getRedirectLinks(link) : link;
                const hosted = await loadExtractor(finalLink || link, '');
                result.streams.push(...hosted.streams.map(s => ({ ...s, server: `HDHub4u ${s.server}` })));
                result.subtitles.push(...hosted.subtitles);
            }
        } catch (e: any) {
            console.error('Error in HDHub4u extractor:', e?.message || e);
        }
        return result;
    },
};
