import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteManifest, assToVtt, b64 } from '../src/routes/proxy';

const decodeProxied = (line: string): string => {
    const m = /\/api\/proxy\?url=([^&\s"]+)/.exec(line);
    assert.ok(m, `expected a proxied URL in: ${line}`);
    return Buffer.from(m![1], 'base64url').toString('utf-8');
};

test('rewriteManifest: bare segment/variant URIs are re-proxied and resolved absolute', () => {
    const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1000', 'sub/media.m3u8'].join('\n');
    const out = rewriteManifest(master, 'https://cdn.example.com/hls/index.m3u8', '');
    const line = out.split('\n').find((l) => l.includes('/api/proxy'))!;
    assert.ok(line, 'variant line should be rewritten');
    assert.equal(decodeProxied(line), 'https://cdn.example.com/hls/sub/media.m3u8');
    assert.ok(line.includes('m3u8=1'), 'a master variant must be flagged as a playlist');
});

test('rewriteManifest: URI="..." attributes (keys/renditions) are rewritten', () => {
    const media = [
        '#EXTM3U',
        '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x0',
        '#EXTINF:6,',
        'seg1.ts',
    ].join('\n');
    const out = rewriteManifest(media, 'https://cdn.example.com/hls/index.m3u8', '');
    assert.ok(/#EXT-X-KEY:[^\n]*URI="\/api\/proxy\?url=/.test(out), 'key URI should be proxied');
    // the bare segment line is rewritten to a standalone /api/proxy line (the base64 no longer
    // contains "seg1"); the other /api/proxy occurrence is inside the KEY line's URI="…".
    const segLine = out.split('\n').find((l) => l.startsWith('/api/proxy'))!;
    assert.equal(decodeProxied(segLine), 'https://cdn.example.com/hls/seg1.ts');
});

test('rewriteManifest: forceAudio makes the matching rendition DEFAULT=YES and others NO', () => {
    const master = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="en.m3u8"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Hindi",LANGUAGE="hi",DEFAULT=NO,AUTOSELECT=NO,URI="hi.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"',
        'v.m3u8',
    ].join('\n');
    const out = rewriteManifest(master, 'https://cdn.example.com/x.m3u8', '', 'Hindi');
    const hindi = out.split('\n').find((l) => l.includes('NAME="Hindi"'))!;
    const english = out.split('\n').find((l) => l.includes('NAME="English"'))!;
    assert.ok(/DEFAULT=YES/.test(hindi), 'requested Hindi track should be DEFAULT=YES');
    assert.ok(/DEFAULT=NO/.test(english), 'non-requested English track should be DEFAULT=NO');
});

test('rewriteManifest: forceAudio that matches nothing leaves the manifest defaults intact', () => {
    const master = [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,URI="en.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a"',
        'v.m3u8',
    ].join('\n');
    const out = rewriteManifest(master, 'https://cdn.example.com/x.m3u8', '', 'Klingon');
    assert.ok(/NAME="English"[^\n]*DEFAULT=YES/.test(out.split('\n').find((l) => l.includes('English'))!),
        'the sole default must remain DEFAULT=YES when the requested track is absent');
});

test('assToVtt: converts [Events] Dialogue lines to WEBVTT cues', () => {
    const ass = [
        '[Script Info]',
        'Title: x',
        '[V4+ Styles]',
        'Format: Name',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}Hello world',
        'Dialogue: 0,0:00:04.00,0:00:05.00,Default,,0,0,0,,Line\\Ntwo',
    ].join('\n');
    const vtt = assToVtt(ass);
    assert.ok(vtt.startsWith('WEBVTT'), 'must start with WEBVTT header');
    assert.ok(vtt.includes('00:00:01.000 --> 00:00:03.500'), 'timecodes converted');
    assert.ok(vtt.includes('Hello world'), 'override tags stripped, text kept');
    assert.ok(!vtt.includes('{\\an8}'), 'ASS override tags removed');
    assert.ok(/Line\ntwo/.test(vtt), 'hard line breaks (\\N) become newlines');
});

test('b64 round-trips utf-8 as base64url', () => {
    const s = 'https://cdn.example.com/á/b.m3u8?x=1&y=2';
    assert.equal(Buffer.from(b64(s), 'base64url').toString('utf-8'), s);
    assert.ok(!/[+/=]/.test(b64(s)), 'base64url uses no +, /, or = padding');
});
