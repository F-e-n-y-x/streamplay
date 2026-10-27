import test from 'node:test';
import assert from 'node:assert/strict';
import { similarity } from '../src/routes/web';

test('similarity ranks the intended title above look-alikes', () => {
    assert.ok(similarity('naurto', 'Naruto') > similarity('naurto', 'Narcos'));
    assert.ok(similarity('stranger thinsg', 'Stranger Things') > 0.7);
    assert.equal(similarity('Breaking Bad', 'breaking bad'), 1);
    assert.equal(similarity('', 'x'), 0);
});
