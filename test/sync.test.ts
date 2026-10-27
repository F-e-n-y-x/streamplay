import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';

// sync.ts loads its data file at import time — point it at a throwaway path first.
process.env.SYNC_DATA_FILE = path.join(os.tmpdir(), `sp-sync-test-${process.pid}.json`);

test('clampTs: far-future client timestamps are clamped to now + 60s', async () => {
    const { clampTs } = await import('../src/routes/sync');
    const now = Date.now();
    assert.ok(clampTs(1e15) <= now + 61_000);
    assert.equal(clampTs(now - 5000), now - 5000);
    assert.equal(clampTs('junk'), 0);
});

test('isWeakCode: short / low-variety codes are weak, generated ones are not', async () => {
    const { isWeakCode } = await import('../src/routes/sync');
    for (const c of ['abc', '1234', 'aaaaaaaaaa', 'abababab']) assert.equal(isWeakCode(c), true, c);
    assert.equal(isWeakCode('k3j9x2m7qa'), false);
});

test('rateLimit: allows the budget, then 429s', async () => {
    const { rateLimit } = await import('../src/routes/sync');
    const mw = rateLimit(3);
    let passed = 0, limited = 0;
    const res: any = { status: (s: number) => { assert.equal(s, 429); limited++; return res; }, json: () => res };
    for (let i = 0; i < 5; i++) mw({ ip: '1.2.3.4' } as any, res, () => { passed++; });
    assert.equal(passed, 3);
    assert.equal(limited, 2);
    mw({ ip: '5.6.7.8' } as any, res, () => { passed++; });
    assert.equal(passed, 4, 'buckets are per IP');
});

test('parseRange: normal, open-ended, suffix and unsatisfiable ranges', async () => {
    const { parseRange } = await import('../src/routes/torrent');
    assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
    assert.deepEqual(parseRange('bytes=-500', 1000), { start: 500, end: 999 });
    assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
    assert.equal(parseRange('bytes=1000-', 1000), 'bad');
    assert.equal(parseRange(undefined, 1000), null);
    assert.equal(parseRange('bytes=-', 1000), null);
});
