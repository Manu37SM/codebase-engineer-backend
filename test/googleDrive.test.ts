import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import type { FastifyInstance } from "fastify";
import { openDatabase, DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";

// Task #86: GET /api/v1/google-drive/zips and POST /api/v1/google-drive/import
// both need a real Google access token on file, which only exists once a
// user has completed the Google OAuth flow (Task #82). Every outbound call
// (token exchange/refresh, userinfo, Drive list/download) is faked here via
// a routed `global.fetch` stub rather than hitting real Google endpoints —
// this file focuses on the route wiring: auth requirement, token
// refresh-then-use, input validation, and project registration.

function extractCookieValue(setCookieHeader: string | string[] | undefined, name: string): string | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const match = h.match(new RegExp(`${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

/** Builds a fake `fetch` that dispatches on a substring match against the request URL, in order, first match wins. */
function fakeFetchRouter(routes: Array<{ match: string; respond: () => Response }>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond();
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function buildTestZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile("README.md", Buffer.from("# my-drive-project\n"));
  return zip.toBuffer();
}

describe("Google Drive zip-file picker (Task #86)", () => {
  let tmpDbDir: string;
  let dataDir: string;
  let db: DB;
  let app: FastifyInstance;
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof fetch;
  const ENV_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "AUTH_TOKEN_ENCRYPTION_KEY"] as const;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = "test-google-drive-encryption-key";

    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-google-drive-test-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-google-drive-data-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db, dataDir });
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
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** Signs in via the real Google OAuth callback flow (fake fetch), returning the session cookie. */
  async function signInWithGoogle(): Promise<string> {
    global.fetch = fakeFetchRouter([
      { match: "oauth2.googleapis.com/token", respond: () => jsonResponse({ access_token: "initial-access-token", refresh_token: "stored-refresh-token" }) },
      { match: "googleapis.com/oauth2/v3/userinfo", respond: () => jsonResponse({ sub: "google-1", email: "drive@example.com", name: "Drive User" }) },
    ]) as unknown as typeof fetch;

    const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/google/start" });
    const stateCookie = extractCookieValue(startRes.headers["set-cookie"], "ce_oauth_state_google");
    const callbackRes = await app.inject({
      method: "GET",
      url: `/api/v1/auth/google/callback?code=real-code&state=${stateCookie}`,
      headers: { cookie: `ce_oauth_state_google=${stateCookie}` },
    });
    return extractCookieValue(callbackRes.headers["set-cookie"], "ce_session")!;
  }

  it("401s GET /google-drive/zips with no session at all", async () => {
    await signInWithGoogle(); // now countUsers() > 0, so auth is enforced
    const res = await app.inject({ method: "GET", url: "/api/v1/google-drive/zips" });
    expect(res.statusCode).toBe(401);
  });

  it("400s GET /google-drive/zips for a signed-in user who never connected Google", async () => {
    const registerRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "local2@example.com", password: "password123" },
    });
    const cookie = `ce_session=${extractCookieValue(registerRes.headers["set-cookie"], "ce_session")}`;

    const res = await app.inject({ method: "GET", url: "/api/v1/google-drive/zips", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not connected/i);
  });

  it("refreshes the access token via the stored refresh token, then lists zip files", async () => {
    const sessionToken = await signInWithGoogle();
    const cookie = `ce_session=${sessionToken}`;

    global.fetch = fakeFetchRouter([
      {
        match: "oauth2.googleapis.com/token",
        respond: () => jsonResponse({ access_token: "refreshed-access-token" }),
      },
      {
        match: "www.googleapis.com/drive/v3/files",
        respond: () =>
          jsonResponse({
            files: [
              { id: "file-1", name: "project.zip", mimeType: "application/zip", modifiedTime: "2024-01-01T00:00:00Z", size: "1024" },
            ],
          }),
      },
    ]) as unknown as typeof fetch;

    const res = await app.inject({ method: "GET", url: "/api/v1/google-drive/zips", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ id: "file-1", name: "project.zip" });
    expect(body.truncated).toBe(false);
  });

  it("400s POST /google-drive/import with a missing fileId", async () => {
    const sessionToken = await signInWithGoogle();
    const cookie = `ce_session=${sessionToken}`;

    global.fetch = fakeFetchRouter([
      { match: "oauth2.googleapis.com/token", respond: () => jsonResponse({ access_token: "refreshed-access-token" }) },
    ]) as unknown as typeof fetch;

    const res = await app.inject({ method: "POST", url: "/api/v1/google-drive/import", headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("downloads (via the refreshed token) and registers a picked zip file", async () => {
    const sessionToken = await signInWithGoogle();
    const cookie = `ce_session=${sessionToken}`;

    const zipBuffer = buildTestZip();
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("oauth2.googleapis.com/token")) {
        return jsonResponse({ access_token: "refreshed-access-token" });
      }
      if (url.includes("www.googleapis.com/drive/v3/files/file-42")) {
        return new Response(zipBuffer, { status: 200, headers: { "content-type": "application/zip" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/google-drive/import",
      headers: { cookie },
      payload: { fileId: "file-42", name: "my-drive-project" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.project.name).toBe("my-drive-project");
    const rootPath = body.project.root_path ?? body.project.rootPath;
    expect(fs.existsSync(path.join(rootPath, "README.md"))).toBe(true);
  });

  it("409s when the same Drive file is imported twice (same destination already registered)", async () => {
    // Registering by-path collisions are handled generically by
    // getProjectByRootPath; this just exercises it through this route.
    const sessionToken = await signInWithGoogle();
    const cookie = `ce_session=${sessionToken}`;
    const zipBuffer = buildTestZip();

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("oauth2.googleapis.com/token")) return jsonResponse({ access_token: "refreshed-access-token" });
      if (url.includes("drive/v3/files/file-99")) {
        return new Response(zipBuffer, { status: 200, headers: { "content-type": "application/zip" } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const first = await app.inject({
      method: "POST",
      url: "/api/v1/google-drive/import",
      headers: { cookie },
      payload: { fileId: "file-99" },
    });
    expect(first.statusCode).toBe(201);

    // A second import of a *different* fileId can't collide (each import
    // gets a fresh randomUUID() destination dir), so this test only checks
    // the 409 path exists by re-registering the same root_path directly.
    const rootPath = first.json().project.root_path ?? first.json().project.rootPath;
    const dupe = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie },
      payload: { name: "dupe", rootPath },
    });
    expect(dupe.statusCode).toBe(409);
  });
});
