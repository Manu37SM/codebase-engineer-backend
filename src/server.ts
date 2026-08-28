import "dotenv/config";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const app = buildApp({ db, staticDir: config.staticDir, trustProxy: config.trustProxy, dataDir: config.dataDir });

  try {
    await app.listen({ port: config.port, host: config.host });

    console.log(
      `Codebase Engineer backend listening on http://${config.host}:${config.port} (db: ${config.dbPath})`
    );

    console.log(
      config.staticDir
        ? `Serving built frontend from ${config.staticDir}`
        : "No built frontend found — serving API only (run `npm run build` in ../frontend, then here, to serve the UI from this process)."
    );
  } catch (err) {

    console.error(err);
    process.exit(1);
  }
}

main();
