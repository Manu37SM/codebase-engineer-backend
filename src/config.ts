import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Central config loading. Keep this minimal for Phase 0/1 — no AI provider
 * secrets are loaded or required here. AI provider configuration lives in
 * the `provider_configuration` DB table (see docs/ARCHITECTURE.md §3),
 * never in process env dumped to the frontend.
 */
export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  dbPath: string;
  /**
   * Directory containing the built frontend (`index.html` + assets), or
   * `null` if none exists. Phase 24 packaging: `npm run build` copies
   * `frontend/dist` into `backend/dist/public` (see
   * `scripts/copy-frontend.mjs`) so a single `node dist/server.js` can
   * serve both the API and the UI on one port — see `docs/PACKAGING.md`.
   * Resolved relative to this compiled module's own location (via
   * `import.meta.url`), not `process.cwd()`, so it works regardless of
   * which directory the process is started from. `null` in the normal
   * `vitest` test run (this file executes from `src/`, where no `public/`
   * directory exists) and in any environment where the frontend hasn't
   * been built — the backend remains fully functional API-only in that
   * case, exactly as it always has; static serving is additive, never
   * required.
   */
  staticDir: string | null;
}

function resolveDataDir(): string {
  const override = process.env.CODEBASE_ENGINEER_DATA_DIR;
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(os.homedir(), ".codebase-engineer");
}

function resolveStaticDir(): string | null {
  const override = process.env.CODEBASE_ENGINEER_STATIC_DIR;
  const candidate =
    override && override.trim().length > 0
      ? override
      : path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
  return fs.existsSync(path.join(candidate, "index.html")) ? candidate : null;
}

export function loadConfig(): AppConfig {
  const dataDir = resolveDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? "127.0.0.1";
  const dbPath = path.join(dataDir, "codebase-engineer.db");
  const staticDir = resolveStaticDir();
  return { port, host, dataDir, dbPath, staticDir };
}
