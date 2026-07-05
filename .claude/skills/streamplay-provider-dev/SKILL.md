---
name: streamplay-provider-dev
description: >-
  Use when WRITING, PORTING, or extending a StreamPlay streaming/anime provider
  (src/extractors/<name>.ts) — creating a new extractor, porting one from a
  CloudStream Kotlin plugin, ani-cli, or a REST API, adding a source for
  dubbed/sub anime or movies, or wiring the HTTP/Cloudflare/WARP/FlareSolverr and
  anime title-matching helpers correctly. Complements `provider-audit` (which
  DEBUGS existing providers); this one is the build/port playbook + conventions.
---

# StreamPlay Provider Development

A provider is one file in `src/extractors/` exporting a `Provider`:

```ts
export const FooProvider: Provider = {
  id: 'foo', name: 'Foo',
  requiresWarp?: true,                     // only if its CDN IP-bans datacenter egress (e.g. Kwik)
  invoke: async (data: LinkData): Promise<ExtractorResult> => {
    const streams: Stream[] = []; const subtitles: Subtitle[] = [];
    // ...resolve...
    return { streams, subtitles };
  },
};
```

Register it in `src/extractors/index.ts` (the `providers` array — anime providers first;
dead ones go in `disabledProviders`). `LinkData`/`Stream`/`Provider` are in `src/types.ts`.

## The HTTP layer — pick the RIGHT helper (this is where most bugs live)

All in `src/utils/http.ts`. **Never call axios directly** in a provider — the shared layer
carries the DoH resolver, the WARP SOCKS proxy, the per-request AbortSignal, and the
Cloudflare cookie jar.

- `app.get(url, {headers,timeout,referer,params,maxRedirects})` / `app.post(...)` — plain
  request. Use for non-gated hosts and for follow-ups **after** a solve has primed clearance.
- `safeGet(url, {cloudflare?, flareTimeout?})` — Cloudflare-aware. Tries plain first, and on
  a challenge solves via FlareSolverr **and stores the `cf_clearance` in the cookie jar** so
  subsequent `app.get`/`app.post` to that host succeed. Use for CF-gated multi-step scrapers.
- `flareSolverrGetHtml(url)` (from `utils/flaresolverr.ts`) — one-shot solved HTML, sessionless.
  Use when you just need the rendered page/JSON once (e.g. animepahe `/api?m=search`). For a
  JSON endpoint behind CF, prefer the `safeGet`→`app.get` two-step so you get clean JSON, not
  FlareSolverr's HTML-wrapped body (see `allanime.ts` `fetchJson`).

**Cloudflare + WARP interaction (critical):** if a provider solves via FlareSolverr then does a
follow-up request that reuses `cf_clearance`, the solve and the follow-up MUST egress the same
IP. When the deployment runs FlareSolverr behind WARP, that only holds in `WARP_MODE=all`
(or `required` + `requiresWarp:true`). Mark such providers `requiresWarp` OR document that they
need `WARP_MODE=all`. The FlareSolverr pool auto-serializes (one solve per instance) and honors
the request AbortSignal — you get that for free by using the shared helpers.

## Anime providers — title matching is the #1 failure

TMDB gives English titles ("Haganai: I Don't Have Many Friends"); anime sites index by romaji
("Boku wa Tomodachi ga Sukunai") or a short title ("Haganai"). **Always search every variant:**

```ts
import { animeSearchTitles } from '../anime';   // [TMDB title, orgTitle, jpTitle, ...AniList romaji/english/native/synonyms]
for (const q of animeSearchTitles(data)) { const r = await search(q); if (r.length) break; }
```

- Guard early: `if (!data.isAnime || !data.title) return { streams, subtitles };`
- Split-season shows: pick the entry by season, not just title — `seasonScore(name, wantSeason, data.seasonYear)` from `utils/season.ts` (see `anizone.ts`, `animepahe.ts`, `allanime.ts`).
- SUB vs DUB: prefer a real API flag (AllAnime `translationType`, AnimePahe `data-audio` jpn/eng),
  not guesswork. Put the audio LANGUAGE word in `stream.server` (e.g. `"AllAnime · English (Dub)"`)
  so the sources panel shows a filterable audio tag; also set `stream.audioName`.

## Host extractors & unpacking

`src/utils/hostextractors.ts` resolves embed hosts (HubCloud/GDFlix/StreamWish family) and has
`getPacked`/`getAndUnpack` (Dean-Edwards `eval(function(p,a,c,k,e,d))`). Kwik, StreamWish, etc.
use this — extract the packed script, `getAndUnpack`, then regex `source='...m3u8'`.
`utils/common.ts` has `getIndexQuality`/`qualityLabel`; `utils/encdec.ts` has `USER_AGENT`.

## Stream shape

```ts
streams.push({ server: 'Foo · 1080p', link, type: 'm3u8'|'mp4'|'iframe', quality: '1080p',
  headers: { Referer, Origin },      // headers the CDN needs — injected by /api/proxy at playback
  audioName: 'English' });           // optional: forces this HLS audio rendition as default
```
Return real media URLs (m3u8/mp4) — `type:'iframe'` is a last resort (not natively playable, no
audio/quality switching). The proxy handles CORS/Referer/range/HLS-rewrite, so emit the raw CDN URL + headers.

## Verify (don't guess)

- `GET /api/debug/provider?provider=<id>&type=tv&id=<tmdbId>&season=1&episode=1&warp=all` → raw
  streams **or the actual error/stack**. The fastest way to see why a provider yields nothing.
- `ANIME_DEBUG=1` env → the anime providers `console.error` their search/match/resolve steps.
- Then use the `provider-audit` skill's SSE loop for the full fan-out picture.
- Resolved sources are cached 8 min per (type,id,season,episode); add `&fresh=1` to bypass while testing.

## Porting checklist (from a CloudStream Kotlin plugin / ani-cli / API)

1. Find search → detail/episode → source-resolution endpoints; note headers/cookies/referer.
2. Map `app.get(url).document` → `(await app.get(url)).document` (cheerio), `.text`, `.json()`.
3. Replace `getAndUnpack`/`loadExtractor` with the `hostextractors.ts` equivalents.
4. Feed `animeSearchTitles(data)` for anime search; use `seasonScore` for season entries.
5. Choose `safeGet` for CF-gated hosts; set `requiresWarp` if the CDN IP-bans egress.
6. Register in `index.ts`; verify with `/api/debug/provider`; add to `disabledProviders` (with a
   one-line reason) instead of deleting if the upstream is dead.
