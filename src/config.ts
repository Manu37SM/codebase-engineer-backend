import path from "node:path";
import os from "node:os";
import fs from "node:fs";

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
}

function resolveDataDir(): string {
  const override = process.env.CODEBASE_ENGINEER_DATA_DIR;
  if (override && override.trim().length > 0) {
    return override;
  }
  return path.join(os.homedir(), ".codebase-engineer");
}

export function loadConfig(): AppConfig {
  const dataDir = resolveDataDir();
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? "127.0.0.1";
  const dbPath = path.join(dataDir, "codebase-engineer.db");
  return { port, host, dataDir, dbPath };
}
