import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonRe, episodeRe, pad2, norm } from '../src/utils/season';
import { findMediaUrl } from '../src/utils/hostextractors';
import { pickAWHit } from '../src/extractors/animeworld';
import { pickPlayerjsFiles } from '../src/extractors/cinemacity';

test('seasonRe: matches S1/S01/Season 1, never S10/Season 12', () => {
    for (const t of ['Squid Game S01 1080p', 'Season 1 [Hindi]', 'S1E3', '(Season 01)', 'S01E01']) assert.ok(seasonRe(1).test(t), t);
    for (const t of ['S10 1080p', 'Season 12', 'Season 10 Complete', 'Seasons 1-3', 'HDS1']) assert.ok(!seasonRe(1).test(t), t);
    assert.ok(seasonRe(10).test('Season 10') && !seasonRe(10).test('Season 1'));
});

test('episodeRe: matches Episode 1 / Episodes: 01 / E01, never Episode 10-19', () => {
    for (const t of ['Episode 1', 'Episodes: 01', 'Ep 1 720p', 'S01E01', 'EPiSODE 01']) assert.ok(episodeRe(1).test(t), t);
    for (const t of ['Episode 10', 'Episode 11', 'Episodes: 12', 'S01E10', 'S01E11', 'Ep 19']) assert.ok(!episodeRe(1).test(t), t);
});

test('pad2 / norm', () => {
    assert.equal(pad2(1), '01');
    assert.equal(pad2(12), '12');
    assert.equal(norm('Attack on Titan: The Final-Season!'), 'attack on titan the final season');
    assert.equal(norm("Frieren: Beyond Journey’s End"), norm('frieren-beyond-journeys-end'));
});

test('findMediaUrl: unpacked/plain pages, keyed or bare, relative resolved', () => {
    assert.equal(findMediaUrl(`jwplayer().setup({sources:[{file:"https://cdn.x/a/master.m3u8?t=1"}]})`), 'https://cdn.x/a/master.m3u8?t=1');
    assert.equal(findMediaUrl(`<a>https://cdn.x/v.mp4</a>`, ['m3u8', 'mp4']), 'https://cdn.x/v.mp4');
    assert.equal(findMediaUrl(`var source='/hls/x.m3u8';`, ['m3u8'], 'https://host.y/e/1'), 'https://host.y/hls/x.m3u8');
    assert.equal(findMediaUrl('nothing here'), undefined);
});

test('pickAWHit: right medium + real title match, no blind first hit', () => {
    const hits = [
        { slug: 'naruto-shippuden', title: 'Naruto Shippuden', movie: false },
        { slug: 'one-piece-film-red', title: 'One Piece Film Red', movie: true },
        { slug: 'one-piece', title: '', movie: false },
    ];
    assert.equal(pickAWHit(hits, ['One Piece'], false)?.slug, 'one-piece');           // slug fallback
    assert.equal(pickAWHit([{ slug: 'frieren-beyond-journeys-end', title: '', movie: false }], ["Frieren: Beyond Journey's End"], false)?.slug, 'frieren-beyond-journeys-end');
    assert.equal(pickAWHit(hits, ['Bleach'], false), undefined);                       // no results[0]
    assert.equal(pickAWHit(hits, ['One Piece Film Red'], true)?.slug, 'one-piece-film-red');
    assert.equal(pickAWHit(hits, ['Naruto Shippuden'], true), undefined);              // wrong medium
});

test('pickPlayerjsFiles: series picks only the wanted season+episode', () => {
    const series = [
        { title: 'Season 1', folder: [{ title: 'Episode 1', file: 's1e1' }, { title: 'Episode 10', file: 's1e10' }] },
        { title: 'Season 10', folder: [{ title: 'Episode 1', file: 's10e1' }] },
    ];
    assert.deepEqual(pickPlayerjsFiles(series, 1, 1).map((f) => f.file), ['s1e1']);
    assert.deepEqual(pickPlayerjsFiles(series, 10, 1).map((f) => f.file), ['s10e1']);
    assert.deepEqual(pickPlayerjsFiles(series, 2, 1), []);
    assert.deepEqual(pickPlayerjsFiles([{ title: '1080p', file: 'm' }], undefined).map((f) => f.file), ['m']);
    assert.deepEqual(pickPlayerjsFiles([{ title: '1080p', file: 'm' }], 1, 1), []);    // movie file never served for TV
});
