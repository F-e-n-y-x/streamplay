import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, isBlockedHost, guardUrl } from '../src/utils/ssrf';

test('isPrivateAddress: IPv4 private / loopback / metadata / CGNAT', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '172.31.255.255',
        '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
        assert.equal(isPrivateAddress(a), true, `${a} should be private`);
    }
});

test('isPrivateAddress: public IPv4 is allowed', () => {
    for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.63.255.255', '100.128.0.1']) {
        assert.equal(isPrivateAddress(a), false, `${a} should be public`);
    }
});

test('isPrivateAddress: IPv6 loopback / link-local / ULA and mapped v4', () => {
    for (const a of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:7f00:0001']) {
        assert.equal(isPrivateAddress(a), true, `${a} should be private`);
    }
    assert.equal(isPrivateAddress('2606:4700:4700::1111'), false); // public IPv6 (Cloudflare DNS)
    assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);       // mapped public v4
});

test('isBlockedHost: names that must never be fetched', () => {
    for (const h of ['localhost', 'foo.localhost', 'router.local', 'svc.internal', '127.0.0.1', '']) {
        assert.equal(isBlockedHost(h), true, `${h} should be blocked`);
    }
    assert.equal(isBlockedHost('example.com'), false);
    assert.equal(isBlockedHost('cdn.provider.tv'), false);
});

test('guardUrl: blocks internal literals incl. sneaky IPv4 encodings', () => {
    assert.equal(guardUrl('http://localhost/x'), 'blocked host');
    assert.equal(guardUrl('http://127.0.0.1/x'), 'blocked host');
    assert.equal(guardUrl('http://2130706433/'), 'blocked host');      // decimal 127.0.0.1
    assert.equal(guardUrl('http://0x7f000001/'), 'blocked host');      // hex 127.0.0.1
    assert.equal(guardUrl('http://017700000001/'), 'blocked host');    // octal 127.0.0.1
    assert.equal(guardUrl('http://[::1]/'), 'blocked host');
    assert.equal(guardUrl('http://169.254.169.254/latest/meta-data/'), 'blocked host');
});

test('guardUrl: blocks non-http schemes and bad input', () => {
    assert.equal(guardUrl('ftp://example.com/'), 'blocked scheme');
    assert.equal(guardUrl('file:///etc/passwd'), 'blocked scheme');
    assert.equal(guardUrl('javascript:alert(1)'), 'blocked scheme');
    assert.equal(guardUrl('not a url'), 'bad url');
});

test('guardUrl: allows normal public URLs', () => {
    assert.equal(guardUrl('https://example.com/stream.m3u8'), null);
    assert.equal(guardUrl('http://cdn.provider.tv:8080/a.mp4?x=1'), null);
});
