# syntax=docker/dockerfile:1

# ── Stage 1: build the React/Vite client ─────────────────────────────────────
# Node 22 LTS: Vite 8 / Rolldown need Node >=20.19 / >=22.12.
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── Stage 2: compile the server (tsc → dist/) ────────────────────────────────
FROM node:22-alpine AS server
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=optional
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# ── Stage 3: runtime (plain node, serves the built client) ───────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# FlareSolverr handles Cloudflare, so skip Puppeteer's Chromium download.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NODE_ENV=production \
    PORT=3000 \
    SYNC_DATA_FILE=/app/data/sync-data.json

# ffmpeg — remux torrent .mkv to fragmented MP4. mesa-va-gallium + libva add VAAPI
# (TORRENT_VAAPI=1 + /dev/dri mapped; the node user then needs the host's render gid
# via compose `group_add`). tini reaps children (ffmpeg) and forwards SIGTERM.
RUN apk add --no-cache ffmpeg mesa-va-gallium libva tini

COPY package*.json ./
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

COPY --from=server /app/dist ./dist
COPY --from=client /app/client/dist ./client/dist

# Healthcheck hits / (static, never behind STREAMPLAY_PASSWORD; /api/health would 401).
# Sync/provider-stats/server-config live on the volume; it must be writable by `node`.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
