# Deploying StreamPlay

StreamPlay ships as a Docker image with a FlareSolverr companion for Cloudflare bypass. There are
three common ways to run it.

---

## 1. Docker Compose (recommended)

```bash
curl -O https://raw.githubusercontent.com/F-e-n-y-x/streamplay/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/F-e-n-y-x/streamplay/main/.env.example
# edit .env → set TMDB_API_KEY
docker compose up -d
```

- App: <http://localhost:3000>
- Sync state persists in the `streamplay-data` named volume.
- Update: `docker compose pull && docker compose up -d`.

Pin a specific version instead of `latest` by editing the image tag, e.g.
`ghcr.io/f-e-n-y-x/streamplay:v1.0.0`.

---

## 2. Portainer

1. **Stacks → Add stack**, name it `streamplay`.
2. Paste the contents of [`portainer-stack.yml`](portainer-stack.yml) into the **Web editor**.
3. Under **Environment variables** add:
   - `TMDB_API_KEY` = your TMDB v3 key (**required**)
   - `WYZIE_KEY` = optional (leave blank to disable WYZIE subtitles)
4. **Deploy the stack** and open `http://<server-ip>:3000`.

To update: change the image tag (or re-pull `:latest`) and redeploy the stack. The
`streamplay-data` volume keeps your synced history/favourites across redeploys.

---

## 3. Single container (bring your own FlareSolverr)

```bash
docker run -d --name streamplay \
  -p 3000:3000 \
  -e TMDB_API_KEY=xxxxx \
  -e FLARESOLVERR_URL=http://<flaresolverr-host>:8191/ \
  -v streamplay-data:/app/data \
  -e SYNC_DATA_FILE=/app/data/sync-data.json \
  ghcr.io/f-e-n-y-x/streamplay:latest
```

If you omit `FLARESOLVERR_URL`, the app falls back to the bundled Puppeteer-stealth solver — but the
published image skips the Chromium download, so a reachable FlareSolverr instance is recommended.

---

## 4. Build from source

```bash
git clone https://github.com/F-e-n-y-x/streamplay.git
cd streamplay
docker build -t streamplay .
# or, without Docker:
npm install && npm run build:client && npm start
```

---

## Versioning & images

Images are published to GitHub Container Registry by CI on every push:

| Trigger | Tags produced |
| --- | --- |
| Git tag `v1.2.3` | `:v1.2.3`, `:1.2`, `:1`, `:latest`, `:sha-<short>` |
| Push to `main` | `:edge`, `:sha-<short>` |

Cut a release by tagging a commit:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The **Build & publish Docker image** workflow then builds and pushes the versioned image.
