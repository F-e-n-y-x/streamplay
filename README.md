# StreamPlay

A self-hosted movie / TV / anime streaming aggregator. A **React + Vite** web app on top of a
**Node / Express / TypeScript** backend that pulls metadata from **TMDB** and aggregates streaming
links + subtitles from many providers concurrently (ported from the StreamPlay CloudStream plugin).

> **Personal / educational use.** StreamPlay only indexes and proxies third-party sources — it hosts
> no media itself. You are responsible for how you use it.

---

## Features

- **Browse** Anime, Movies, Series and Asian drama with sort tabs (All / Sub / Dub / Trending /
  Newest / Top Rated / Random), a Reddit-style time-range, region/type toggles and **multi-select
  categories** — including the full MAL/AniList-style anime genre list.
- **Custom player** (hls.js) with custom controls, touch-friendly seeking, subtitles, and an
  in-player **quality + audio-language selector** for multi-bitrate / multi-audio HLS streams.
- **Sources panel** that groups results **by provider**, shows live status dots, and exposes each
  provider's multiple **servers / audio tracks / qualities** with quality + audio filters. Streams
  over **SSE** so sources appear as they resolve. "Open in VLC" / copy-link for any source.
- **Watch history + resume progress** and **favourites**, with **real-time multi-device sync** —
  including **transitive bridging** (link A↔B and B↔C and all three share one library, no shared code
  required) and a live device roster.
- **Playback proxy** that fixes CORS/hotlinking, rewrites HLS manifests (segments, keys, variant +
  audio renditions) back through the proxy, supports range requests, and converts SubRip → WebVTT.
- **Cloudflare bypass** via a FlareSolverr instance (with a bundled Puppeteer-stealth fallback).

---

## Quick start (Docker — recommended)

The image and a FlareSolverr companion are wired together in [`docker-compose.yml`](docker-compose.yml).

```bash
# 1. Get the compose file + env template
curl -O https://raw.githubusercontent.com/F-e-n-y-x/streamplay/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/F-e-n-y-x/streamplay/main/.env.example

# 2. Edit .env and set TMDB_API_KEY (free key: https://www.themoviedb.org/settings/api)

# 3. Launch
docker compose up -d
```

Open **http://localhost:3000**.

The published image lives at **`ghcr.io/f-e-n-y-x/streamplay`** and is tagged per release
(`:1.0.0`, `:1.0`, `:1`, `:latest`) plus a rolling `:edge` from `main`.

### Portainer

A ready-to-paste stack is in [`docs/portainer-stack.yml`](docs/portainer-stack.yml): in Portainer go
**Stacks → Add stack**, paste it into the web editor, add a `TMDB_API_KEY` environment variable, and
**Deploy**. Full deployment notes (including building from source) are in [`docs/DEPLOY.md`](docs/DEPLOY.md).

---

## Quick start (local / development)

```bash
npm install                 # server deps
npm run build:client        # build the web client once (or after UI changes)
cp .env.example .env         # then set TMDB_API_KEY
npm run dev                 # server on http://localhost:3000
```

For UI work with hot reload, run the Vite dev server (proxies `/api` to the backend):

```bash
npm run dev:client          # Vite on http://localhost:5173
```

---

## Configuration

All settings are environment variables (see [`.env.example`](.env.example)):

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | Port the server listens on. |
| `TMDB_API_KEY` | — | **Required.** TMDB v3 API key for all metadata/browse/search. |
| `FLARESOLVERR_URL` | — | FlareSolverr endpoint for Cloudflare bypass. In Compose: `http://flaresolverr:8191/`. Blank → bundled Puppeteer fallback. |
| `WYZIE_KEY` | — | Optional key for WYZIE subtitles. Blank disables that provider. |
| `PROVIDER_TIMEOUT_MS` | `45000` | Per-provider timeout before a source is dropped. |
| `SYNC_DATA_FILE` | `./sync-data.json` | Where multi-device sync state is persisted (a Docker volume path in Compose). |

---

## API

The web client is served at `/`; the JSON/SSE API lives under `/api`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/home` | Hero + carousels for the home page. |
| `GET /api/browse?section=&cat=&type=&range=&genres=&page=` | Catalog browsing (anime/movies/series/asian). |
| `GET /api/search?q=` | Search movies & TV. |
| `GET /api/title/:type/:id` | Title detail (+ `/season/:n` for TV). |
| `GET /api/sources/stream?type=&id=&season=&episode=` | **SSE** stream of resolved sources + subtitles. |
| `GET /api/proxy?url=&h=&m3u8=1` | Stream proxy (HLS rewrite, range, srt→vtt at `/api/proxy/sub`). |
| `GET /api/providers` · `GET /api/providers/health` | Provider list / health. |
| `… /api/sync/:code/*` | Multi-device history + favourites sync, roster, and code **bridging**. |

Legacy endpoints (`/api/info`, `/api/streams`, `/api/providers/status`) are kept for compatibility.

---

## Project layout

```text
src/                Express server (routes/, extractors/ providers, utils/)
client/             React + Vite web app (token-based design system in src/styles/)
public/             Legacy fallback UI
docs/               Deployment notes + Portainer stack
Dockerfile          Multi-stage build (client → runtime)
docker-compose.yml  App + FlareSolverr
```

## Adding providers

Create a file in `src/extractors/` implementing the `Provider` interface and register it in
`src/extractors/index.ts`.

## License

For personal and educational use. See [LICENSE](LICENSE).
