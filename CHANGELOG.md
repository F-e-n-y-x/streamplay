# Changelog

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

### Security
- Do **not** self-host `Sherwoodweedy598/MiruroAPI` or `keplerking100/TatakaiAPI`:
  both are malicious forks shipping a Lua-loader infostealer disguised as a
  downloadable "installer." Nothing from them is used in this project.

## 1.0.0

- Initial release: self-hosted movie / TV / anime streaming aggregator (Express +
  TypeScript backend, React + Vite client), Docker/GHCR deployment.
