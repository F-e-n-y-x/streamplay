import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseManifest, kindsFor, mapNuvioStreams, runNuvioScraper } from '../src/extractors/nuvio';
import { mapStremioStreams } from '../src/extractors/stremio';
import { guardUrl, setAllowedOrigins } from '../src/utils/ssrf';

test('parseManifest: {scrapers:[]} and bare-array shapes, disabled/invalid dropped', () => {
    const m = parseManifest({ name: 'Anime', scrapers: [
        { id: 'anime', name: 'Anime (All)', filename: 'providers/a.js', supportedTypes: ['movie', 'tv'] },
        { id: 'off', name: 'Off', filename: 'o.js', enabled: false },
        { name: 'no id', filename: 'x.js' },
    ] });
    assert.equal(m.name, 'Anime');
    assert.deepEqual(m.scrapers.map((s) => s.id), ['anime']);
    const bare = parseManifest([{ id: 'v', name: 'V', filename: 'v.js' }]);
    assert.deepEqual(bare.scrapers[0].supportedTypes, ['movie', 'tv']);   // default
    assert.deepEqual(parseManifest(null).scrapers, []);
});

test('kindsFor: movie / tv / both', () => {
    assert.deepEqual(kindsFor(['movie']), ['movie']);
    assert.deepEqual(kindsFor(['tv']), ['series', 'anime', 'asian']);
    assert.equal(kindsFor(['movie', 'tv']), undefined);
});

test('mapNuvioStreams: url/type/quality/headers/subtitles; non-http dropped', () => {
    const r = mapNuvioStreams('Anime', [
        { name: '1. ⭐ AniKotoAPI · HD-1 [DUB]', url: 'http://192.168.10.10:4001/anime-hls?u=x', type: 'm3u8', language: 'English', quality: '1080p' },
        { title: 'CineStream', provider: 'MovieBox', url: 'https://cdn.x/v.mp4', headers: { Referer: 'https://a/', bad: 1 }, quality: 720, size: '1.2 GB',
            subtitles: [{ url: 'https://s/en.vtt', lang: 'en' }] },
        { name: 'hls by format', url: 'https://cdn.x/master', format: 'HLS', resolution: '4K' },
        { name: 'magnet', url: 'magnet:?xt=urn:btih:abc', infoHash: 'abc' },
    ]);
    assert.equal(r.streams.length, 3);
    assert.deepEqual(r.streams[0], { server: 'Anime · AniKotoAPI · HD-1 [DUB] · English', link: 'http://192.168.10.10:4001/anime-hls?u=x', type: 'm3u8', quality: '1080p' });
    assert.equal(r.streams[1].type, 'mp4');
    assert.equal(r.streams[1].quality, '720p');
    assert.deepEqual(r.streams[1].headers, { Referer: 'https://a/' });
    assert.match(r.streams[1].server, /MovieBox · 1\.2 GB$/);
    assert.equal(r.streams[2].type, 'm3u8');
    assert.equal(r.streams[2].quality, '2160p');
    assert.deepEqual(r.subtitles, [{ language: 'en', url: 'https://s/en.vtt' }]);
});

test('mapStremioStreams: http url vs infoHash (→ magnet)', () => {
    const r = mapStremioStreams('Addon', [
        { name: 'X\n1080p', title: 'Movie.2010.1080p\n👤 5', url: 'https://cdn/a.mkv', behaviorHints: { proxyHeaders: { request: { Referer: 'https://r/' } } } },
        { name: 'T\n4k', title: 'Movie 2160p', infoHash: 'ABCDEF0123456789ABCDEF0123456789ABCDEF01' },
        { name: 'yt', ytId: 'x' },
    ]);
    assert.equal(r.http.length, 1);
    assert.deepEqual(r.http[0].headers, { Referer: 'https://r/' });
    assert.equal(r.http[0].quality, '1080p');
    assert.equal(r.torrent.length, 1);
    assert.match(r.torrent[0].link, /^magnet:\?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&/);
    assert.equal(r.torrent[0].quality, '2160p');
});

test('ssrf allowlist: exact scheme+host+port of configured manifests only', () => {
    setAllowedOrigins('test', ['http://192.168.10.10:4001/manifest.json']);
    assert.equal(guardUrl('http://192.168.10.10:4001/anime-hls?u=1'), null);
    assert.equal(guardUrl('http://192.168.10.10:4002/x'), 'blocked host');
    assert.equal(guardUrl('https://192.168.10.10:4001/x'), 'blocked host');
    assert.equal(guardUrl('http://192.168.10.11:4001/x'), 'blocked host');
    setAllowedOrigins('test', []);
    assert.equal(guardUrl('http://192.168.10.10:4001/x'), 'blocked host');
});

test('runNuvioScraper: Nuvio globals + require whitelist, no process/Buffer (no network)', async () => {
    const code = `
        const cheerio = require('cheerio-without-node-native');
        const CryptoJS = require('crypto-js');
        let fsErr = ''; try { require('fs'); } catch (e) { fsErr = e.message; }
        async function getStreams(id, type, s, e) {
            const $ = cheerio.load('<a href="https://cdn.x/v.m3u8">x</a>');
            const res = await fetch('http://127.0.0.1:1/never').catch((er) => ({ status: 'blocked' }));
            return [{ url: $('a').attr('href'), title: [typeof process, typeof Buffer, fsErr, CryptoJS.MD5('a').toString(), id, type, s, String(e), res.status, typeof SCRAPER_SETTINGS, SCRAPER_ID].join('|') }];
        }
        module.exports = { getStreams };`;
    const [r] = await runNuvioScraper(code, 't1', ['27205', 'movie']);
    assert.equal(r.url, 'https://cdn.x/v.m3u8');
    assert.equal(r.title, `undefined|undefined|Module 'fs' is not available|0cc175b9c0f1b6a831c399e269772661|27205|movie||undefined|blocked|object|t1`);
});
