# PROJECT_MAP.md — StreamPlay

> Read-only architecture map produced in **Phase 0** of the audit. No code was modified.
> Companion to `AUDIT_REPORT.md` (Phase 1 findings) and `IMPROVEMENTS.md` (Phase 3 suggestions).

## What it is

A **self-hosted movie / TV / anime streaming aggregator**. It pulls metadata from **TMDB** and
aggregates streaming links + subtitles from ~30 active third-party providers concurrently, proxies
the resulting HLS/MP4 back through its own server (to fix CORS/hotlinking), and plays them in a
custom in-browser player. Ported from the "StreamPlay" CloudStream plugin. Personal/educational use;
it hosts no media itself.

## Stack

| Layer | Tech |
| --- | --- |
| **Backend** | Node + **Express 4** + **TypeScript** (CommonJS, `tsc` → `dist/`, run via `tsx`) |
| **Frontend** | **React 19** + **Vite 8** + TypeScript, **React Router 6**, **TanStack Query 5**, **hls.js** + **shaka-player**, **zod** |
| **Scraping** | axios + cheerio, **FlareSolverr** (Cloudflare bypass), **Cloudflare WARP** (SOCKS5), **DoH** (DNS-over-HTTPS) |
| **Torrents** | **webtorrent** + ffmpeg remux, optional debrid / Jackett-Prowlarr (Torznab) |
| **Deploy** | Multi-stage **Dockerfile**, `docker-compose.yml` (app + FlareSolverr), GHCR image, Portainer stack |

Node 24 locally; deps installed; `client/dist` present. **No test framework, no ESLint, no Prettier**
in the repo (`npm test` is a placeholder that exits 1).

## Entry points & data flow

```
Browser ──/api──▶ Express (src/index.ts)
                   ├─ /api/proxy   (routes/proxy.ts)   playback proxy + HLS rewrite + srt/ass→vtt
                   ├─ /api/torrent (routes/torrent.ts) webtorrent stream / debrid passthrough
                   ├─ /api/sync    (routes/sync.ts)    multi-device history/fav sync (SSE rooms)
                   ├─ /api         (routes/web.ts)     client API (home/browse/title/search/suggest/
                   │                                    sources SSE/skip-times/diag/providers/config)
                   └─ static: serves client/dist (gzip), SPA fallback
```

- `src/index.ts` — bootstraps Express, JSON-only body parsing, optional STREAMPLAY_PASSWORD gate, TRUST_PROXY, gzip + static
  serving with cache-control (hashed assets immutable, `index.html` no-cache), SPA fallback, and a
  final error-handling middleware.
- **Server reads** flow through `client/src/lib/api.ts` (`/api` proxied to :3000 in dev by Vite).
- **Sources resolution** is a **Server-Sent Events** stream (`GET /api/sources/stream`): the server
  fans out across the per-kind provider set, emits `provider`/`link`/`subtitle`/`log`/`done` events as
  each resolves, caches a complete resolve for 8 min, and aborts all in-flight work when the tab closes.

## Backend (`src/`)

### Metadata pipeline
`tmdb.ts` (TMDB v3 client; derives `isAnime/isCartoon/isAsian/isBollywood`) → `meta.ts::seasonPlan()`
picks the best season/episode structure source: **anilist** (`anime.ts` + `anilist.ts`: AniList
GraphQL + MALSync + api.ani.zip, cour-as-season modeling) → **tvdb** (`utils/tvdb.ts`, cartoons +
Indian series) → **castle** (Indian daily-soap fallback) → **tmdb** (default). All caches are
in-memory with TTLs; `seasonPlan` never throws.

### Extractor system
`src/extractors/index.ts` registers static provider instances into three arrays: `providers`
(fan-out), `disabledProviders` (dead upstreams kept for revival), `TORRENT_PROVIDERS` (torrent mode).
`PROVIDER_KINDS` gates which providers run per `ContentKind` (anime/asian/movie/series). `Provider`
interface (`types.ts`): `{ id, name, invoke(LinkData) => Promise<ExtractorResult>, requiresWarp?, kinds? }`.

~40 extractors, grouped: dedicated **anime** (allanime, anizone, animeworld, animepahe, consumet);
direct-API **movie/TV** (twoembed, vidfast, vidrock, hexa, rivestream, allmovieland, xpass, vaplayer,
dahmermovies); **asian** (kisskh); Indian multi-lang (castle); **Cloudflare-gated scrapers** needing
FlareSolverr (vegamovies, hdhub4u, fourkhdhub, movies4u, rogmovies, multimovies, uhdmovies, moviesmod,
topmovies, bollyflix, cinemacity); **subtitles** (subtitleapi, wyziesubs); **torrent** (torrent,
torrentVideo); **disabled** (vidlink, videasy, vidzee, moviebox, mapple, vidsrcxyz, peachify, ninetv,
moviesdrive, hdmovie2). `utils/hostextractors.ts` resolves collected file-host/embed URLs (HubCloud,
GDFlix, StreamWish/Filelions family, etc.) with a packed-JS unpacker (ReDoS-capped) and a recursion
depth guard.

### Utils
`http.ts` (extractor HTTP layer: CF cookie-jar, FlareSolverr fallback, WARP/DoH) · `net.ts` (metadata
axios) · `dns.ts` (DoH resolver, hardcoded bootstrap IPs) · `ssrf.ts` (SSRF guard — see below) ·
`flaresolverr.ts` (pooled FIFO client) · `warp.ts` (WARP SOCKS5 modes via AsyncLocalStorage) ·
`encdec.ts` (enc-dec.app token service, concurrency-gated) · `domains.ts` (dynamic provider domains
from a hosted JSON) · `reqctx.ts` (per-request AbortSignal) · `providerStats.ts` (health + circuit
breaker, disk-persisted) · `serverConfig.ts` (Torznab config, disk) · `torrent.ts` + `torrentSearch.ts`
(webtorrent + indexer/debrid clients).

### Security surfaces
- **SSRF guard** (`utils/ssrf.ts`) — `guardUrl` (scheme + literal/encoded-IP host check, handles
  decimal/hex/octal IPv4 and IPv6-mapped) plus `ssrfAgents()` whose DNS lookup rejects any host
  resolving to private/loopback/link-local/CGNAT — defeats DNS rebinding and redirect-to-internal.
  Applied on `/api/proxy`, `/api/proxy/sub`, `/api/torrent/http`. **Gap:** the WARP fallback branch
  in `proxy.ts::fetchUpstream` does not re-attach the guarded agents (mitigated by WARP egress, but
  redirects on that branch aren't IP-revalidated).
- **`/api/sync`** rooms are **unauthenticated** — anyone who knows a code can read/write it (by design
  for personal use); room count capped at 5000, but per-room payload size is uncapped.
- **Admin/debug gating** — `/api/config/torznab` (write) and `/api/debug/provider` are gated by
  optional `ADMIN_TOKEN` / `DEBUG_TOKEN` env vars; open when unset.
- **Hardcoded provider keys** — several extractors embed reverse-engineered AES/HMAC keys and device
  fingerprints (vidrock, peachify, vidzee, moviebox, mapple, castle, allanime). These are provider
  secrets ported from the plugin, **not** user credentials, but they are committed in plaintext.
  TMDB/TVDB keys are correctly env-only (no user key committed).

## Frontend (`client/src/`)

SPA: `main.tsx` → `QueryClientProvider` (staleTime 5m, retry 1, no refetch-on-focus) + `BrowserRouter`.
`App.tsx` lazy-loads every page inside one `ErrorBoundary` + `Suspense`. Service worker registered in
production only (installable PWA).

### Pages (`pages/`)
`Home` (hero + Continue Watching + rows) · `Search` (multi-search + load-more) · `Title` (detail,
seasons/episodes, cast, recs, trailer overlay) · `Browse` (one component for Movies/Series/Anime/Asian
via `section` prop; cat/type/range/industry/audio/genre filters) · `Watch` (custom player page: source
discovery via SourcesPanel, failover, AniSkip, resume, floating mini-player) · `Providers` (ops
dashboard: provider list/health + FlareSolverr/WARP diag) · `Watchlist`/"Library" (localStorage views,
no network) · `Settings` (appearance, playback, WARP, Torznab, sync codes + device roster).

### State (`lib/`)
Three independent stores + React Query — no Redux/Context.
- `queries.ts` — all server reads as TanStack Query hooks; `lang`+`adult` folded into every key.
- `api.ts` — fetch client (`get` throws on non-2xx; **`post` does not check `res.ok`**) + `sourcesStreamUrl()`.
- `store.ts` — history + favourites on localStorage via `useSyncExternalStore`; optional real-time
  multi-device sync (EventSource room, LWW by `updatedAt`, bulk merge, roster, transitive bridge).
- `settings.ts` — client prefs (`sp.settings.v3`), with device-local tiers (torrent mode, player prefs)
  deliberately excluded from sync.
- `watchlist.ts` (compat shim over store) · `theme.ts` (`data-theme`, pre-paint no-flash script).

localStorage keys: `sp.data.v1`, `sp.sync.code`, `sp.device.id`/`.name`, `sp.settings.v3`,
`sp.torrentMode`, `sp.deviceSettings`, `sp.theme`.

### Components (`components/`)
`Player.tsx` (exports `Player` overlay / `EmbedFrame` iframe / `VideoPlayer` custom mp4/hls player) ·
`SourcesPanel.tsx` (SSE-driven grouped source list, filters, auto-advance) · `HeroSlider` ·
`Header` (nav, search, TMDB live/fallback pill, theme toggle) · `Row` (drag-scroll poster rail) ·
`ProviderPrefsEditor` (reorder/hide providers per kind) · `ErrorBoundary` · plus `PosterCard`,
`ContinueCard`, `CategoryPicker`, `Dropdown`, `icons.tsx`.

### Styling
Token-based design system documented in `styles/design-system.md`: `tokens.css` (single source of
truth — gray ramp, semantic roles, 4px spacing, radius, motion; dark default + `[data-theme=light]`)
→ `app.css` (reset + component classes) → `icons.tsx` (Lucide-style SVGs). Neutral-dominant, single
accent, Lucide-only icons, honors `prefers-reduced-motion`.

## Health snapshot (verified in Phase 0)
- ✅ Server `tsc --noEmit` — passes (exit 0).
- ✅ Client `tsc -b` — passes (exit 0).
- ⚠️ No tests / ESLint / Prettier configured.

## Things that look unfinished / suspicious (carried into Phase 1)
- Dead "auto-muted" UI path in `Player.tsx` (`setAutoMuted(true)` never called → unreachable pill + `unmute()`).
- `api.ts::post()` ignores HTTP status (unlike `get()`).
- `Header` health pill fetched once on mount, never refreshed → can go stale.
- Two genuinely silent `catch(e) {}` blocks in `extractors/kisskh.ts` (key-fetch failures invisible).
- Large block of disabled/dead providers shipped in the tree (intentional, but dead code).
- Stale/contradictory comment vs. code in `tmdb.ts` season-fetch block.
- Inconsistent data-fetching (most pages use React Query; `Watch`, `ConnectionsPanel`, `TorznabCard`,
  `ProviderPrefsEditor` hand-roll `useEffect`+`alive`).
- Committed plaintext provider keys/fingerprints (see Security surfaces).
- WARP-fallback SSRF re-validation gap in `proxy.ts`.
