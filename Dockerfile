# syntax=docker/dockerfile:1

# ── Stage 1: build the React/Vite client ─────────────────────────────────────
# Node 22 LTS: required by Vite 8 (needs Node >=20.19 / >=22.12) and its Rust-based
# Rolldown bundler; node:20-alpine can be too old and would fail the client build.
FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ── Stage 2: runtime (Express + tsx, serves the built client) ────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

# We rely on a FlareSolverr service for Cloudflare bypass, so skip the heavy
# Puppeteer Chromium download. (Set FLARESOLVERR_URL in the environment.)
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NODE_ENV=production \
    PORT=3000

# ffmpeg — remux torrent .mkv releases to browser-playable fragmented MP4 (torrent
# mode). mesa-va-gallium + libva add VAAPI so an AMD/Intel iGPU can transcode HEVC
# when TORRENT_VAAPI=1 and /dev/dri is mapped in.
RUN apk add --no-cache ffmpeg mesa-va-gallium libva

COPY package*.json ./
RUN npm install --omit=optional

# Server source (run directly with tsx — no separate compile step)
COPY tsconfig.json ./
COPY src/ ./src/
COPY public/ ./public/

# Built web client from stage 1
COPY --from=client /app/client/dist ./client/dist

EXPOSE 3000

# Persist multi-device sync state (history/favourites/bridge graph) on a volume
VOLUME ["/app/data"]
ENV SYNC_DATA_FILE=/app/data/sync-data.json

CMD ["npm", "start"]
