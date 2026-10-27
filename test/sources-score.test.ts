import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
process.env.PROVIDER_STATS_FILE = path.join(os.tmpdir(), `sp-stats-test-${process.pid}.json`);
import { sniffMedia, parsePlaylist, scoreSource, streamFacts, parseReport, langScore, webReadyOf, mbpsOf, GOOD_SCORE, audioTracks, failReason } from '../src/utils/sourceProbe';
import { recordPlayback, recordVerify, providerHidden, providerReliability } from '../src/utils/providerStats';

const ts = () => { const b = Buffer.alloc(188 * 4); for (let i = 0; i < 4; i++) b[i * 188] = 0x47; return b; };

test('sniffMedia: TS, TS behind a fake PNG header, fMP4, MKV; rejects HTML', () => {
    assert.equal(sniffMedia(ts()), 'ts');
    assert.equal(sniffMedia(Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(60), ts()])), 'ts');
    assert.equal(sniffMedia(Buffer.from('\0\0\0\x18ftypisom', 'latin1')), 'mp4');
    assert.equal(sniffMedia(Buffer.from('\0\0\0\x10moof\0\0\0\0', 'latin1')), 'mp4');
    assert.equal(sniffMedia(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), 'mkv');
    assert.equal(sniffMedia(Buffer.from('<html><body>403 Forbidden ' + 'G'.repeat(600) + '</body></html>')), null);
    assert.equal(sniffMedia(Buffer.from('{"error":"x"}')), null);
});

test('parsePlaylist: master → max height + first variant; media → EXT-X-MAP before segment', () => {
    const m = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=9,RESOLUTION=1920x800\nhi.m3u8\n', 'https://c.example/a/master.m3u8');
    assert.deepEqual(m, { master: true, height: 1080, next: 'https://c.example/a/low.m3u8', encrypted: false });
    const fm = parsePlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\ns1.m4s\n', 'https://c.example/v/x.m3u8');
    assert.equal(fm.next, 'https://c.example/v/init.mp4');
    const enc = parsePlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:4,\ns1.ts\n', 'https://c.example/v/x.m3u8');
    assert.equal(enc.next, 'https://c.example/v/s1.ts');
    assert.equal(enc.encrypted, true);
});

test('scoreSource: verified beats unverified beats failed; HLS 1080 reliable clears GOOD_SCORE', () => {
    const base = { type: 'm3u8', quality: 1080, latencyMs: 800, reliability: 0.8 };
    const good = scoreSource({ ...base, verified: true });
    assert.ok(good >= GOOD_SCORE, `good=${good}`);
    assert.ok(good > scoreSource({ ...base, verified: 'unknown' }));
    assert.ok(scoreSource({ ...base, verified: 'unknown' }) > scoreSource({ ...base, verified: false }));
    assert.ok(scoreSource({ ...base, verified: true }) > scoreSource({ ...base, verified: true, quality: 480 }));
    assert.ok(scoreSource({ ...base, verified: true }) > scoreSource({ ...base, verified: true, latencyMs: 5500 }));
    assert.ok(scoreSource({ ...base, verified: true }) > scoreSource({ ...base, verified: true, type: 'iframe' }));
    assert.ok(scoreSource({ ...base, verified: true, hidden: true }) < GOOD_SCORE);
});

test('scoreSource: language preference dominates a small quality edge', () => {
    const v = { verified: true as const, type: 'm3u8', latencyMs: 1000, reliability: 0.7 };
    const prefs = { audio: ['Hindi', 'English'] };
    const hindi720 = scoreSource({ ...v, quality: 720, audio: 'Hindi' }, prefs);
    const english1080 = scoreSource({ ...v, quality: 1080, audio: 'English' }, prefs);
    const tamil1080 = scoreSource({ ...v, quality: 1080, audio: 'Tamil' }, prefs);
    assert.ok(hindi720 > english1080 && english1080 > tamil1080);
    assert.ok(tamil1080 < GOOD_SCORE, 'a known language mismatch must not auto-start immediately');
    assert.equal(langScore('AllAnime [DUB]', '', { anime: 'dub' }), 15);
    assert.ok(langScore('AllAnime [DUB]', '', { anime: 'sub' }) < 0);
    assert.equal(langScore('AllAnime [SUB]', '', { anime: 'sub' }), 0);
});

test('parseReport: validates provider/outcome, clamps ttff, trims error', () => {
    const known = new Set(['vidlink']);
    assert.deepEqual(parseReport({ provider: 'vidlink', outcome: 'played', ttffMs: 999999, url: '/api/proxy?url=x' }, known),
        { provider: 'vidlink', outcome: 'played', ttffMs: 120000, url: '/api/proxy?url=x' });
    assert.ok('invalid' in parseReport({ provider: 'nope', outcome: 'played' }, known));
    assert.ok('invalid' in parseReport({ provider: 'vidlink', outcome: 'exploded' }, known));
    assert.ok('invalid' in parseReport({ provider: 'vidlink', outcome: 'failed', ttffMs: 'x' }, known));
    assert.ok('invalid' in parseReport({ provider: 'vidlink', outcome: 'failed', url: 'javascript:1' }, known));
    assert.ok('invalid' in parseReport(null, known));
    const r = parseReport({ provider: 'vidlink', outcome: 'failed', ttffMs: -5, error: 'e'.repeat(500) }, known) as any;
    assert.equal(r.ttffMs, 0);
    assert.equal(r.error.length, 200, 'a client error string is data, not a validation failure');
    assert.ok(!('invalid' in r));
});

test('providerStats: chronic playback/verify failure hides; good reports raise reliability', () => {
    const before = providerReliability('t-good');
    for (let i = 0; i < 5; i++) recordPlayback('t-good', 'played', 1200);
    assert.ok(providerReliability('t-good') > before);
    assert.equal(providerHidden('t-good'), false);

    for (let i = 0; i < 3; i++) recordPlayback('t-bad', 'failed');
    assert.equal(providerHidden('t-bad'), false, 'below MIN_SAMPLES never hides');
    recordPlayback('t-bad', 'stalled');
    assert.equal(providerHidden('t-bad'), true);

    for (let i = 0; i < 4; i++) recordVerify('t-unverified', false);
    assert.equal(providerHidden('t-unverified'), true);
});

test('web-readiness + bitrate: MKV/HEVC never good; heavy 4K loses to a fast verified 1080p', () => {
    assert.equal(webReadyOf('PenguPlay 2160p HEVC DDP 5.1'), false);
    assert.equal(webReadyOf('Movie.mkv', undefined), false);
    assert.equal(webReadyOf('Vidlink 1080p', 'mkv'), false);
    assert.equal(webReadyOf('Vidlink 1080p', 'ts', true), false);
    assert.equal(webReadyOf('Vidlink 1080p HLS', 'ts'), true);
    assert.equal(mbpsOf('4K WEB-DL ~46.4 Mbps'), 46.4);
    const v = { verified: true as const, type: 'mp4', reliability: 0.7 };
    assert.ok(scoreSource({ ...v, quality: 2160, webReady: false, latencyMs: 500 }) < GOOD_SCORE);
    assert.ok(scoreSource({ ...v, quality: 1080, latencyMs: 600, mbps: 8 }) > scoreSource({ ...v, quality: 2160, latencyMs: 3000, mbps: 46.4 }));
});

test('parsePlaylist: an all-HEVC master is flagged; mixed AVC/HEVC is not', () => {
    const v = (c: string) => `#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,CODECS="${c},mp4a.40.2"\nv.m3u8`;
    assert.equal(parsePlaylist(`#EXTM3U\n${v('hvc1.1.6.L120.90')}`, 'https://c.example/m.m3u8').hevc, true);
    assert.equal(parsePlaylist(`#EXTM3U\n${v('hvc1.1.6.L120.90')}\n${v('avc1.640028')}`, 'https://c.example/m.m3u8').hevc, undefined);
});

test('audioTracks + failReason: structured audio and failure buckets for the source contract', () => {
    assert.deepEqual(audioTracks('Hindi 1080p', 'Hindi'), [{ lang: 'hi', label: 'Hindi' }]);
    assert.deepEqual(audioTracks('Dual Audio', 'Dual'), [{ lang: 'mul', label: 'Dual audio' }]);
    assert.deepEqual(audioTracks('server 1080p', ''), []);
    assert.deepEqual(audioTracks('HD-1 sub', '', true), [{ lang: 'ja', label: 'Japanese', dub: false }]);
    assert.deepEqual(audioTracks('HD-1 dub', '', true), [{ lang: 'und', label: 'Dub', dub: true }]);
    assert.deepEqual(audioTracks('English dub', 'English', true), [{ lang: 'en', label: 'English', dub: true }]);
    assert.equal(failReason('probe timed out'), 'timeout');
    assert.equal(failReason('HTTP 403'), 'http');
    assert.equal(failReason('MEDIA_ERR_DECODE'), 'decode');
    assert.equal(failReason('HTTP 451'), 'geo');
    assert.equal(failReason(undefined), 'http');
});

test('scoreSource: a trickling server loses to a fast one', () => {
    const base = { verified: true as const, type: 'm3u8', quality: 1080, latencyMs: 1500, reliability: 0.8 };
    assert.ok(scoreSource({ ...base, kbps: 600 }) < scoreSource({ ...base, quality: 720, kbps: 20000 }));
});

test('streamFacts: specs, size and languages from a release name', () => {
    const f = streamFacts('Breaking.Bad.S01E01.2160p.NF.WEB-DL.Hindi.DDP5.1.English.x265.HDR · 9.45 GB');
    assert.deepEqual(f.specs, ['WEB-DL', 'HEVC', 'HDR', 'DD+', '5.1']);
    assert.equal(f.size, '9.45 GB');
    assert.deepEqual(f.languages, ['Hindi', 'English']);
    assert.equal(streamFacts('1.6 GiB').size, '1.6 GB');
});
