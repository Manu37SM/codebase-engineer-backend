import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/index.js";
import { buildApp } from "../src/app.js";

describe("static frontend serving (Phase 24 packaging)", () => {
  let tmpDbPath: string;
  let staticDir: string;

  afterEach(() => {
    if (tmpDbPath && fs.existsSync(tmpDbPath)) fs.rmSync(tmpDbPath, { force: true });
    if (staticDir && fs.existsSync(staticDir)) fs.rmSync(staticDir, { recursive: true, force: true });
  });

  function makeApp(withStatic: boolean) {
    tmpDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ce-test-")), "test.db");
    const db = openDatabase(tmpDbPath);

    if (withStatic) {
      staticDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-static-"));
      fs.writeFileSync(
        path.join(staticDir, "index.html"),
        "<!doctype html><html><body>codebase-engineer-ui</body></html>"
      );
      fs.mkdirSync(path.join(staticDir, "assets"));
      fs.writeFileSync(path.join(staticDir, "assets", "app.js"), "console.log('real asset');");
    }

    return { db, app: buildApp({ db, staticDir: withStatic ? staticDir : null }) };
  }

  it("without a staticDir, behaves exactly as API-only (no regression for the normal test/dev setup)", async () => {
    const { db, app } = makeApp(false);

    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(404);

    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(health.statusCode).toBe(200);

    await app.close();
    db.close();
  });

  it("serves the real built index.html at the root", async () => {
    const { db, app } = makeApp(true);

    const response = await app.inject({ method: "GET", url: "/" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("codebase-engineer-ui");
    expect(response.headers["content-type"]).toMatch(/text\/html/);

    await app.close();
    db.close();
  });

  it("serves a real static asset file directly", async () => {
    const { db, app } = makeApp(true);

    const response = await app.inject({ method: "GET", url: "/assets/app.js" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("real asset");

    await app.close();
    db.close();
  });

  it("falls back to index.html for an unmatched client-side route (SPA routing)", async () => {
    const { db, app } = makeApp(true);

    const response = await app.inject({ method: "GET", url: "/findings" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("codebase-engineer-ui");

    await app.close();
    db.close();
  });

  it("still returns a real API response for a real API route, not the SPA fallback", async () => {
    const { db, app } = makeApp(true);

    const response = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");

    await app.close();
    db.close();
  });

  it("returns a real JSON 404, never the SPA fallback, for an unmatched API route", async () => {
    const { db, app } = makeApp(true);

    const response = await app.inject({ method: "GET", url: "/api/v1/this-route-does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });
    expect(response.body).not.toContain("codebase-engineer-ui");

    await app.close();
    db.close();
  });

  it("returns a real JSON 404 for a non-GET request to an unknown path, not HTML", async () => {
    const { db, app } = makeApp(true);

    const response = await app.inject({ method: "POST", url: "/some/unknown/path" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "Not found" });

    await app.close();
    db.close();
  });

  it("refuses a real path-traversal attempt against the static root", async () => {
    const { db, app } = makeApp(true);

    const secretPath = path.join(path.dirname(staticDir), "outside-secret.txt");
    fs.writeFileSync(secretPath, "should never be servable");

    const response = await app.inject({
      method: "GET",
      url: "/assets/../../" + path.basename(secretPath),
    });

    expect(response.body).not.toContain("should never be servable");
    if (response.statusCode === 200) {
      expect(response.body).toContain("codebase-engineer-ui");
    } else {
      expect([400, 403, 404]).toContain(response.statusCode);
    }

    fs.rmSync(secretPath, { force: true });
    await app.close();
    db.close();
  });
});
