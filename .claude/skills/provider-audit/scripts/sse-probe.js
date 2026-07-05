#!/usr/bin/env node
/**
 * sse-probe.js — drive StreamPlay's /api/sources/stream (SSE) and print a
 * per-provider FOUND / empty / FAILED table. This is the ground-truth tool of the
 * provider-audit skill: it tells you which providers actually resolve links for a
 * given title, vs. return empty (catalog gap or broken) vs. throw.
 *
 * Usage:
 *   node sse-probe.js <movie|tv> <tmdbId> [season] [episode] [label]
 * Examples:
 *   node sse-probe.js movie 550                 "Fight Club"
 *   node sse-probe.js tv    1429 1 1            "Attack on Titan S1E1"
 *
 * Env: BASE_URL (default http://localhost:3000), TIMEOUT_MS (default 90000).
 *
 * Note: subtitle-only providers (subtitleapi, wyziesubs) legitimately show as
 * `empty` here because the server derives provider state from stream-link count,
 * not subtitles. That is a measurement artifact, not a broken provider.
 */
const http = require('http');

const [, , type, id, season, episode, ...labelParts] = process.argv;
const label = labelParts.join(' ');
if (!type || !id) {
  console.error('Usage: node sse-probe.js <movie|tv> <tmdbId> [season] [episode] [label]');
  process.exit(2);
}
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 90000;

let q = `type=${type}&id=${id}`;
if (season) q += `&season=${season}`;
if (episode) q += `&episode=${episode}`;
const url = `${BASE}/api/sources/stream?${q}`;

const providers = {};
const links = [];
let done = false;
const started = Date.now();

http.get(url, (res) => {
  let buf = '';
  res.on('data', (chunk) => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const ev = /event: (.*)/.exec(raw); const dm = /data: (.*)/.exec(raw);
      if (!ev || !dm) continue;
      let data; try { data = JSON.parse(dm[1]); } catch { continue; }
      if (ev[1] === 'provider') providers[data.id] = { state: data.state, ms: data.durationMs, n: (data.links || []).length, note: data.note };
      else if (ev[1] === 'link') links.push(data.providerId);
      else if (ev[1] === 'done') { done = true; finish(); }
    }
  });
  res.on('end', finish);
}).on('error', (e) => { console.error('request error:', e.message); process.exit(1); });

function finish() {
  if (finish.called) return; finish.called = true;
  console.log(`\n=== ${label || ''} (${type}/${id}) — ${Date.now() - started}ms, done=${done} ===`);
  const rows = Object.entries(providers).sort((a, b) => (b[1].n || 0) - (a[1].n || 0));
  for (const [pid, s] of rows) {
    const tag = s.state === 'found' ? 'FOUND' : s.state === 'failed' ? 'FAILED' : s.state === 'empty' ? 'empty' : s.state;
    console.log(`${String(tag).padEnd(6)} ${pid.padEnd(14)} links=${s.n || 0} ${s.ms ? s.ms + 'ms' : ''} ${s.note ? 'note=' + s.note : ''}`);
  }
  const found = rows.filter((r) => r[1].state === 'found').map((r) => r[0]);
  console.log(`\nFOUND(${found.length}): ${found.join(', ')}`);
  process.exit(0);
}

setTimeout(() => { console.log('\n[timeout]'); finish(); }, TIMEOUT_MS);
