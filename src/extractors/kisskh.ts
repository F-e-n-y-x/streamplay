import axios from 'axios';
import { Provider, LinkData, ExtractorResult, Stream, Subtitle } from '../types';

const KISSKH_API = 'https://kisskh.nl';

const createSlug = (title: string): string => {
    return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
};

const getKisskhTitle = (title: string): string => {
    return title.replace(/[^a-zA-Z0-9 ]/g, '').replace(/\s+/g, '-');
};

export const KissKhProvider: Provider = {
    id: 'kisskh',
    name: 'KissKH',
    invoke: async (data: LinkData): Promise<ExtractorResult> => {
        const result: ExtractorResult = { streams: [], subtitles: [] };
        if (data.isAnime) return result;

        try {
            const title = data.title;
            const slug = createSlug(title);
            const type = data.season == null ? "2" : "1";

            const searchRes = await axios.get(`${KISSKH_API}/api/DramaList/Search?q=${encodeURIComponent(title)}&type=${type}`, {
                headers: { 'Referer': `${KISSKH_API}/` }
            });

            const searchResults = searchRes.data;
            if (!searchResults || searchResults.length === 0) return result;

            let id: number | undefined;
            let contentTitle: string | undefined;

            if (searchResults.length === 1) {
                id = searchResults[0].id;
                contentTitle = searchResults[0].title;
            } else {
                const match = searchResults.find((item: any) => {
                    const itemSlug = createSlug(item.title);
                    if (data.season == null) {
                        return itemSlug === slug;
                    }
                    return itemSlug.includes(slug) && (item.title.toLowerCase().includes(`season ${data.season}`) || itemSlug === slug);
                }) || searchResults.find((item: any) => item.title === title);
                id = match?.id;
                contentTitle = match?.title;
            }

            if (!id || !contentTitle) return result;

            const detailRes = await axios.get(`${KISSKH_API}/api/DramaList/Drama/${id}?isq=false`, {
                headers: { 'Referer': `${KISSKH_API}/Drama/${getKisskhTitle(contentTitle)}?id=${id}` }
            });

            const resDetail = detailRes.data;
            const episodeNumber = data.episode || 1;
            
            const episode = data.season == null 
                ? resDetail.episodes[0] 
                : resDetail.episodes.find((e: any) => e.number === episodeNumber);

            if (!episode) return result;
            const epsId = episode.id;

            // Fetch keys
            let kkey, kkey1;
            try {
                const videoKeyRes = await axios.get(`https://kisskh.nl/api/Setting/alts?id=${epsId}&version=2.8.10`);
                kkey = videoKeyRes.data.key;
            } catch(e) {}
            try {
                const subKeyRes = await axios.get(`https://kisskh.nl/api/Setting/alts2?id=${epsId}&version=2.8.10`);
                kkey1 = subKeyRes.data.key;
            } catch(e) {}

            if (!kkey || !kkey1) return result;

            // Fetch video sources
            try {
                const sourcesRes = await axios.get(`${KISSKH_API}/api/DramaList/Episode/${epsId}.png?err=false&ts=&time=&kkey=${kkey}`, {
                    headers: { 'Referer': `${KISSKH_API}/Drama/${getKisskhTitle(contentTitle)}/Episode-${episodeNumber}?id=${id}&ep=${epsId}&page=0&pageSize=100` }
                });
                
                const sourceData = sourcesRes.data;
                const links = [sourceData.Video, sourceData.ThirdParty].filter(Boolean);

                for (const link of links) {
                    if (link.includes('.m3u8') || link.includes('.mp4')) {
                        result.streams.push({
                            server: 'KissKH',
                            link: link,
                            type: link.includes('.m3u8') ? 'm3u8' : 'mp4',
                            quality: '720p',
                            headers: { 'Origin': KISSKH_API, 'Referer': KISSKH_API }
                        });
                    }
                }
            } catch (e) { console.error("Error fetching KissKH video sources", e); }

            // Fetch subtitles
            try {
                const subRes = await axios.get(`${KISSKH_API}/api/Sub/${epsId}?kkey=${kkey1}`);
                if (Array.isArray(subRes.data)) {
                    for (const sub of subRes.data) {
                        if (sub.src) {
                            result.subtitles.push({
                                language: sub.label || 'Unknown',
                                url: sub.src
                            });
                        }
                    }
                }
            } catch (e) { console.error("Error fetching KissKH subtitles", e); }

        } catch (error) {
            console.error('Error in KissKH extractor:', error);
        }

        return result;
    }
};
