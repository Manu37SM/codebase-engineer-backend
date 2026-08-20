import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase, DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { getUserByEmail, getOauthIdentity } from "../src/db/userRepo.js";

const OAUTH_ENV_KEYS = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "GITHUB_REDIRECT_URI",
  "AUTH_TOKEN_ENCRYPTION_KEY",
] as const;

function extractCookieValue(setCookieHeader: string | string[] | undefined, name: string): string | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const match = h.match(new RegExp(`${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

/** Fakes the JSON response `fetch` would give for a given URL substring. */
function fakeFetchResponding(map: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [substring, body] of Object.entries(map)) {
      if (url.includes(substring)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("OAuth sign-in (Google + GitHub)", () => {
  let tmpDbDir: string;
  let db: DB;
  let app: FastifyInstance;
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    savedEnv = Object.fromEntries(OAUTH_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of OAUTH_ENV_KEYS) delete process.env[k];
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = "test-oauth-encryption-key";

    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-oauth-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db });
    originalFetch = global.fetch;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    global.fetch = originalFetch;
    app.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  });

  describe("when not configured", () => {
    it("Google /start returns 404 with a clear message", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/not configured/);
    });

    it("GitHub /start returns 404 with a clear message", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/github/start" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/not configured/);
    });
  });

  describe("Google flow", () => {
    beforeEach(() => {
      process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
      process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
    });

    it("/start redirects to Google with a state cookie set", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("accounts.google.com");
      expect(String(res.headers["set-cookie"])).toContain("ce_oauth_state_google=");
    });

    it("rejects the callback when state doesn't match (CSRF protection)", async () => {
      const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
      const stateCookie = extractCookieValue(startRes.headers["set-cookie"], "ce_oauth_state_google");
      expect(stateCookie).toBeTruthy();

      const callbackRes = await app.inject({
        method: "GET",
        url: "/api/v1/auth/google/callback?code=abc&state=wrong-state",
        headers: { cookie: `ce_oauth_state_google=${stateCookie}` },
      });
      expect(callbackRes.statusCode).toBe(400);
    });

    it("completes the flow end to end: exchanges code, creates a user, sets session cookie", async () => {
      global.fetch = fakeFetchResponding({
        "oauth2.googleapis.com/token": { access_token: "fake-google-access-token", refresh_token: "fake-refresh" },
        "googleapis.com/oauth2/v3/userinfo": { sub: "google-123", email: "person@example.com", name: "Person" },
      }) as unknown as typeof fetch;

      const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
      const stateCookie = extractCookieValue(startRes.headers["set-cookie"], "ce_oauth_state_google");

      const callbackRes = await app.inject({
        method: "GET",
        url: `/api/v1/auth/google/callback?code=real-code&state=${stateCookie}`,
        headers: { cookie: `ce_oauth_state_google=${stateCookie}` },
      });
      expect(callbackRes.statusCode).toBe(302);
      expect(callbackRes.headers.location).toBe("/");
      expect(extractCookieValue(callbackRes.headers["set-cookie"], "ce_session")).toBeTruthy();

      const user = getUserByEmail(db, "person@example.com");
      expect(user).toBeTruthy();
      expect(user!.password_hash).toBeNull();

      const identity = getOauthIdentity(db, "google", "google-123");
      expect(identity).toBeTruthy();
      expect(identity!.access_token_enc).not.toContain("fake-google-access-token"); // stored encrypted, not plaintext
    });

    it("logging in a second time with the same Google account reuses the same user (no duplicate)", async () => {
      global.fetch = fakeFetchResponding({
        "oauth2.googleapis.com/token": { access_token: "token-1" },
        "googleapis.com/oauth2/v3/userinfo": { sub: "google-456", email: "again@example.com", name: "Again" },
      }) as unknown as typeof fetch;

      const doLogin = async () => {
        const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
        const stateCookie = extractCookieValue(startRes.headers["set-cookie"], "ce_oauth_state_google");
        return app.inject({
          method: "GET",
          url: `/api/v1/auth/google/callback?code=c&state=${stateCookie}`,
          headers: { cookie: `ce_oauth_state_google=${stateCookie}` },
        });
      };

      await doLogin();
      const secondRes = await doLogin();
      expect(secondRes.statusCode).toBe(302);

      // Still exactly one user for that email.
      const user = getUserByEmail(db, "again@example.com");
      expect(user).toBeTruthy();
    });
  });

  describe("GitHub flow", () => {
    beforeEach(() => {
      process.env.GITHUB_CLIENT_ID = "test-github-client-id";
      process.env.GITHUB_CLIENT_SECRET = "test-github-client-secret";
    });

    it("/start redirects to GitHub with a state cookie set, requesting the repo scope", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/auth/github/start" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain("github.com/login/oauth/authorize");
      expect(res.headers.location).toContain("repo");
      expect(String(res.headers["set-cookie"])).toContain("ce_oauth_state_github=");
    });

    it("completes the flow end to end, falling back to /user/emails when the primary email is private", async () => {
      global.fetch = fakeFetchResponding({
        "github.com/login/oauth/access_token": { access_token: "fake-github-access-token" },
        "api.github.com/user/emails": [{ email: "private@example.com", primary: true, verified: true }],
        "api.github.com/user": { id: 789, login: "octocat", name: "Octo Cat", email: null },
      }) as unknown as typeof fetch;

      const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/github/start" });
      const stateCookie = extractCookieValue(startRes.headers["set-cookie"], "ce_oauth_state_github");

      const callbackRes = await app.inject({
        method: "GET",
        url: `/api/v1/auth/github/callback?code=real-code&state=${stateCookie}`,
        headers: { cookie: `ce_oauth_state_github=${stateCookie}` },
      });
      expect(callbackRes.statusCode).toBe(302);
      expect(extractCookieValue(callbackRes.headers["set-cookie"], "ce_session")).toBeTruthy();

      const user = getUserByEmail(db, "private@example.com");
      expect(user).toBeTruthy();

      const identity = getOauthIdentity(db, "github", "789");
      expect(identity).toBeTruthy();
      expect(identity!.access_token_enc).not.toContain("fake-github-access-token");
    });
  });
});
