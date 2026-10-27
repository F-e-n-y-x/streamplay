import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { guardedGet, guardRedirect, isPrivateAddress, guardUrl, safeContentType, SSRF_BLOCKED, setAllowedOrigins } from '../src/utils/ssrf';

const withServer = async (fn: (port: number, hits: () => number) => Promise<void>) => {
    let n = 0;
    const srv = http.createServer((_q, r) => { n++; r.end('SECRET'); });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try { await fn((srv.address() as AddressInfo).port, () => n); } finally { srv.closeAllConnections(); srv.close(); }
};

test('guardedGet: literal private IP is refused at connect time (Node skips lookup for literals)', () =>
    withServer(async (port, hits) => {
        await assert.rejects(guardedGet(`http://127.0.0.1:${port}/`), (e: any) => e.code === SSRF_BLOCKED);
        assert.equal(hits(), 0, 'no request may reach the internal server');
    }));

test('guardedGet: a name resolving to loopback is refused', () =>
    withServer(async (port, hits) => {
        await assert.rejects(guardedGet(`http://localhost:${port}/`), (e: any) => e.code === SSRF_BLOCKED);
        assert.equal(hits(), 0);
    }));

test('guardRedirect: a redirect hop to a literal private host throws', () => {
    assert.throws(() => guardRedirect({ href: 'http://169.254.169.254/latest/meta-data/' }), /blocked redirect/);
    assert.throws(() => guardRedirect({ protocol: 'http:', hostname: '192.168.1.1', path: '/' }), /blocked redirect/);
    assert.doesNotThrow(() => guardRedirect({ href: 'https://cdn.example.com/a.ts' }));
});

test('isPrivateAddress: extended blocklist + embedded-v4 IPv6 forms', () => {
    for (const a of ['198.18.0.1', '198.19.255.255', '192.0.0.8', '224.0.0.1', '240.0.0.1', '255.255.255.255',
        '::7f00:1', '64:ff9b::7f00:1', '::ffff:0:7f00:1', '::ffff:127.0.0.1', '2002:c0a8:101::1', 'fec0::1', 'ff02::1', '::127.0.0.1']) {
        assert.equal(isPrivateAddress(a), true, `${a} should be private`);
    }
    for (const a of ['198.20.0.1', '192.0.2.1', '223.255.255.255', '64:ff9b::808:808', '2002:808:808::1', '2001:4860:4860::8888']) {
        assert.equal(isPrivateAddress(a), false, `${a} should be public`);
    }
    for (const u of ['http://[::7f00:1]/', 'http://[64:ff9b::7f00:1]/', 'http://[::ffff:0:7f00:1]/', 'http://198.18.0.1/', 'http://[fec0::1]/', 'http://0x7f.1/', 'http://127.1/']) {
        assert.equal(guardUrl(u), 'blocked host', u);
    }
});

test('safeContentType: media/playlist/subtitle/key types pass; scriptable types become octet-stream', () => {
    for (const ct of ['video/mp2t', 'video/mp4', 'audio/aac', 'application/vnd.apple.mpegurl', 'application/x-mpegURL',
        'application/octet-stream', 'binary/octet-stream', 'text/vtt; charset=utf-8', 'text/plain']) {
        assert.equal(safeContentType(ct), ct, ct);
    }
    for (const ct of ['text/html', 'text/html; charset=utf-8', 'image/svg+xml', 'application/javascript', 'text/xml', 'image/png', undefined]) {
        assert.equal(safeContentType(ct), 'application/octet-stream', String(ct));
    }
});

test('allowlisted plugin origin: only that exact host:port is reachable, not other ports', () =>
    withServer(async (port, hits) => withServer(async (other, otherHits) => {
        setAllowedOrigins('test', [`http://127.0.0.1:${port}`]);
        try {
            const r = await guardedGet(`http://127.0.0.1:${port}/`);
            assert.equal(r.status, 200);
            assert.equal(hits(), 1);
            await assert.rejects(guardedGet(`http://127.0.0.1:${other}/`));
            assert.equal(otherHits(), 0, 'a different port on the allowlisted host must stay blocked');
        } finally { setAllowedOrigins('test', []); }
    })));
