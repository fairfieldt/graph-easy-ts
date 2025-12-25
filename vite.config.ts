import { defineConfig } from "vite";

export default defineConfig({
  root: "site",
  publicDir: "public",
  server: {
    port: 5173,
  },
  build: {
    outDir: "../dist-site",
    emptyOutDir: true,
  },
});
