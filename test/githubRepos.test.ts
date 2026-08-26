import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase, DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";

vi.mock("../src/importer/githubClone.js", async () => {
  const actual = await vi.importActual<typeof import("../src/importer/githubClone.js")>(
    "../src/importer/githubClone.js"
  );
  return { ...actual, cloneWithToken: vi.fn() };
});

import { cloneWithToken } from "../src/importer/githubClone.js";

const mockedCloneWithToken = cloneWithToken as unknown as ReturnType<typeof vi.fn>;

function extractCookieValue(setCookieHeader: string | string[] | undefined, name: string): string | null {
  if (!setCookieHeader) return null;
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const match = h.match(new RegExp(`${name}=([^;]+)`));
    if (match) return match[1];
  }
  return null;
}

function fakeFetchResponding(map: Record<string, unknown>, headers: Record<string, string> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [substring, body] of Object.entries(map)) {
      if (url.includes(substring)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json", ...headers },
        });
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

describe("GitHub repo browser + clone-to-register (Task #84)", () => {
  let tmpDbDir: string;
  let dataDir: string;
  let db: DB;
  let app: FastifyInstance;
  let savedEnv: Record<string, string | undefined>;
  let originalFetch: typeof fetch;
  const ENV_KEYS = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GITHUB_REDIRECT_URI", "AUTH_TOKEN_ENCRYPTION_KEY"] as const;

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    process.env.GITHUB_CLIENT_ID = "test-github-client-id";
    process.env.GITHUB_CLIENT_SECRET = "test-github-client-secret";
    process.env.AUTH_TOKEN_ENCRYPTION_KEY = "test-github-repos-encryption-key";

    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-github-repos-test-"));
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-github-repos-data-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db, dataDir });
    originalFetch = global.fetch;
    mockedCloneWithToken.mockReset();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    global.fetch = originalFetch;
    app.close();

    db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function signInWithGitHub(): Promise<string> {
    global.fetch = fakeFetchResponding({
      "github.com/login/oauth/access_token": { access_token: "fake-github-access-token" },
      "api.github.com/user": { id: 42, login: "octocat", name: "Octo Cat", email: "octo@example.com" },
    }) as unknown as typeof fetch;

    const startRes = await app.inject({ method: "GET", url: "/api/v1/auth/github/start" });
    const stateCookie = extractCookieValue(startRes.headers["set-cookie"], "ce_oauth_state_github");
    const callbackRes = await app.inject({
      method: "GET",
      url: `/api/v1/auth/github/callback?code=real-code&state=${stateCookie}`,
      headers: { cookie: `ce_oauth_state_github=${stateCookie}` },
    });
    return extractCookieValue(callbackRes.headers["set-cookie"], "ce_session")!;
  }

  it("401s GET /github/repos with no session at all", async () => {

    await signInWithGitHub(); 
    const res = await app.inject({ method: "GET", url: "/api/v1/github/repos" });
    expect(res.statusCode).toBe(401);
  });

  it("400s GET /github/repos for a signed-in user who never connected GitHub", async () => {

    const registerRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "local@example.com", password: "password123" },
    });
    const cookie = `ce_session=${extractCookieValue(registerRes.headers["set-cookie"], "ce_session")}`;

    const res = await app.inject({ method: "GET", url: "/api/v1/github/repos", headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not connected/i);
  });

  it("lists the signed-in user's real repos via the stored token", async () => {
    const sessionToken = await signInWithGitHub();
    const cookie = `ce_session=${sessionToken}`;

    global.fetch = fakeFetchResponding({
      "api.github.com/user/repos": [
        {
          id: 1,
          name: "my-app",
          full_name: "octocat/my-app",
          private: false,
          html_url: "https://github.com/octocat/my-app",
          description: "An app",
          default_branch: "main",
          updated_at: "2024-01-01T00:00:00Z",
          fork: false,
        },
        {
          id: 2,
          name: "secret-project",
          full_name: "octocat/secret-project",
          private: true,
          html_url: "https://github.com/octocat/secret-project",
          description: null,
          default_branch: "main",
          updated_at: "2024-02-01T00:00:00Z",
          fork: false,
        },
      ],
    }) as unknown as typeof fetch;

    const res = await app.inject({ method: "GET", url: "/api/v1/github/repos", headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.repos).toHaveLength(2);
    expect(body.repos.map((r: { fullName: string }) => r.fullName)).toEqual(["octocat/my-app", "octocat/secret-project"]);
    expect(body.repos[1].private).toBe(true);
    expect(body.truncated).toBe(false);
  });

  it("400s POST /github/import with a missing or invalid fullName", async () => {
    const sessionToken = await signInWithGitHub();
    const cookie = `ce_session=${sessionToken}`;

    const missing = await app.inject({ method: "POST", url: "/api/v1/github/import", headers: { cookie }, payload: {} });
    expect(missing.statusCode).toBe(400);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/v1/github/import",
      headers: { cookie },
      payload: { fullName: "not-a-valid-full-name" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toMatch(/owner\/repo/i);
    expect(mockedCloneWithToken).not.toHaveBeenCalled();
  });

  it("clones (via the stored token) and registers a picked repo", async () => {
    const sessionToken = await signInWithGitHub();
    const cookie = `ce_session=${sessionToken}`;

    mockedCloneWithToken.mockImplementation((_url: string, destDir: string) => {
      fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(path.join(destDir, "README.md"), "# my-app\n");
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/github/import",
      headers: { cookie },
      payload: { fullName: "octocat/my-app" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.project.name).toBe("my-app");
    expect(fs.existsSync(path.join(body.project.root_path ?? body.project.rootPath, "README.md"))).toBe(true);

    expect(mockedCloneWithToken).toHaveBeenCalledWith(
      "https://github.com/octocat/my-app.git",
      expect.any(String),
      "fake-github-access-token"
    );
  });
});
