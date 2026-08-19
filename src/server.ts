import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const app = buildApp({ db, staticDir: config.staticDir });

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
