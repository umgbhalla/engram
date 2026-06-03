import { defineConfig } from "vite";

// Single-page Engram notebook SPA. Builds to dist/ for Cloudflare Workers Assets.
export default defineConfig({
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
  },
});
