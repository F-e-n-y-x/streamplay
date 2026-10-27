import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server. /api is proxied to the StreamPlay backend so the browser never needs a
// TMDB key and there's no CORS to fight in development.
export default defineConfig({
  plugins: [react()],
  // Browser floor: Chrome/Edge 110, Firefox 115 ESR, Safari/iOS 15.4 (= browserslist
  // "chrome >= 110, edge >= 110, firefox >= 115, safari >= 15.4, ios_saf >= 15.4").
  // CSS keeps plain fallbacks before color-mix() (Safari < 16.2); `inert` (Safari 15.5)
  // is backed by aria-hidden where it matters.
  build: { target: ["chrome110", "edge110", "firefox115", "safari15.4"] },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/api": {
        target: process.env.SERVER_URL || "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
