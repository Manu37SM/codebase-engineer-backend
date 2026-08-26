import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";

describe("database migrations", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("applies migrations and is idempotent across repeated opens", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-db-test-"));
    const dbPath = path.join(tmpDir, "test.db");

    const db1 = openDatabase(dbPath);
    const count1 = (
      db1.prepare("SELECT COUNT(*) as count FROM schema_migrations").get() as {
        count: number;
      }
    ).count;
    expect(count1).toBeGreaterThan(0);
    db1.close();

    const db2 = openDatabase(dbPath);
    const count2 = (
      db2.prepare("SELECT COUNT(*) as count FROM schema_migrations").get() as {
        count: number;
      }
    ).count;
    expect(count2).toBe(count1);

    const tables = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("project");
    expect(tables).toContain("finding");
    expect(tables).toContain("provider_configuration");

    db2.close();
  });
});
