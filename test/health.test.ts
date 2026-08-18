import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { buildApp } from "../src/app.js";

describe("GET /api/v1/health", () => {
  let tmpDbPath: string;

  afterEach(() => {
    if (tmpDbPath && fs.existsSync(tmpDbPath)) {
      fs.rmSync(tmpDbPath, { force: true });
    }
  });

  it("returns 200 with ok status and migration count", async () => {
    tmpDbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "ce-test-")),
      "test.db"
    );
    const db = openDatabase(tmpDbPath);
    const app = buildApp({ db });

    const response = await app.inject({ method: "GET", url: "/api/v1/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.migrationsApplied).toBeGreaterThan(0);

    await app.close();
    db.close();
  });
});
