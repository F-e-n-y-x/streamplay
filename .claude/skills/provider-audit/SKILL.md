---
name: provider-audit
description: >-
  Audit and repair the StreamPlay streaming providers (src/extractors/*). Use this
  WHENEVER the user reports that "providers aren't working", streams won't load, the
  sources panel is empty, or asks to check/fix/revive/add a provider, audit the
  extractors, or figure out why a given source returns nothing. Also use it before
  editing any extractor so you distinguish a real code bug from a dead upstream or a
  simple catalog gap. Drives the live server + SSE endpoint to get ground truth
  instead of guessing from code.
---

# StreamPlay Provider Audit

StreamPlay fans out one request across ~28 providers (`src/extractors/`), each a
`Provider = { id, name, invoke(data: LinkData) => Promise<{streams, subtitles}> }`.
Providers scrape or call **live third-party sites** that rotate domains, rotate
crypto keys, and add Cloudflare/Turnstile gates constantly. So "provider X is
broken" has **four very different causes**, and the whole point of this skill is to
tell them apart *before* touching code:

1. **Real code bug** — regex/selector/logic error, stale hardcoded value. → Fix it.
2. **Dead / moved upstream** — domain gone, endpoint 404, key rotated. → Revive (new domain/key) or park in `disabledProviders`.
3. **Catalog gap** — the site simply doesn't have *this* title (Indian scrapers won't have every anime). → Nothing to fix; not a bug.
4. **Measurement artifact** — e.g. subtitle-only providers always show state `empty` because `web.ts` sets `state` from `links.length` and subtitles aren't links. → Not a bug.

Guessing from code alone conflates all four. **Get ground truth from the running
server first.**

## The loop

### 1. Build & run
```bash
npm install                      # server deps (client is usually prebuilt in client/dist)
npx tsc --noEmit                 # must be clean before and after any edit
PORT=3000 npx tsx src/index.ts   # run in background; needs TMDB_API_KEY in .env
curl -s http://localhost:3000/api/health          # {ok:true, tmdb:"live"}
curl -s http://localhost:3000/api/providers        # confirm the active list
```
`FLARESOLVERR_URL` (Cloudflare bypass) and `DOH_ENABLED` matter — many scrapers
need FlareSolverr, and CDN DNS often needs DoH. Confirm FlareSolverr is reachable:
```bash
curl -s -X POST "$FLARESOLVERR_URL/v1" -H 'Content-Type: application/json' -d '{"cmd":"sessions.list"}'
```

### 2. Probe reality with the SSE harness
`scripts/sse-probe.js` consumes `/api/sources/stream` and prints a per-provider
`FOUND / empty / FAILED` table (links, ms, error note). **Run at least three title
types** because providers are category-specialised:

```bash
node scripts/sse-probe.js movie 550          "Fight Club (western movie)"
node scripts/sse-probe.js tv    1429 1 1      "Attack on Titan (anime)"
node scripts/sse-probe.js tv    93405 1 1     "Squid Game (asian drama)"
# args: <movie|tv> <tmdbId> [season] [episode] [label]
```
Read the table across all three runs:
- `FOUND` in any run → provider works; empties elsewhere are **catalog gaps** (cause 3), not bugs.
- `empty`/`FAILED` in **every** run, especially with a ~15s/45s timeout → real suspect (cause 1 or 2).
- Anime providers early-return `empty` (~5ms) for non-anime — that's correct, not failure.

### 3. Isolate the cause for each real suspect
Probe the upstream **directly** to separate cause 1 from cause 2 before reading much code:
```bash
curl -s -m 12 -o /dev/null -w "http=%{http_code} time=%{time_total}\n" "https://<host>/..."
```
- Host 404/DNS-fail → **moved/dead** (cause 2): find the current domain (`WebSearch`), or check `src/utils/domains.ts` (the rotating `domains.json`) for scrapers.
- Host 200 but the *inner* API returns HTML/empty/`403` → **scheme changed** (rotated key, new token endpoint). Walk the provider's real flow with curl (search → detail → token → stream) to find exactly which step breaks.
- Host + API both fine but code returns nothing → **code bug** (cause 1): now read the extractor.

### 4. Fix, keeping working providers safe
- Make edits **surgical and opt-in**. The shared `src/utils/http.ts` and
  `hostextractors.ts` are used by every scraper — never change a global default
  (timeouts, redirect-following, headers) in a way that could regress the ~14
  providers that already work. Add an *option* and use it only where needed.
- After any edit: `npx tsc --noEmit`, restart the server, and **re-run all three
  SSE probes** to confirm the previously-`FOUND` set is unchanged (no regressions)
  before claiming success. Evidence before assertions.
- If an upstream is genuinely dead and non-trivial to revive, move the provider to
  `disabledProviders` in `src/extractors/index.ts` with a one-line reason — don't
  leave it in the active list burning `PROVIDER_TIMEOUT_MS` every request.

## Known failure fingerprints (seen in this codebase)
These are the patterns to check first — they recur across the ported Kotlin extractors:

- **Season ≥ 10 regex** — `` `S0${season}` `` yields `S010`; zero-pad instead (`padStart(2,'0')`). Hit MoviesMod.
- **Redirect header read from body** — resolvers grepping `location`/`hx-redirect` out of `resp.text`. The header only survives if the request sets `maxRedirects: 0`; then read `resp.responseHeaders[...]`. Hit BuzzServer + GDFlix "Instant DL" in `hostextractors.ts`.
- **Stale hardcoded secret** — AES keys, `apkSignKey`, fingerprints, session cookies baked into a file. When the site rotates it, decrypt throws → silent empty. Grep for hex/base64 literals. Hit Vidzee, Peachify, CastleTV, Hexa, cinemacity.
- **Token endpoint returns SPA HTML** — a `/api/...` path that used to return JSON now serves `index.html`. Means the API path or version param changed. Hit KissKH's `kkey` (`/api/Setting/alts`).
- **Hardcoded domain vs. rotating `domains.json`** — providers that hardcode a base URL can't self-heal when the site rotates; prefer `getDomain(...)`.
- **External SPOF services** — `enc-dec.app` (VidFast/Hexa/Vidlink), personal Cloudflare workers (RiveStream), self-hosted `CONSUMET_URL`. One outage kills every dependent at once; a single provider timing out while its siblings work usually means *its* host, not the shared service.
- **No caching in `anime.ts`** — AniList/MALSync rate-limit; cache resolved ids per TMDB id.
- **Wrong season/episode (title matched, season ignored)** — a provider matches by
  title + episode NUMBER but drops `data.season`, so S1E2 lands on episode-2 of
  whichever entry ranked first (often the latest season). Anime sites (AniZone,
  AnimePahe) and CastleTV split a show into ONE ENTRY PER SEASON — "… Season 2",
  "… The Final Season", or (CastleTV) same title with a different year. Fix with
  `src/utils/season.ts` `seasonScore(title, wanted, seasonYear)` to pick the right
  entry, and pass the SELECTED season's air year via `LinkData.seasonYear` (set in
  the SSE route from `/tv/{id}/season/{n}`). Verify by scoring the real candidate
  titles for S1..S4 — each should win its own entry.
- **Multi-audio only plays one track** — two failure shapes. (a) *Muxed* audio (multiple
  audio programs inside the TS segments, no `#EXT-X-MEDIA` renditions) can't be
  switched in a browser at all (VLC can) — offer per-language SOURCES instead, or
  note it. (b) *Separate renditions* with a `NAME` but no distinct `LANGUAGE`: Shaka
  (the primary engine) switches by `getAudioLanguages()`/`selectAudioLanguage`, which
  collapses same/empty-LANGUAGE tracks — so build the audio menu from the master's
  `EXT-X-MEDIA NAME`s and switch via the proxy's `&audio=<name>` re-default reload
  (Player.tsx). Only ONE rendition may carry `DEFAULT=YES` (proxy `applyForceAudio`).

## Adding or reviving a provider
Implement the `Provider` interface in a new `src/extractors/<name>.ts`, register it
in `src/extractors/index.ts` (active or `disabledProviders`), and add its base host
to `src/providersList.ts` so `/api/providers/health` can ping it. Then validate with
the SSE harness on a title the site is known to carry. To port behaviour, the
upstream reference is the StreamPlay CloudStream Kotlin plugin — match its flow.

## Output
Report findings grouped by cause (bug / dead / catalog-gap / artifact), each with
the evidence (probe output, curl status, file:line). Only claim a fix works after a
clean `tsc` **and** a no-regression re-run of the SSE probes.
