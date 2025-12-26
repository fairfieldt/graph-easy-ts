import { defineConfig } from "vite";

function computeBase(): string {
  // On GitHub Pages, the site is served from /<repo>/ by default.
  // Locally and on most other hosts, / is correct.
  const repo = process.env.GITHUB_REPOSITORY?.split("/")[1];
  if (repo) return `/${repo}/`;
  return "/";
}

export default defineConfig({
  base: computeBase(),
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
