# IMPROVEMENTS.md — StreamPlay (Phase 3)

Suggestions only — **nothing here is built.** Pick what you want and I'll implement it separately.

## How StreamPlay already compares

Benchmarked against the popular open-source aggregators in this space — **Stremio** + its Trakt/RPDB
addon ecosystem, **movie-web / sudo-flix / P-Stream**, **Jellyfin**, and community **WatchParty**
projects. StreamPlay already matches or beats most of them on the fundamentals: TMDB discovery with
deep genre/industry filtering, a custom player with in-stream quality + audio-language switching,
concurrent multi-provider resolution streamed live over SSE, watch history + resume, favourites,
**real-time multi-device sync with transitive bridging** (more than movie-web's cloud sync),
AniSkip, a subtitle pipeline, PWA/offline shell, torrent + debrid, and Cloudflare-bypass plumbing.

The suggestions below are the genuine gaps versus those peers, plus a few architecture items carried
from the audit. Each has rough effort: **S** (hours) · **M** (a day or two) · **L** (multi-day).

---

### 1. Trakt.tv two-way sync (feature) — **L**
- **What:** OAuth-connect a Trakt account and scrobble watch progress + sync watchlist/history/ratings
  both ways, alongside the existing device-sync. Optionally surface Trakt "trending/popular/your
  watchlist" as extra Browse rows.
- **Why:** This is Stremio's single most-requested addon and the main reason power users pick it. Many
  target users already have a Trakt library; letting StreamPlay read/write it makes it their primary UI
  instead of a secondary one. Complements (doesn't replace) the current sync.
- **Sources:** [Stremio Trakt scrobbling & 2-way sync](https://blog.stremio.com/stremio-tech-update-28-trakt-scrobbling-2-way-sync-more/) · [stremio-trakt-addon](https://github.com/redd-ravenn/stremio-trakt-addon)

### 2. Consolidate the player to one HLS engine / lazy-load Shaka (architecture, perf) — **S–M**
- **What:** The Watch route ships **both** hls.js and shaka-player (~209 kB gz for Shaka alone; audit
  L1). Pick hls.js + native HLS as the default and load Shaka on demand **only** when a stream actually
  needs it (DASH/DRM/edge codecs), or drop it if the real source set never does.
- **Why:** Removes ~200 kB gzip from the heaviest route with no user-visible change — the single
  biggest bundle win available. Needs a short runtime check first to confirm which engine the live
  providers actually require.

### 3. Lint + CI + a few high-value unit tests (architecture, reliability) — **M**
- **What:** Add ESLint (`@typescript-eslint` + `react-hooks`), a GitHub Actions job running
  typecheck + build + lint on PRs, and unit tests for the **pure, high-risk** logic: the SSRF guard
  (`utils/ssrf.ts`), the HLS manifest rewriter (`routes/proxy.ts`), and the anime cour→season math
  (`meta.ts`/`anilist.ts`).
- **Why:** This is the one real tooling gap (audit L7). In a provider-heavy app where upstreams and
  parsing constantly change, a regression net around the security- and correctness-critical pure
  functions pays for itself. *(Adds dev dependencies — hence a suggestion, not an audit fix.)*

### 4. Rating overlays + title logos on posters (UX polish) — **M**
- **What:** Overlay rating badges and use TMDB/Fanart title **logos** instead of plain text titles on
  hero/rows (Stremio does this via RPDB). StreamPlay already fetches `vote_average` and has a clean
  card system to hang this on.
- **Why:** Closes the main visual-polish gap versus Stremio's addon-enhanced catalogs; makes the home
  and browse grids read as "designed" rather than "TMDB default," at low structural cost.
- **Sources:** [RPDB posters/ratings in Stremio Trakt addon](https://guides.viren070.me/stremio/extras/trakt)

### 5. Infinite scroll + next-page prefetch on Browse/Search (UX, perf) — **S–M**
- **What:** Browse currently uses prev/next page buttons (`Browse.tsx:152-154`) and Search a "Load
  more". Switch to IntersectionObserver-driven infinite scroll and prefetch the next page as the user
  nears the end (React Query `useInfiniteQuery` + `prefetchQuery`).
- **Why:** Matches the "endless catalog" feel of Stremio/streaming UIs and removes a click per page;
  prefetch hides latency. Low risk — the data layer (React Query + paged endpoints) is already there.
- **Sources:** [Stremio prefetch-on-scroll](https://blog.stremio.com/stremio-tech-update-28-trakt-scrobbling-2-way-sync-more/)

### 6. Google Cast / Chromecast support (feature) — **M–L**
- **What:** Wire the already-present `Cast` icon (defined but unused) to the Cast Web Sender SDK so the
  proxied stream + subtitle track can be thrown to a Chromecast/Google TV. PiP already exists; casting
  is the natural next step.
- **Why:** "Watch on the big screen" is a common ask for a browser streaming app and a frequent Jellyfin/
  Stremio comparison point. The proxy already produces a clean, CORS-open, cast-friendly URL, so the
  server side is basically done.

### 7. Pin & integrity-check the third-party `domains.json` (supply-chain hardening) — **S**
- **What:** Provider domains are fetched live from a hosted GitHub raw URL (`utils/domains.ts`) and
  decide which hosts the scrapers hit. Pin a vendored fallback copy, verify a checksum/signature, and
  fail closed to the bundled list if the remote is unexpected.
- **Why:** A compromise (or takeover) of that external file could silently redirect all scraping
  traffic. Cheap defense-in-depth for a real supply-chain exposure noted in the audit. (Related: audit
  L5 — moving the reverse-engineered provider keys to env for rotation.)

### 8. "Watch together" synced party mode on the existing sync rooms (feature) — **L**
- **What:** Reuse the SSE sync-room + device-roster infrastructure to add host-controlled synchronized
  playback (play/pause/seek broadcast) and a lightweight chat — a party built on rails you already have.
- **Why:** A marquee feature that peers ship as whole separate apps ([OpenLake/WatchParty](https://github.com/OpenLake/WatchParty)),
  but StreamPlay is unusually close to it already: the room, roster, and real-time transport exist —
  this is mostly a new event type + player-command handling, not new infrastructure.

---

## Suggested prioritization

- **Highest value / lowest risk first:** #2 (bundle win), #5 (infinite scroll), #7 (supply-chain) — all small and safe.
- **Biggest user-facing wins:** #1 (Trakt) and #6 (Cast).
- **Foundation:** #3 (lint/CI/tests) before taking on the larger features, so they land with a safety net.

Tell me which to build and I'll scope it into its own plan + branch.

## Sources
- [15 self-hosted Stremio alternatives](https://medevel.com/15-stremio-alternatives/) · [MovieVerse](https://medevel.com/movieverse-app/) · [Open-source Stremio alternatives (AlternativeTo)](https://alternativeto.net/software/stremio/?license=opensource)
- [movie-web (progress sync, collections)](https://github.com/ptduy14/movie-web) · [sudo-flix](https://sudo-flix.lol/) · [P-Stream extension](https://extpose.com/ext/gnheenieicoichghfmjlpofcaebbgclh)
- [Stremio Trakt 2-way sync](https://blog.stremio.com/stremio-tech-update-28-trakt-scrobbling-2-way-sync-more/) · [stremio-trakt-addon](https://github.com/redd-ravenn/stremio-trakt-addon) · [Trakt guide](https://guides.viren070.me/stremio/extras/trakt)
- [OpenLake WatchParty](https://github.com/OpenLake/WatchParty)
