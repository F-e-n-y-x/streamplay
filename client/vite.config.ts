import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Frontend dev server. /api is proxied to the StreamPlay backend so the browser never needs a
// TMDB key and there's no CORS to fight in development.
export default defineConfig({
  plugins: [react()],
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
