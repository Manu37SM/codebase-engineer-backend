import { loadConfig } from "./config.js";
import { openDatabase } from "./db/index.js";
import { buildApp } from "./app.js";

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const app = buildApp({ db });

  try {
    await app.listen({ port: config.port, host: config.host });
    // eslint-disable-next-line no-console
    console.log(
      `Codebase Engineer backend listening on http://${config.host}:${config.port} (db: ${config.dbPath})`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  }
}

main();
