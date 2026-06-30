import { Router } from 'express';
import axios from 'axios';
import { searchTMDB, getTMDBInfo } from '../tmdb';
import { resolveAnimeIds } from '../anime';
import { getProviders } from '../extractors';
import { providerDomains } from '../providersList';
import { LinkData, ExtractorResult } from '../types';

const router = Router();

router.get('/providers/status', async (req, res) => {
    const promises = providerDomains.map(async (provider) => {
        const start = Date.now();
        try {
            await axios.get(provider.url, { timeout: 5000 });
            return {
                ...provider,
                isWorking: true,
                pingMs: Date.now() - start
            };
        } catch (error: any) {
            // If we get a response (like 403 or 401), the domain is technically reachable,
            // but let's count it as working if the domain resolves and responds.
            if (error.response) {
                return {
                    ...provider,
                    isWorking: true,
                    pingMs: Date.now() - start,
                    status: error.response.status
                };
            }
            return {
                ...provider,
                isWorking: false,
                pingMs: -1,
                error: error.message
            };
        }
    });

    const results = await Promise.all(promises);
    res.json(results);
});

router.get('/search', async (req, res) => {
    const query = req.query.q as string;
    if (!query) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
    }
    const results = await searchTMDB(query);
    res.json(results);
});

router.get('/info', async (req, res) => {
    const id = parseInt(req.query.id as string);
    const type = req.query.type as 'movie' | 'tv';

    if (!id || !type) {
        return res.status(400).json({ error: 'Parameters "id" and "type" are required' });
    }

    const info = await getTMDBInfo(id, type);
    if (!info) {
        return res.status(404).json({ error: 'Not found' });
    }
    res.json(info);
});

router.get('/streams', async (req, res) => {
    const id = parseInt(req.query.id as string);
    const type = req.query.type as 'movie' | 'tv';
    const season = req.query.season ? parseInt(req.query.season as string) : undefined;
    const episode = req.query.episode ? parseInt(req.query.episode as string) : undefined;

    if (!id || !type) {
        return res.status(400).json({ error: 'Parameters "id" and "type" are required' });
    }

    const info = await getTMDBInfo(id, type);
    if (!info) {
        return res.status(404).json({ error: 'Metadata not found' });
    }

    const isAnime = info.isAnime ?? false;
    let animeIds = undefined;

    if (isAnime) {
        animeIds = await resolveAnimeIds(id, type, info.title, info.year?.toString());
    }

    const linkData: LinkData = {
        id,
        imdbId: info.imdbId,
        type,
        season,
        episode,
        title: info.title,
        year: info.year,
        orgTitle: info.originalTitle,
        isAnime,
        isAsian: info.isAsian,
        isBollywood: info.isBollywood,
        animeIds
    };

    const providers = getProviders();
    const results: ExtractorResult = { streams: [], subtitles: [] };

    // Per-provider timeout so one slow source (e.g. a Cloudflare site going
    // through FlareSolverr) can't hang the whole request.
    const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS) || 45000;
    const empty: ExtractorResult = { streams: [], subtitles: [] };
    const withTimeout = (p: typeof providers[number]) =>
        Promise.race<ExtractorResult>([
            p.invoke(linkData),
            new Promise<ExtractorResult>(resolve =>
                setTimeout(() => resolve(empty), PROVIDER_TIMEOUT_MS)
            ),
        ]).catch(err => {
            console.error(`Provider ${p.name} failed:`, err?.message || err);
            return empty;
        });

    // Run all extractors concurrently
    const providerResults = await Promise.all(providers.map(withTimeout));

    providerResults.forEach(pr => {
        results.streams.push(...pr.streams);
        results.subtitles.push(...pr.subtitles);
    });

    // Remove duplicates
    results.streams = results.streams.filter((v, i, a) => a.findIndex(t => (t.link === v.link)) === i);
    results.subtitles = results.subtitles.filter((v, i, a) => a.findIndex(t => (t.url === v.url)) === i);

    res.json(results);
});

export default router;
