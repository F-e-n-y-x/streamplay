# syntax=docker/dockerfile:1

# ── Stage 1: build the React/Vite client ─────────────────────────────────────
FROM node:20-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm install
COPY client/ ./
RUN npm run build

# ── Stage 2: runtime (Express + tsx, serves the built client) ────────────────
FROM node:20-alpine AS runtime
WORKDIR /app

# We rely on a FlareSolverr service for Cloudflare bypass, so skip the heavy
# Puppeteer Chromium download. (Set FLARESOLVERR_URL in the environment.)
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    NODE_ENV=production \
    PORT=3000

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
