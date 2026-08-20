import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase, DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { encryptToken, decryptToken } from "../src/auth/crypto.js";
import { verifyTurnstile } from "../src/auth/turnstile.js";
import { __resetAllRateLimitsForTests } from "../src/auth/rateLimit.js";

const AUTH_ENV_KEYS = ["AUTH_TOKEN_ENCRYPTION_KEY", "TURNSTILE_SECRET_KEY"] as const;

/** Extracts the session cookie's value from a `set-cookie` response header, for reuse in the next request. */
function extractSessionCookie(setCookieHeader: string | string[] | undefined): string | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const match = h.match(/ce_session=([^;]+)/);
    if (match) return `ce_session=${match[1]}`;
  }
  return null;
}

describe("password hashing", () => {
  it("hashes a password and verifies it correctly", () => {
    const hash = hashPassword("correct horse battery staple");
    expect(hash).toContain(":");
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true);
    expect(verifyPassword("wrong password", hash)).toBe(false);
  });

  it("never stores the plaintext password in the hash output", () => {
    const hash = hashPassword("my-secret-password-123");
    expect(hash).not.toContain("my-secret-password-123");
  });

  it("produces a different hash for the same password each time (random salt)", () => {
    const hash1 = hashPassword("same-password");
    const hash2 = hashPassword("same-password");
    expect(hash1).not.toBe(hash2);
    expect(verifyPassword("same-password", hash1)).toBe(true);
    expect(verifyPassword("same-password", hash2)).toBe(true);
  });
});

describe("token encryption", () => {
  const originalKey = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  beforeEach(() => {
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = "test-encryption-key-not-for-real-use";
  });
  afterEach(() => {
    if (originalKey === undefined) delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    else process.env.AUTH_TOKEN_ENCRYPTION_KEY = originalKey;
  });

  it("encrypts and decrypts a real round trip", () => {
    const encrypted = encryptToken("gho_realGitHubTokenLookingString123");
    expect(encrypted).not.toContain("gho_realGitHubTokenLookingString123");
    expect(decryptToken(encrypted)).toBe("gho_realGitHubTokenLookingString123");
  });

  it("throws when AUTH_TOKEN_ENCRYPTION_KEY is not set, rather than silently using a fallback key", () => {
    delete process.env.AUTH_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken("anything")).toThrow(/AUTH_TOKEN_ENCRYPTION_KEY/);
  });
});

describe("Turnstile verification", () => {
  const originalKey = process.env.TURNSTILE_SECRET_KEY;
  afterEach(() => {
    if (originalKey === undefined) delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = originalKey;
  });

  it("is a no-op success when TURNSTILE_SECRET_KEY is not configured", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const result = await verifyTurnstile(undefined);
    expect(result.success).toBe(true);
  });
});

describe("auth API", () => {
  let tmpDbDir: string;
  let db: DB;
  let app: FastifyInstance;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(AUTH_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of AUTH_ENV_KEYS) delete process.env[k];

    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-auth-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db });
    // The login/register rate limiter (auth/rateLimit.ts) is a
    // module-level in-memory counter keyed by IP — every `app.inject()`
    // call in this file shares the same simulated IP, so without a reset
    // between tests, this describe block's own many real login/register
    // calls would trip the limiter partway through the suite.
    __resetAllRateLimitsForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    app.close();
    // Close the real sqlite handle before removing its file — on Windows
    // (unlike POSIX) an open native file handle blocks unlink/rmdir with
    // EBUSY, so skipping this makes cleanup flaky/failing there even
    // though app.close() alone is enough on Linux/macOS.
    db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  });

  it("reports authRequired: false and no login wall when zero accounts exist (open/legacy mode)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ authRequired: false, user: null });

    // Every other route still works with no session at all — the whole point of open mode.
    const projectsRes = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(projectsRes.statusCode).toBe(200);
  });

  it("rejects registration with a short password or an invalid email", async () => {
    const shortPwRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "a@b.com", password: "short" },
    });
    expect(shortPwRes.statusCode).toBe(400);

    const badEmailRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "not-an-email", password: "longenoughpassword" },
    });
    expect(badEmailRes.statusCode).toBe(400);
  });

  it("registers, switches the instance into auth-required mode, and issues a working session cookie", async () => {
    const registerRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "Alice@Example.com", password: "a-real-password-123", displayName: "Alice" },
    });
    expect(registerRes.statusCode).toBe(201);
    expect(registerRes.json().user.email).toBe("alice@example.com"); // normalized to lowercase
    expect(registerRes.json().user).not.toHaveProperty("password_hash");

    const cookie = extractSessionCookie(registerRes.headers["set-cookie"]);
    expect(cookie).toBeTruthy();

    // Now that an account exists, every other route requires a session.
    const unauthedRes = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(unauthedRes.statusCode).toBe(401);

    // ...but with the session cookie, it works.
    const authedRes = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: cookie! },
    });
    expect(authedRes.statusCode).toBe(200);

    // /me now reports the logged-in user.
    const meRes = await app.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookie! } });
    expect(meRes.json()).toEqual({
      authRequired: true,
      user: {
        id: expect.any(String),
        email: "alice@example.com",
        displayName: "Alice",
        createdAt: expect.any(String),
        githubConnected: false,
        driveConnected: false,
      },
    });
  });

  it("refuses to register the same email twice", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "dup@example.com", password: "a-real-password-123" },
    });
    const secondRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "dup@example.com", password: "another-password-456" },
    });
    expect(secondRes.statusCode).toBe(409);
  });

  it("logs in with correct credentials and rejects incorrect ones with an identical error message", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "bob@example.com", password: "correct-password-123" },
    });

    const wrongPasswordRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "bob@example.com", password: "wrong-password" },
    });
    expect(wrongPasswordRes.statusCode).toBe(401);

    const unknownEmailRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.com", password: "whatever" },
    });
    expect(unknownEmailRes.statusCode).toBe(401);
    // Same message either way — doesn't leak which emails are registered.
    expect(unknownEmailRes.json().error).toBe(wrongPasswordRes.json().error);

    const correctRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "bob@example.com", password: "correct-password-123" },
    });
    expect(correctRes.statusCode).toBe(200);
    expect(extractSessionCookie(correctRes.headers["set-cookie"])).toBeTruthy();
  });

  it("logs out and invalidates the session cookie for subsequent requests", async () => {
    const registerRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "carol@example.com", password: "a-real-password-123" },
    });
    const cookie = extractSessionCookie(registerRes.headers["set-cookie"])!;

    const logoutRes = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie } });
    expect(logoutRes.statusCode).toBe(200);

    const afterLogoutRes = await app.inject({ method: "GET", url: "/api/v1/projects", headers: { cookie } });
    expect(afterLogoutRes.statusCode).toBe(401);
  });

  it("rejects register/login when Turnstile is configured and the token is missing", async () => {
    process.env.TURNSTILE_SECRET_KEY = "fake-secret-for-test";

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "dana@example.com", password: "a-real-password-123" }, // no turnstileToken
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Bot verification failed/);
  });

  it("keeps the session cookie non-secure over plain http (default, no proxy)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "frank@example.com", password: "a-real-password-123" },
    });
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it("marks the session cookie Secure when trustProxy is on and the proxy reports https", async () => {
    const proxiedApp = buildApp({ db, trustProxy: true });
    try {
      const res = await proxiedApp.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { email: "grace@example.com", password: "a-real-password-123" },
        headers: { "x-forwarded-proto": "https" },
      });
      const setCookie = String(res.headers["set-cookie"]);
      expect(setCookie).toMatch(/Secure/i);
    } finally {
      await proxiedApp.close();
    }
  });

  it("does NOT trust X-Forwarded-Proto when trustProxy is off (default) — cookie stays non-secure", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "henry@example.com", password: "a-real-password-123" },
      headers: { "x-forwarded-proto": "https" }, // untrusted client-supplied header
    });
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it("still lets the auth routes themselves and the health check through once auth is required", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "eve@example.com", password: "a-real-password-123" },
    });

    const healthRes = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(healthRes.statusCode).toBe(200);

    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "eve@example.com", password: "a-real-password-123" },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it("reports which OAuth providers are configured, with no secrets leaked", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/auth/providers" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ google: false, github: false });
    expect(JSON.stringify(res.json())).not.toMatch(/secret|client/i);
  });

  it("rate-limits repeated failed login attempts from the same caller (brute-force protection)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "throttled@example.com", password: "the-real-password-123" },
    });

    // The limiter allows 10 attempts per window — exhaust it with wrong
    // passwords, each a real request through the real route.
    let lastRes;
    for (let i = 0; i < 10; i++) {
      lastRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "throttled@example.com", password: "wrong-password" },
      });
      expect(lastRes.statusCode).toBe(401);
    }

    // The 11th attempt — even with the CORRECT password — is throttled,
    // not authenticated: the limiter counts attempts, not failures.
    const throttledRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "throttled@example.com", password: "the-real-password-123" },
    });
    expect(throttledRes.statusCode).toBe(429);
    expect(throttledRes.headers["retry-after"]).toBeTruthy();
  });

  it("rate-limits repeated registration attempts from the same caller", async () => {
    let lastRes;
    for (let i = 0; i < 10; i++) {
      lastRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/register",
        payload: { email: `flood-${i}@example.com`, password: "a-real-password-123" },
      });
      expect(lastRes.statusCode).toBe(201);
    }

    const throttledRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "flood-11@example.com", password: "a-real-password-123" },
    });
    expect(throttledRes.statusCode).toBe(429);
  });

  it("clears the login rate limit on a genuine successful login, so a real user isn't punished afterward", async () => {
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "recovers@example.com", password: "a-real-password-123" },
    });

    // A few mistyped attempts, well under the limit...
    for (let i = 0; i < 3; i++) {
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "recovers@example.com", password: "wrong-password" },
      });
    }

    // ...then a real successful login...
    const successRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "recovers@example.com", password: "a-real-password-123" },
    });
    expect(successRes.statusCode).toBe(200);

    // ...and the counter is back to zero, so this user has their full 10
    // attempts available again rather than being left at "7 remaining".
    for (let i = 0; i < 10; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: "recovers@example.com", password: "wrong-password" },
      });
      expect(res.statusCode).toBe(401); // not 429 — the window is fresh
    }
  });
});
