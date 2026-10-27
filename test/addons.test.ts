import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

// Isolated server-config file + admin token, set before the modules read them.
process.env.SERVER_CONFIG_FILE = path.join(os.tmpdir(), `sp-addons-test-${process.pid}.json`);
process.env.ADMIN_TOKEN = 'test-admin';

type Nuvio = typeof import('../src/extractors/nuvio');
type Stremio = typeof import('../src/extractors/stremio');
let nuvio: Nuvio, stremio: Stremio, cfg: typeof import('../src/utils/serverConfig'), ssrf: typeof import('../src/utils/ssrf');
let CATALOG: typeof import('../src/addons/catalog').CATALOG;
let fixture: http.Server, base = '';
let api: http.Server, apiBase = '';

// Hand-written fixture scrapers (never third-party code).
const SCRAPER_JS = `module.exports = { getStreams: async () => [{ url: 'https://cdn.x/a.m3u8', title: 'A' }] };`;
const MANIFEST = {
    name: 'Fixture Repo', version: '1.0.0',
    providers: [   // non-standard key, still accepted
        { id: 'one', name: 'One', filename: 'one.min.js', supportedTypes: ['movie', 'series'] },
        { id: 'two', name: 'Two', filename: './sub/two.js', supportedTypes: ['anime'], enabled: false },
    ],
};

before(async () => {
    fixture = http.createServer((req, res) => {
        const u = req.url || '';
        if (u === '/redir') { res.writeHead(302, { Location: '/json' }); return res.end(); }
        if (u === '/json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['a=1; Path=/', 'b=2; Path=/'], 'X-Test': 'yes' }); return res.end('{"v":42}'); }
        if (u === '/bad') { res.writeHead(200); return res.end('not json'); }
        if (u === '/slow') { setTimeout(() => { res.writeHead(200); res.end('late'); }, 3000).unref(); return; }
        if (u === '/repo/manifest.json') { res.writeHead(200); return res.end(JSON.stringify(MANIFEST)); }
        if (u === '/repo/one.min.js' || u === '/repo/sub/two.js') { res.writeHead(200); return res.end(SCRAPER_JS); }
        if (u === '/stremio/manifest.json') { res.writeHead(200); return res.end(JSON.stringify({ id: 'x.addon', name: 'X', resources: [{ name: 'stream', types: ['movie'], idPrefixes: ['tt'] }], types: ['movie'] })); }
        res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => fixture.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    nuvio = await import('../src/extractors/nuvio');
    stremio = await import('../src/extractors/stremio');
    cfg = await import('../src/utils/serverConfig');
    ssrf = await import('../src/utils/ssrf');
    CATALOG = (await import('../src/addons/catalog')).CATALOG;
    ssrf.setAllowedOrigins('fixture', [`${base}/`]);
    const app = express();
    app.use(express.json());
    app.use('/api/addons', (await import('../src/routes/addons')).default);
    api = app.listen(0, '127.0.0.1');
    await new Promise((r) => api.once('listening', r));
    apiBase = `http://127.0.0.1:${(api.address() as AddressInfo).port}/api/addons`;
});
after(() => { fixture.close(); api.close(); });

test('runtime fetch: redirect, re-readable body, real Headers + getSetCookie, clone/blob, json→null, timeout option', async () => {
    const code = `
        module.exports = async function (id, type, s, e) {          // module.exports = fn
            const B = ${JSON.stringify(base)};
            const r = await fetch(B + '/redir');
            const t1 = await r.text(), j = await r.json(), c = r.clone();
            const blob = await c.blob();
            const keys = [...r.headers.keys()].filter((k) => k.startsWith('x-')).join(',');
            const bad = await (await fetch(B + '/bad')).json();
            let to = 'no-timeout';
            try { await fetch(B + '/slow', { timeout: 200 }); } catch (er) { to = 'timed-out'; }
            const sc = structuredClone({ a: [1] }).a[0];
            await new Promise((ok) => queueMicrotask(ok));
            return [{ url: { url: 'https://cdn.x/v.mp4' }, title: [r.status, r.redirected, r.url.endsWith('/json'), t1, j.v, (await c.text()).length,
                blob.size, r.headers.get('x-test'), r.headers.getSetCookie().join('|'), keys, String(bad), to, sc, typeof s, typeof e].join(' ') }];
        };`;
    const [r] = await nuvio.runNuvioScraper(code, 'fx1', ['1', 'movie']);
    assert.deepEqual(r.url, { url: 'https://cdn.x/v.mp4' });
    assert.equal(r.title, '200 true true {"v":42} 42 8 8 yes a=1; Path=/|b=2; Path=/ x-test null timed-out 1 undefined undefined');
    // `url: {url}` maps like a plain url (Nuvio parseJsonResults)
    assert.equal(nuvio.mapNuvioStreams('L', [r]).streams[0].link, 'https://cdn.x/v.mp4');
});

test('runtime exports: exports.getStreams, globalThis.getStreams, esbuild default, global cheerio, TMDB_API_KEY/SCRAPER_SETTINGS', async () => {
    const forms = [
        `exports.getStreams = async (id) => [{ url: 'https://a/' + id, title: 'x' }];`,
        `globalThis.getStreams = async (id) => [{ url: 'https://a/' + id, title: 'x' }];`,
        `module.exports = { default: { getStreams: async (id) => [{ url: 'https://a/' + id, title: 'x' }] } };`,
        `function getStreams(id) { const $ = cheerio.load('<b>' + id + '</b>'); return Promise.resolve([{ url: 'https://a/' + $('b').text(), title: typeof TMDB_API_KEY + typeof SCRAPER_SETTINGS }]); }
         module.exports = { getStreams };`,
    ];
    for (const code of forms) {
        const [r] = await nuvio.runNuvioScraper(code, 'fx', ['7', 'tv', 1, 2]);
        assert.equal(r.url, 'https://a/7', code);
    }
    await assert.rejects(nuvio.runNuvioScraper(`module.exports = {};`, 'fx', ['7', 'movie']), /getStreams not found/);
});

test('parseManifest: alternate list key, type normalisation, manifest-disabled kept only with all=true', () => {
    const def = nuvio.parseManifest(MANIFEST);
    assert.deepEqual(def.scrapers.map((s) => s.id), ['one']);
    assert.deepEqual(def.scrapers[0].supportedTypes, ['movie', 'tv']);   // series → tv
    const all = nuvio.parseManifest(MANIFEST, true);
    assert.deepEqual(all.scrapers.map((s) => [s.id, s.enabled, s.supportedTypes]), [['one', true, ['movie', 'tv']], ['two', false, ['tv']]]);
    assert.equal(nuvio.parseManifest({ plugins: [{ id: 'p', filename: 'p.js' }] }).scrapers[0].name, 'p');
});

test('repoKey: LAN servers keep host:port ids, two GitHub repos never collide', () => {
    assert.equal(nuvio.repoKey('http://192.168.10.10:4001/manifest.json'), '192.168.10.10:4001');
    const a = nuvio.repoKey('https://raw.githubusercontent.com/A/x/refs/heads/main/manifest.json');
    const b = nuvio.repoKey('https://raw.githubusercontent.com/B/y/refs/heads/main/manifest.json');
    assert.match(a, /^raw\.githubusercontent\.com~[0-9a-f]{8}$/);
    assert.notEqual(a, b);
    // a token in the manifest path must never leak into the (public) provider id
    assert.ok(!nuvio.repoKey('https://h.example/SECRET-TOKEN/manifest.json').includes('SECRET'));
});

test('registry: relative/.min.js filenames resolve against the manifest; per-scraper overrides', async () => {
    process.env.NUVIO_PLUGINS = `${base}/repo/manifest.json`;
    await nuvio.reloadNuvio();
    const key = `nuvio:${nuvio.repoKey(`${base}/repo/manifest.json`)}`;
    assert.deepEqual(nuvio.nuvioProviders().map((p) => p.id), [`${key}:one`]);
    const res = await nuvio.nuvioProviders()[0].invoke({ id: 1, type: 'movie', title: 'x' });
    assert.equal(res.streams[0].link, 'https://cdn.x/a.m3u8');
    cfg.setScraperOverrides({ [`${key}:one`]: false, [`${key}:two`]: true });
    assert.deepEqual(nuvio.nuvioProviders().map((p) => p.id), [`${key}:two`]);
    assert.equal((await nuvio.nuvioProviders()[0].invoke({ id: 1, type: 'tv', season: 1, episode: 1, title: 'x' })).streams.length, 1);  // ./sub/two.js
    assert.deepEqual(nuvio.nuvioStatus()[0].scrapers, [`${key}:two`]);
    cfg.setScraperOverrides({ [`${key}:one`]: null, [`${key}:two`]: null });
    assert.deepEqual(nuvio.nuvioProviders().map((p) => p.id), [`${key}:one`]);
});

// PenguPlay-shaped fixture (hand-written, no token).
const PENGU_MANIFEST = {
    id: 'com.example.pengu', version: '1.4.0', name: 'PenguPlay', types: ['movie', 'series', 'tv'],
    resources: [
        { name: 'stream', types: ['movie', 'series', 'tv'], idPrefixes: ['tt', 'tmdb:', 'tvdb:', 'mal:', 'kitsu:', 'anilist:', 'pp-live:'] },
        { name: 'meta', types: ['tv'], idPrefixes: ['pp-live:'] }, { name: 'catalog', types: ['tv'] },
        { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt', 'tmdb:'] },
    ],
    behaviorHints: { configurable: true },
};
const PENGU_STREAMS = [
    { name: '✨ | support the project!', description: 'Thanks' },
    { name: 'PenguPlay', title: 'You must sign in', description: 'Your PenguPlay authentication is missing.', url: 'https://example.invalid/signin.mp4' },
    { url: 'https://example.invalid/direct/external/1', name: '🐧 PenguPlay ❄️ 4K • VidFast · vBlaze',
        description: '🍿 Inception (2010)\n🎞️ 4K • MP4 • BluRay • x264 • ~46.4 Mbps\n🛰️ Source: x',
        behaviorHints: { notWebReady: true, bingeGroup: 'g', videoSize: 49_820_000_000, proxyHeaders: { request: { 'User-Agent': 'UA/1' } } } },
    { url: 'https://example.invalid/direct/external/2', name: '🐧 PenguPlay ❄️ 1080p • 4KHDHub',
        description: '🍿 Inception (2010)\n🎞️ 1080p • MKV • WEB-DL • HEVC', behaviorHints: { notWebReady: true, filename: 'Inception.2010.1080p.WEB-DL.x265.mkv' },
        subtitles: [{ id: '1', url: 'https://example.invalid/en.srt', lang: 'eng' }] },
];

test('stremio: object resources + idPrefixes, best id form per title', () => {
    const m = stremio.parseStremioManifest(PENGU_MANIFEST);
    assert.equal(m.name, 'PenguPlay');
    assert.deepEqual(m.stream?.types, ['movie', 'series', 'tv']);
    assert.ok(m.subtitles);
    const tv = { id: 1396, imdbId: 'tt0903747', type: 'tv' as const, season: 1, episode: 2, title: 'x' };
    assert.deepEqual(stremio.stremioId(tv, m.stream!), { type: 'series', id: 'tt0903747:1:2' });
    assert.deepEqual(stremio.stremioId({ ...tv, imdbId: undefined }, m.stream!), { type: 'series', id: 'tmdb:1396:1:2' });
    const anime = { id: 0, type: 'tv' as const, episode: 3, title: 'x', animeIds: { anilistId: 21, malId: 5 } };
    assert.deepEqual(stremio.stremioId(anime, m.stream!), { type: 'series', id: 'anilist:21:3' });
    // classic addon: string resources, no idPrefixes → IMDb only
    const classic = stremio.parseStremioManifest({ name: 'T', resources: ['stream'], types: ['movie', 'series'] });
    assert.equal(stremio.stremioId({ ...tv, imdbId: undefined }, classic.stream!), null);
    assert.equal(stremio.stremioId({ id: 1, type: 'movie', title: 'x' }, m.subtitles!)?.id, 'tmdb:1');
    assert.equal(stremio.parseStremioManifest({ resources: ['catalog', 'meta'] }).stream, undefined);
});

test('stremio: PenguPlay-shaped streams → label, quality, size, headers, remux flag, subtitles; placeholders skipped', () => {
    const r = stremio.mapStremioStreams('PenguPlay', PENGU_STREAMS);
    assert.equal(r.http.length, 2);
    const [a, b] = r.http;
    assert.equal(a.server, 'PenguPlay · VidFast · vBlaze · 4K • MP4 • BluRay • x264 • ~46.4 Mbps · 46.4 GB');
    assert.equal(a.quality, '2160p');
    assert.deepEqual(a.headers, { 'User-Agent': 'UA/1' });
    assert.equal(a.type, 'mp4');
    assert.equal(a.debrid, undefined);           // notWebReady mp4/h264 → normal proxy (seekable)
    assert.equal(b.quality, '1080p');
    assert.equal(b.debrid, true);                // MKV/HEVC → ffmpeg remux path
    assert.match(b.server, /^PenguPlay · 4KHDHub · Inception\.2010\.1080p\.WEB-DL\.x265\.mkv$/);
    assert.deepEqual(r.subtitles, [{ language: 'eng', url: 'https://example.invalid/en.srt' }]);
    assert.deepEqual(stremio.mapStremioSubs([{ url: 'https://s/1.vtt', lang: 'fre' }, { url: 'ftp://x' }]), [{ language: 'fre', url: 'https://s/1.vtt' }]);
});

test('catalog: well-formed, unique, token-free', () => {
    const urls = new Set<string>();
    for (const e of CATALOG) {
        assert.match(e.manifestUrl, /^https:\/\/.+\/manifest\.json$/, e.name);
        assert.ok(!urls.has(e.manifestUrl), `duplicate ${e.manifestUrl}`);
        urls.add(e.manifestUrl);
        assert.ok(['nuvio', 'stremio'].includes(e.kind) && e.description && e.tags.length && /^\d{4}-\d\d-\d\d$/.test(e.lastChecked), e.name);
        assert.equal(e.obfuscated, (e.obfuscatedCount || 0) > 0, e.name);
    }
});

test('routes: catalog / inspect (no code run) / scrapers toggles, admin-gated', async () => {
    const post = (p: string, body: unknown, token = 'test-admin') =>
        fetch(apiBase + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token }, body: JSON.stringify(body) });
    const cat = await (await fetch(apiBase + '/catalog')).json();
    assert.equal(cat.entries.length, CATALOG.length);
    assert.equal((await post('/inspect', { url: `${base}/repo/manifest.json` }, 'wrong')).status, 403);
    const n = await (await post('/inspect', { url: `${base}/repo/manifest.json` })).json();
    assert.equal(n.kind, 'nuvio');
    assert.deepEqual(n.scrapers.map((s: any) => [s.id, s.enabled]), [['one', true], ['two', false]]);
    const s = await (await post('/inspect', { url: `${base}/stremio/manifest.json` })).json();
    assert.equal(s.kind, 'stremio');
    assert.deepEqual(s.stream, { types: ['movie'], prefixes: ['tt'] });
    assert.equal((await post('/inspect', { url: 'http://10.0.0.1/manifest.json' })).status, 422);   // SSRF-guarded
    assert.equal((await post('/inspect', { url: 'file:///etc/passwd' })).status, 400);
    const list = await (await fetch(apiBase + '/scrapers')).json();
    assert.match(list.repos[0].manifest, /\/…$/);   // masked without the token
    const id = list.repos[0].scrapers[0].id;
    assert.equal((await post('/scrapers', { changes: { 'evil': true } })).status, 400);
    const after = await (await post('/scrapers', { changes: { [id]: false } })).json();
    assert.equal(after.repos[0].scrapers[0].enabled, false);
    await post('/scrapers', { changes: { [id]: null } });
});

test('stremio: PenguPlay "|^|" filenames → source label; wrong show / episode files dropped', () => {
    const d = { id: 1396, type: 'tv' as const, title: 'Breaking Bad', season: 1, episode: 1 };
    const s = (filename: string) => ({ url: 'https://example.invalid/x.m3u8', name: '✨ 1080p', description: '', behaviorHints: { filename } });
    const r = stremio.mapStremioStreams('PenguPlay', [
        s('1080pHLS1080phls|^|.pad-VidFast'),
        s('Breaking.Bad.2008.S01E01.720p.x265.mkv|^|720pMKV.pad-Arctic'),
        s('AnimeDubHindi.The.Bad.Guys.Breaking.In.S01E01.720p.mkv|^|720pMKV.pad-Arctic'),
        s('Breaking.Bad.S01E02.1080p.mkv'),
    ], d);
    assert.deepEqual(r.http.map((x) => x.server), ['PenguPlay · VidFast', 'PenguPlay · Arctic · Breaking.Bad.2008.S01E01.720p.x265.mkv']);
    assert.equal(stremio.fileMatches('Daredevil.Born.Again.S01E01.mkv', { ...d, title: "Marvel's Daredevil: Born Again" }), true);
    assert.equal(stremio.fileMatches('The.Kardashians.S07E03.mkv', { ...d, title: 'The Kardashians', season: 7, episode: 3 }), true);
});
