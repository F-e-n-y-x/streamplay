<div align="center">

# 🎬 StreamPlay

**Your own ad-free Netflix for movies, TV & anime — self-hosted.**

Pulls metadata from TMDB + AniList and streams from many sources, all in a clean web player.
No media is hosted — StreamPlay only indexes and proxies third-party links.

<sub>Personal / educational use. You're responsible for how you use it.</sub>

</div>

---

## ⚡ Get started in 3 steps

```bash
# 1 — grab the compose file + env template
curl -O https://raw.githubusercontent.com/F-e-n-y-x/streamplay/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/F-e-n-y-x/streamplay/main/.env.example

# 2 — open .env and paste a free TMDB key  →  themoviedb.org/settings/api

# 3 — launch
docker compose up -d
```

Then open **http://localhost:3000** 🎉

> **Portainer?** Paste [`docs/portainer-stack.yml`](docs/portainer-stack.yml) into *Stacks → Add stack*, add your `TMDB_API_KEY`, deploy. More: [`docs/DEPLOY.md`](docs/DEPLOY.md).

Image: `ghcr.io/f-e-n-y-x/streamplay` · tags `:latest` `:1.2.0` `:edge`.

---

## ✨ What you get

- 🍿 **Browse** Movies, Series, Anime & Asian drama — with Latest / Trending / Airing / Top-Rated tabs, time ranges, and multi-select genres.
- 🌸 **Anime done right** — powered by AniList: the full genre/tag list, per-season entries, and a **Latest Episodes** home view.
- ▶️ **Custom player** — quality + audio-track picker, subtitles, resume, skip intro/outro, floating mini-player.
- 🔎 **Live sources** — results stream in per provider (SSE) with quality/audio filters and one-click "Open in VLC".
- 🔁 **Multi-device sync** — watch history, resume progress & favourites synced across your devices in real time.
- 🛡️ **Smart proxy** — fixes CORS/hotlinking, rewrites HLS, converts subtitles, SSRF-guarded.
- ☁️ **Cloudflare bypass** — via FlareSolverr, with optional WARP for a clean egress IP.

---

## ⚙️ Configure

Only one variable is required. Full list + comments in [`.env.example`](.env.example).

| Variable | Required | What it does |
| --- | :---: | --- |
| `TMDB_API_KEY` | ✅ | Free TMDB key — powers all metadata/browse/search. |
| `FLARESOLVERR_URL` | – | FlareSolverr endpoint (`http://flaresolverr:8191/`) to unlock Cloudflare-gated providers. |
| `DOH_ENABLED` | – | Set `true` if streams won't load / DNS 502s (common on a NAS or blocking ISP). |
| `WARP_MODE` + `WARP_*` | – | Route blocked providers through Cloudflare WARP for a clean IP. |

<details>
<summary>🔐 <b>Exposing it to the internet? Read this.</b></summary>

<br>

StreamPlay is built for a **trusted network** (LAN, Tailscale/VPN, or behind an authenticating reverse proxy) and its API is intentionally **unauthenticated**:

- **Sync rooms** are keyed only by a sync code — anyone who reaches the server and knows a code can read/write it.
- **The playback proxy** streams arbitrary external URLs. It's **SSRF-guarded** (can't reach your LAN/metadata), but on a public box it's an open forward-proxy.
- **CORS** is open (`*`).

**Don't expose the port directly to the internet without an auth layer.** For a semi-public box, gate the sensitive endpoints with `ADMIN_TOKEN` (Torznab config) and `DEBUG_TOKEN` (provider diagnostics).

</details>

---

<details>
<summary>🛠️ Local development</summary>

<br>

```bash
npm install            # server deps
npm run build:client   # build the web app once (or after UI changes)
cp .env.example .env    # then set TMDB_API_KEY
npm run dev            # server → http://localhost:3000
npm run dev:client     # (optional) Vite hot-reload → http://localhost:5173
```

</details>

<details>
<summary>🧩 Project layout & adding providers</summary>

<br>

```text
src/                Express server — routes/, extractors/ (providers), utils/
client/             React + Vite web app (design tokens in src/styles/)
docs/               Deployment notes, Portainer stack, provider research
Dockerfile          Multi-stage build (client → runtime)
docker-compose.yml  App + FlareSolverr (+ optional WARP)
```

Add a provider: implement the `Provider` interface in `src/extractors/<name>.ts` and register it in `src/extractors/index.ts`. See [`docs/anime-providers-research.md`](docs/anime-providers-research.md) for the anime provider landscape.

</details>

<details>
<summary>🔌 API reference</summary>

<br>

Web client at `/`; JSON/SSE API under `/api`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/home` | Home carousels. |
| `GET /api/browse?section=&cat=&genres=&page=` | Catalog browsing. |
| `GET /api/search?q=` | Search. |
| `GET /api/title/:type/:id` | Title detail (+ `/season/:n`). |
| `GET /api/sources/stream?type=&id=&season=&episode=` | **SSE** resolved sources + subtitles. |
| `GET /api/proxy?url=&m3u8=1` | Stream proxy (HLS rewrite, range, `…/sub` for srt→vtt). |
| `GET /api/providers` · `/api/providers/health` | Provider list / health. |
| `… /api/sync/:code/*` | Multi-device sync + code bridging. |

</details>

---

<div align="center"><sub>For personal & educational use · <a href="LICENSE">LICENSE</a></sub></div>
