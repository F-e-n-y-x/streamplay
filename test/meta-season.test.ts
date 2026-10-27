import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchAired } from '../src/meta';
import { rangeStart, toFuzzy, paginateDubbed } from '../src/anilist';

test('matchAired: official-order episode → aired S/E by title, else unique air date', () => {
    const aired = [
        { seasonNumber: 1, episodeNumber: 1, name: 'And Then There Were 10', aired: '2005-12-27' },
        { seasonNumber: 1, episodeNumber: 2, name: 'Washington B.C.', aired: '2006-01-14' },
        { seasonNumber: 2, episodeNumber: 1, name: 'Twice Upon a Time', aired: '2006-03-04' },
        { seasonNumber: 2, episodeNumber: 2, name: 'Other', aired: '2006-03-04' },
    ];
    assert.deepEqual(matchAired({ seasonNumber: 3, episodeNumber: 7, name: 'washington b.c. ' }, aired), aired[1]);
    assert.equal(matchAired({ seasonNumber: 1, episodeNumber: 1, aired: '2005-12-27' }, aired), aired[0]);
    assert.equal(matchAired({ seasonNumber: 1, episodeNumber: 1, aired: '2006-03-04' }, aired), undefined); // ambiguous date
    assert.equal(matchAired(undefined, aired), undefined);
});

test('rangeStart / toFuzzy', () => {
    const now = new Date('2026-03-08T12:00:00Z');
    assert.equal(rangeStart('week', now), '2026-03-01');
    assert.equal(rangeStart('month', now), '2026-02-08');
    assert.equal(rangeStart('all', now), undefined);
    assert.equal(toFuzzy('2026-03-01'), 20260301);
    assert.equal(toFuzzy(undefined), undefined);
});

test('paginateDubbed: fixed page size, no phantom next page after the end', async () => {
    // 3 AniList pages of 10; only even MAL ids are dubbed → 15 dubbed items total.
    const fetchPage = async (n: number) => ({
        items: Array.from({ length: 10 }, (_v, i) => {
            const id = (n - 1) * 10 + i + 1;
            return { anilistId: id, malId: id * 2 - (id % 2), title: `t${id}`, titles: [], type: 'tv' as const };
        }),
        lastPage: 3,
    });
    const dub = new Set(Array.from({ length: 60 }, (_v, i) => i * 2));   // even MAL ids
    const p1 = await paginateDubbed(fetchPage, 1, 8, dub);
    assert.equal(p1.items.length, 8);
    assert.equal(p1.lastPage, 2);
    const p2 = await paginateDubbed(fetchPage, 2, 8, dub);
    assert.equal(p2.items.length, 7);
    assert.equal(p2.lastPage, 2);
    const p3 = await paginateDubbed(fetchPage, 3, 8, dub);
    assert.equal(p3.items.length, 0);
    assert.equal(p3.lastPage, 2);
});
