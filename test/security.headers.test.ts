import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase, DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";

describe("security response headers", () => {
  let tmpDbDir: string;
  let db: DB;
  let app: FastifyInstance;

  afterEach(() => {
    app.close();
    db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  });

  function setup(trustProxy = false) {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-security-headers-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db, trustProxy });
  }

  it("sets baseline security headers on a plain successful response", async () => {
    setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("still sets security headers on an error (401) response", async () => {
    setup();

    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "headers@example.com", password: "a-real-password-123" },
    });
    const res = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeTruthy();
  });

  it("does not send HSTS over plain http (the default, unproxied case)", async () => {
    setup();
    const res = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });

  it("sends HSTS when the request is (or is trusted to be, via a proxy) https", async () => {
    setup(true);
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/health",
      headers: { "x-forwarded-proto": "https" },
    });
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
  });
});
