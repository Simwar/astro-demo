import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: proxy the AG-UI endpoint to the FastAPI backend so the browser stays
// same-origin (no CORS) — mirrors production, where FastAPI serves both.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/agui": {
        target: process.env.BACKEND_URL || "http://localhost:8808",
        changeOrigin: true,
      },
    },
  },
});
