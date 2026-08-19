#!/usr/bin/env node
// Phase 24 packaging: copies `frontend/dist` (the built React app) into
// `backend/dist/public`, so a single `node dist/server.js` can serve both
// the API and the UI on one port — see `docs/PACKAGING.md`. Plain Node.js
// `fs` calls, not a shell `cp -r`, for the same cross-platform reason
// `copy-migrations.mjs` exists: a shell pipeline that only works under
// bash/sh/zsh breaks `npm run build` on Windows (cmd.exe's default shell).
//
// Deliberately NOT a build failure when the frontend hasn't been built yet
// (e.g. running `npm run build` in `backend/` alone, or in CI that only
// tests the backend) — packaging is additive, never required. `config.ts`'s
// `resolveStaticDir()` already treats a missing `dist/public/index.html` as
// "no frontend available, API-only", so an incomplete copy here degrades
// safely rather than crashing the backend at runtime.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
const frontendDist = path.resolve(backendRoot, "..", "frontend", "dist");
const destDir = path.join(backendRoot, "dist", "public");

if (!fs.existsSync(frontendDist) || !fs.existsSync(path.join(frontendDist, "index.html"))) {
  console.log(
    `No built frontend found at ${path.relative(backendRoot, frontendDist)} — skipping. ` +
      `Run "npm run build" in frontend/ first if you want this backend build to serve the UI too.`
  );
  process.exit(0);
}

fs.rmSync(destDir, { recursive: true, force: true });
fs.cpSync(frontendDist, destDir, { recursive: true });

console.log(`Copied built frontend from ${path.relative(backendRoot, frontendDist)} to ${path.relative(backendRoot, destDir)}`);
