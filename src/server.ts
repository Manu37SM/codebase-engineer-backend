import "dotenv/config";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { buildApp } from "./app.js";

// `dotenv/config` (imported above, before anything else) loads a `.env`
// file from the current working directory into `process.env` if one
// exists — silently a no-op if it doesn't, so this has zero effect on any
// existing deployment that sets real environment variables directly
// (systemd, Docker, PowerShell `$env:`, etc.), and just makes local
// development more convenient. This must be the first import in the file:
// `config.ts` and `billing/config.ts` both read `process.env` at call
// time, so `.env` has to be loaded before `loadConfig()` runs below. See
// `.env.example` for every variable this server reads, including the
// optional `DODO_PAYMENTS_*` ones (docs/MONETIZATION.md §6 has full setup
// instructions).
async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const app = buildApp({ db, staticDir: config.staticDir, trustProxy: config.trustProxy, dataDir: config.dataDir });

  try {
    await app.listen({ port: config.port, host: config.host });
    // eslint-disable-next-line no-console
    console.log(
      `Codebase Engineer backend listening on http://${config.host}:${config.port} (db: ${config.dbPath})`
    );
    // eslint-disable-next-line no-console
    console.log(
      config.staticDir
        ? `Serving built frontend from ${config.staticDir}`
        : "No built frontend found — serving API only (see docs/PACKAGING.md to build and serve the UI from this process)."
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  }
}

main();
