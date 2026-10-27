# Changelog

## Unreleased — 2.0.0

Full audit + redesign. **Upgrade notes first:**

Post-deploy fixes:
- CastleTV picks the requested season's own entry (it lists a show once, defaulting to the
  latest season — S7 used to play S4). A season it doesn't carry returns nothing.
- Stremio/PenguPlay: `file|^|tag.pad-Source` names become "PenguPlay · Source"; files
  naming another show or SxxEyy are dropped.
- Source probe measures real download speed (256 KB) and ranks trickling servers down.
- Player: taps go to a gesture layer (iOS can swallow pointer events on `<video>`); the app
  bar stays on the player page on phone/tablet.
- Solver diagnostics work with Byparr (optional service in docker-compose.yml).
- NVIDIA GPUs: HEVC/AV1 sources are converted to H.264 with NVENC (auto-detected; compose
  `gpus: all`). H.264 is still copied as-is. The runtime image is now Debian (NVIDIA's
  driver libs are glibc-only). VAAPI no longer breaks every MKV when it can't open.
- Converted files (MKV / HEVC / DTS…) play as seekable HLS on NVIDIA: full-length slider,
  seeking, 1080p H.264, every audio track switchable. Before, they were shelved as "external
  player only" or played as a one-shot stream whose slider grew as it downloaded.
- Change source shows each addon's own card verbatim (Nuvio-style emoji lines: specs, size,
  audio, subtitles) with Quality / Audio / Addon filter chips. Audio languages come from the
  card's "Audio:" line only.
- `ADDON_ADMIN=open` lets a private LAN instance manage addons without the admin token.

- The Docker image now runs as the non-root `node` user. Existing data volumes are
  root-owned — run once: `docker run --rm -v streamplay-data:/d alpine chown -R 1000:1000 /d`
  (or chown your bind-mounted data folder to 1000:1000), otherwise sync can't save.
- Production runs compiled JS (`npm run build && npm start` → `node dist/index.js`).
- Removed legacy endpoints: `/api/info`, `/api/streams`, `/api/providers/status`, the old
  `/api/search` duplicate and the legacy `public/` UI.
- Only JSON POSTs are accepted under `/api`; debug endpoints need `DEBUG_TOKEN`; admin
  token is header-only (`X-Admin-Token`).
- New sync codes need ≥ 8 characters (existing codes keep working).

### UI — full redesign (phone, tablet, desktop, TV)
- New look built from user-picked references: inset hero card with Top 10 outline
  numerals, artwork-tinted title pages with cast + episodes column, Watch page with the
  episode switcher above the server list, redesigned player (lock, playlist, centre
  ±10, brightness/volume edge sliders on touch).
- Phone bottom tab bar, tablet chips nav, desktop header, TV arrow-key navigation.
- Typo-tolerant search with live suggestions and "Did you mean" ("naurto", "abngers",
  "the kardshin" all find the right title).
- Resume-aware Play buttons, "Up next" in Continue Watching, watched/progress markers.
- Touch player: tap shows controls, double-tap seeks ±10s; iOS Safari / iPadOS and
  Firefox fixes; auto-next countdown; clear "trying next source" / "all failed" states.
- Accessibility: contrast fixes, focus rings, skip link, live regions, labelled inputs.
- PWA icons (PNG/maskable/apple-touch); Settings → Server → Addons manages Nuvio /
  Stremio addon lists.

### Providers
- New: Anikage, Just4Anime, Animekizz (anime, sub+dub), generic Stremio addons
  (`STREMIO_ADDONS`), TorrentsDB for torrent mode.
- **Nuvio plugin support** (`NUVIO_PLUGINS` or the Settings UI): Nuvio scraper repos run
  in an isolated worker with the Nuvio runtime API. Plugins are code the server runs —
  only add repos you trust.
- Revived: VidLink, VidEasy (new host flow), VidFast (new enc-dec flow), AnimeWorld (new
  video host), AnimeNoSub (Vidmoly).
- Fixed wrong-episode bugs: "Episode 1" matching Episode 10–19 and "Season 1" matching
  Season 10 across 9 scrapers; no more "first search result" fallbacks that played a
  different show; anime season (cour) numbering now agrees between title, season list and
  stream resolution.

### Security
- SSRF: redirects to private/LAN IPs blocked everywhere (was open on `/api/torrent/http`),
  extended IPv4/IPv6 blocklist, extractor requests guarded.
- Proxied responses get `nosniff` + `CSP: sandbox` and a content-type allowlist (stops
  same-origin script injection via `/api/proxy`).
- Optional `STREAMPLAY_PASSWORD` gate; `TRUST_PROXY` for correct per-IP rate limits behind
  a reverse proxy; sync rate limits, room/device caps, clamped timestamps, atomic writes.
- TMDB API key no longer logged; addon URLs (may embed debrid keys) hidden without the
  admin token.

### Reliability / infra
- Socket + ffmpeg leaks on client disconnect fixed; wrong Content-Length on gzip fixed;
  torrent mode downloads only selected files, max `TORRENT_MAX_ACTIVE` torrents.
- Express 5, React Router 7, non-root multi-stage Docker image with healthcheck and tini,
  CI publishes the image only after tests pass; `npm audit`: 0 critical.
- 13 → 39 automated tests.

## 1.2.0

Feature release — reworked anime providers, per-kind provider control, cross-device
settings sync, torrent mode, and a richer player — plus a full read/run audit pass
(security hardening, fixes, and the project's first automated tests).

### Anime providers (AniZone / AnimeWorld / AnimePahe)
- **AniZone is now fast + reliable.** It was routing every request through a
  FlareSolverr browser (30-90s, and often only appearing after a page reload).
  anizone.to actually serves plain HTTP fine, so it now fetches directly (~2-6s)
  and matches titles via the episode page's static `<title>`, with FlareSolverr
  kept only as an IP-challenge fallback.
- **Shared FlareSolverr session removed (the core anime bug).** A FlareSolverr
  session is one browser; AniZone+AnimeWorld+AnimePahe hammering the single shared
  session concurrently serialized and failed (sources appearing after 1-2 min or
  not at all). `flareSolverrGetHtml` is now sessionless, like the working Indian
  scrapers, so anime solves fan out instead of blocking each other. **AnimeWorld
  now resolves** (Hindi/Tamil/Telugu/Eng/Jap dubs via zephyrflick, whose Cloudflare
  challenge is solved through the shared cookie jar).
- **Multiple FlareSolverr instances.** `FLARESOLVERR_URL` accepts a comma/space-
  separated list; solves round-robin across the pool so no single browser is the
  bottleneck. AnimePahe (which needs a Cloudflare solve on Kwik per quality) needs
  this headroom to resolve reliably.
- **Client: anime providers are primary.** For anime titles the sources list heads
  with AniZone/AnimePahe/AnimeWorld and autoplay now waits for them — playing the
  first primary source as soon as it resolves, and only falling back to a generic
  provider once all three have finished — so a fast movie provider can't grab the
  player ahead of the anime sources.

### Added
- **Per-kind provider control.** A "sliders" button on the Sources panel opens a
  provider editor scoped to the current content kind (**anime / movies / series /
  Asian drama**, resolved from TMDB classification). Reorder providers (pinned ones
  are tried and auto-played first for that kind) and hide the ones you never want.
  Saved into settings, so it persists locally, survives a server restart / folder
  copy, and **syncs across devices**.
- **Sticky provider.** The provider you played last for a given kind is remembered
  and resumed first on the next episode; if it fails, the normal failover advances
  to the next source. Per-kind, synced.
- **Settings sync across devices.** The sync room now carries the whole client
  settings object (audio languages, quality, autoplay/auto-next/auto-skip, WARP
  mode, provider order/hide, sticky provider, …) with last-writer-wins merging —
  set a preference on one device and it follows you to the others, alongside the
  existing history/favourites sync.
- **Industry filter for Movies & Series.** Filter by **Bollywood / Tollywood /
  Kollywood / Mollywood / Sandalwood / Hollywood** (mapped to TMDB original
  language) — an axis genres don't cover. Plus stronger 18+ detection (broader
  adult keyword/regex exclusion) so more mis-tagged adult anime stay hidden when
  18+ is off.
- **Player control bar + AniSkip.** A control bar under the player: Prev/Next
  episode (rolls across season boundaries), Auto Play, Auto Next (auto-advance to
  the next episode), Theater mode, and Lights (dim the page). For anime it adds
  **Auto Skip** and an in-player **Skip Opening / Skip Ending** button driven by
  the AniSkip API (https://github.com/aniskip/aniskip-api) via a new
  `/api/skip-times` endpoint (resolves the title's MAL id through the cached anime
  resolver). All toggles persist; the bar is context-aware (movies hide episode /
  anime controls). Styled entirely with the existing design tokens.
- **Cloudflare WARP proxy support.** Optional egress through a Cloudflare WARP
  proxy to beat IP blocks (AnimePahe's Kwik CDN literally IP-bans the egress),
  ISP DNS poisoning, and geo-blocks. Four modes, chosen from **Settings → WARP
  proxy** (or the `WARP_MODE` env default): `off`, `required` (only providers that
  declare they need it, e.g. AnimePahe), `fallback` (retry a provider through WARP
  if it came back empty), `all`. Two transports: `WARP_PROXY_URL` (SOCKS5 for our
  own requests) and `WARP_FLARESOLVERR_URL` (a FlareSolverr whose browser egresses
  through WARP — this is what solves Kwik). Per-request mode is carried via
  AsyncLocalStorage so no provider signatures changed. `docker-compose.yml` ships a
  ready-to-uncomment `warp` + `flaresolverr-warp` recipe.

### Fixed
- **Wrong season played (anime + CastleTV).** Providers matched by title + episode
  NUMBER but ignored the season, so selecting S1E2 could play S4E2. Anime sites
  (AniZone, AnimePahe) split a show into one entry per season, and CastleTV lists
  each season under the same title with a different year. Added `seasonScore`
  (`src/utils/season.ts`) + a new `LinkData.seasonYear` (the selected season's air
  year, from TMDB) so each provider now picks the correct season entry — verified
  on Attack on Titan (S1→base, S2/S3→"Season N", S4→"The Final Season").
- **Multi-audio only played one track.** The Shaka engine built its audio menu from
  `getAudioLanguages()`, which collapses renditions that share/omit `LANGUAGE` (the
  Indian-dub masters) to a single entry. The player now builds the menu from the
  master's `EXT-X-MEDIA NAME`s and switches via the proxy's `&audio=` re-default
  reload when `LANGUAGE` can't disambiguate. The proxy also now marks only ONE
  rendition `DEFAULT=YES` (two tracks sharing a language no longer both default).
- **CastleTV duplicate languages.** It often returns the same file for several
  languageIds (only the auth token differs); those are now deduped by file so you
  don't get "Tamil"/"English" entries that play identical audio. (Note: where a
  single CastleTV file carries *muxed* audio, browsers can't switch it — VLC can;
  use the per-language sources.)
- **Sync data could corrupt.** `sync-data.json` is now written to a temp file and
  atomically renamed, and writes are serialized — overlapping bursts can no longer
  leave a half-written file that wipes all rooms on next boot.
- **Settings sync dropped edits** on clock-skewed devices / same-millisecond edits
  — `updatedAt` is now monotonic (`max(now, prev+1)`).
- FlareSolverr retries thrown/timeout failures (not just bad-status bodies); the
  `fallback`-mode WARP retry now respects client disconnect; `/skip-times` validates
  `endTime`; the player resets its resume guard on source change; WARP warns if the
  SOCKS/FlareSolverr lists are unequal length.

### Changed (player engine)
- **hls.js is now the PRIMARY HLS engine** (Shaka demoted to fallback). Evidence-
  based: Shaka enumerates audio by `LANGUAGE` and collapses renditions that share or
  omit it (exactly our Indian-dub masters), while hls.js enumerates by index/NAME and
  switches seamlessly via `hls.audioTrack` — so every dub now shows up and switches
  without a reload. Fallback chain: hls.js → (network/media self-recovery) → Shaka →
  native. (Muxed in-segment audio remains unswitchable in any browser — a hard MSE
  limit confirmed across hls.js/Shaka/mux.js/mpegts.js; only a server-side remux or
  VLC can.)

### Performance
- **AniZone fetches its season candidates in parallel** (one round-trip instead of
  up to eight), so it resolves quickly. NOTE: on a container running `WARP_MODE=all`,
  routing *every* provider through WARP (~300 ms/request) makes multi-request
  providers (AniZone, the scrapers) time out — use `WARP_MODE=required` so only the
  providers that need WARP (AnimePahe/AnimeWorld/MultiMovies) use it and everything
  else stays direct/fast.

### Added (diagnostics)
- **Connections panel** (Settings → Connections, and Providers → Connections) with a
  **Test connections** button and a `/api/diag` endpoint. Shows each FlareSolverr's
  up/down + ping + version, and — crucially — the **egress IP** each FlareSolverr and
  WARP SOCKS proxy actually uses, compared against the server's direct IP. A green
  **✓WARP** badge means that solver/proxy is really leaving through Cloudflare WARP
  (IP differs from the server's); yellow **⚠direct** means WARP isn't taking effect.

### Changed (WARP)
- Flagged **AnimeWorld** and **MultiMovies** as `requiresWarp` (they reuse a solved
  Cloudflare clearance on a direct follow-up, so their solve + follow-up must share
  one egress IP). With these flags you can run `WARP_MODE=required` — which routes
  only the providers that need WARP through it and leaves the ~14 fast direct-API
  providers direct — instead of `all`, which forced everything through WARP (the
  cause of the across-the-board slowness).

### Fixed (CastleTV)
- Only emit a language source when CastleTV actually has an individual video file for
  it (`existIndividualVideo`), plus one default/master source. Languages that exist
  only as **muxed** audio inside a master (which browsers/hls.js/Shaka cannot switch —
  only VLC can) previously appeared as "English"/"Hindi" sources that returned a
  fallback file and played the wrong audio. They're now omitted.

### Added (player)
- **AniSkip visuals.** The seek bar now shows coloured OP/ED markers so you can see
  where the opening/ending are, and a semi-transparent "Opening/Ending skipped"
  toast appears when a segment is skipped. The **Auto Skip** toggle only shows for
  episodes AniSkip actually has data for. Removed the player's drop shadow.

### Fixed
- **Header-based host resolvers** (`hostextractors.ts`): BuzzServer and GDFlix
  "Instant DL" read their redirect target from the response *body* while the HTTP
  layer silently auto-followed redirects, so the `Location` / `HX-Redirect` header
  was never seen and those links never resolved. Added an opt-in `maxRedirects`
  option to the HTTP layer and made both resolvers stop at the 3xx and read the
  real header. The global default is unchanged, so the providers that already work
  are unaffected.
- **MoviesMod double-digit seasons**: the season regex hardcoded an `S0` prefix
  (`S0${season}`), producing `S010` for season 10 and matching nothing. Now
  zero-padded (`S01` … `S10` … `S12`).

### Changed
- **Anime ID resolution is now cached** (`anime.ts`) per TMDB id (6h). AniList and
  MALSync rate-limit hard and the SSE route re-resolved the same title on every
  request; a quick retry/rewatch could throttle the whole anime chain.
- **Dynamic domain map refreshes** (`domains.ts`): the rotating `domains.json` was
  cached forever, so a mid-run domain rotation needed a restart. It now refreshes
  every 30 min and keeps the stale copy if a refresh fails.
- **2Embed**: sends a real `User-Agent` and a request timeout; dropped the stale
  `iframe as any` cast (`iframe` is a first-class `Stream` type).
- Corrected the AnimePahe note in the provider registry — it is active-but-best-
  effort (its Kwik CDN IP-bans many datacenter egresses), not "parked in
  disabledProviders" as the comment claimed.

### Known issues (upstream, need revival)
- **KissKH**: domain is alive but its `kkey` token endpoint (`/api/Setting/alts`)
  now returns the SPA HTML shell instead of JSON — the token scheme changed.
- **HexaSU**: the `theemoviedb.hexa.su` API host 404s (moved to `hexa.su`); the
  new API needs re-mapping. Intermittently still resolves via cache.

### Tooling
- Added a `provider-audit` skill (`.claude/skills/provider-audit/`) with an
  `sse-probe.js` harness that drives `/api/sources/stream` and prints a
  per-provider FOUND/empty/FAILED table — the ground-truth tool for telling a real
  code bug apart from a dead upstream or a catalog gap.

### Audit hardening & fixes (read/run audit pass)
- **404 page.** Unknown client routes rendered a blank body (no catch-all route);
  added a NotFound route with a link home.
- **Mobile notes fixed.** `.note` blocks with inline emphasis fragmented into cramped
  narrow columns on phone/tablet (flex row); they now render as normal wrapped prose.
- **Proxy SSRF hardening.** Every redirect hop is re-validated against the SSRF guard,
  closing a gap where the WARP fallback path followed redirects unchecked.
- **Sync disk bound.** Per-room history/favourites are capped (with oldest-eviction) so
  a room can't grow to disk without bound.
- **Live/Fallback pill.** The header health indicator now polls, so it can't go stale.
- **API client.** `post()` surfaces a clean status error instead of throwing on a
  non-JSON error body (keeps `{ ok, error }` bodies for the UI).
- **Dead code.** Removed an unreachable auto-muted path from the player.
- **First automated tests + CI.** Unit tests for the SSRF guard and the HLS/subtitle
  rewriters on Node's built-in test runner (no new dependencies), plus a CI workflow
  running type-check + client build + tests on push/PR.
- **Docs.** Added `PROJECT_MAP.md`, `AUDIT_REPORT.md`, `IMPROVEMENTS.md`, and a README
  "Security & exposing your instance" section.

## 1.1.0

Bundled bug-fix + improvement release.

### Added
- **DNS-over-HTTPS (DoH)** for outbound provider/CDN resolution. Fixes `/api/proxy`
  502s and streams that won't load on networks where the local/ISP resolver blocks
  or poisons provider hosts (common on a NAS). Enable with `DOH_ENABLED=true`;
  choose `google` / `cloudflare` / `quad9` via `DOH_PROVIDER`. Reaches the DoH
  endpoint via a bootstrap IP so it works even when system DNS is broken, caches
  by TTL, and falls back to the system resolver on any failure.
- **In-player audio / quality / subtitle selection.** New Shaka-Player engine
  (with hls.js and native fallback) exposes multi-audio (e.g. JP/KR/EN, Hindi/
  Tamil/Telugu) and quality variants that hls.js couldn't surface. Audio track
  selection is always available in the player.
- **New anime providers:** AniZone (native HLS, JP/KR/EN + subtitles), AnimeWorld
  (Indian dubs + Eng/Jap), AnimePahe (native HLS), and an opt-in Consumet
  aggregator (`CONSUMET_URL`).
- **CastleTV** provider — Indian multi-language (Hindi/Tamil/Telugu) movies & series.
- Episode **range selector** (e.g. 1–50) in the player for long series.
- **Sync bridging** — union-find mesh so multiple device codes merge into one room;
  persisted to `SYNC_DATA_FILE`.
- Clipboard fallback so **Copy link** and **Open in VLC** work on insecure-origin
  LAN deployments.

### Changed
- **Anime providers now run and rank first** for anime titles, ahead of the generic
  movie/TV sources (they early-return for non-anime, so movies are unaffected).
- Providers are tried in a stable order per request; broken/empty providers are
  hidden from the sources list.
- Reworked mobile player settings into a full-screen bottom sheet (no more clipping).
- Hero slider uses swipe instead of overlay arrows.
- Reactive settings store — settings persist and apply immediately.
- Anime ID mapping rewritten to TMDB → AniList (GraphQL) → MAL.

### Fixed
- `/api/proxy` DNS failures now report clearly and are resolvable via DoH.
- HLS manifest audio re-defaulting (`&audio=`) and ASS/SSA → VTT subtitle conversion.
- AnimePahe is **native-only** — emits real HLS through the proxy, never an iframe
  or a foreign player. (Where its Kwik host IP-bans the server, it returns nothing
  rather than a broken source.)

### Removed
- Unused Puppeteer/Chromium fallback and its dependencies (removes Node 22
  `EBADENGINE` install warnings). FlareSolverr is the Cloudflare solver.

## 1.0.0

- Initial release: self-hosted movie / TV / anime streaming aggregator (Express +
  TypeScript backend, React + Vite client), Docker/GHCR deployment.
