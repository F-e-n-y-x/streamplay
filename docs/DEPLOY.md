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

The compose file tracks the `:1` major tag (all 1.x releases). Pin an exact version by editing the
image tag, e.g. `ghcr.io/f-e-n-y-x/streamplay:1.3.1`.

**Upgrading from an image older than the non-root release:** the container now runs as the `node`
user (uid 1000), so a `streamplay-data` volume created by an older (root) image must be re-owned once:

```bash
docker run --rm -v streamplay-data:/d alpine chown -R 1000:1000 /d
```

For VAAPI (`TORRENT_VAAPI=1` + `/dev/dri` mapped), also add the host's render group, e.g.
`group_add: ["<gid>"]` where `<gid>` comes from `getent group render` on the host.

---

## 2. Portainer

1. **Stacks → Add stack**, name it `streamplay`.
2. Paste the contents of [`portainer-stack.yml`](portainer-stack.yml) into the **Web editor**.
3. Under **Environment variables** add:
   - `TMDB_API_KEY` = your TMDB v3 key (**required**)
   - `WYZIE_KEY` = optional (leave blank to disable WYZIE subtitles)
4. **Deploy the stack** and open `http://<server-ip>:3000`.

To update: change the image tag (or re-pull `:1`) and redeploy the stack. The
`streamplay-data` volume keeps your synced history/favourites across redeploys.

---

## 3. Single container (bring your own FlareSolverr)

```bash
docker run -d --name streamplay \
  -p 3000:3000 \
  -e TMDB_API_KEY=xxxxx \
  -e FLARESOLVERR_URL=http://<flaresolverr-host>:8191/ \
  -v streamplay-data:/app/data \
  ghcr.io/f-e-n-y-x/streamplay:1
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
npm ci && npm run build && npm start   # build = client + tsc → dist/
```

---

## Versioning & images

Images are published to GitHub Container Registry by CI (after build + tests pass) on every push:

| Trigger | Tags produced |
| --- | --- |
| Git tag `v1.2.3` | `:1.2.3`, `:1.2`, `:1`, `:latest`, `:sha-<short>` |
| Push to `main` | `:edge`, `:sha-<short>` |

(The `v` prefix on the git tag is dropped in the image tag, per semver convention.)

Cut a release by tagging a commit:

```bash
git tag v1.0.0
git push origin v1.0.0
```

The **Build & publish Docker image** workflow then builds and pushes the versioned image.
