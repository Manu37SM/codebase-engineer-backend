import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { openDatabase, DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { __resetAllRateLimitsForTests } from "../src/auth/rateLimit.js";

// Regression coverage for a real audit finding: before migration 018,
// `project` had no owner column and no route checked one — once a second
// account existed on a shared instance, any authenticated user could read,
// modify, or trigger AI-Mode disk writes/executions against any other
// user's project by guessing/enumerating its id. Fixed via
// `getProjectForOwner`/scoped `listProjects` (`db/projectRepo.ts`), used at
// every `:id`-taking route in `routes/projects.ts` (and the GitHub/Google
// Drive import routes' `createProject` calls).

const AUTH_ENV_KEYS = ["AUTH_TOKEN_ENCRYPTION_KEY", "TURNSTILE_SECRET_KEY"] as const;

function extractSessionCookie(setCookieHeader: string | string[] | undefined): string {
  const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const h of headers) {
    const match = h?.match(/ce_session=([^;]+)/);
    if (match) return `ce_session=${match[1]}`;
  }
  throw new Error("no session cookie in response");
}

describe("project ownership isolation (migration 018)", () => {
  let tmpDbDir: string;
  let tmpRepoDir: string;
  let db: DB;
  let app: FastifyInstance;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(AUTH_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of AUTH_ENV_KEYS) delete process.env[k];

    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-ownership-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db });
    tmpRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-ownership-repo-"));
    __resetAllRateLimitsForTests();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    app.close();
    db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    fs.rmSync(tmpRepoDir, { recursive: true, force: true });
  });

  async function registerUser(email: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password: "correct horse battery staple" },
    });
    expect(res.statusCode).toBe(201);
    return extractSessionCookie(res.headers["set-cookie"]);
  }

  it("does not let one account read another account's project", async () => {
    const aliceCookie = await registerUser("alice@example.com");

    const aliceProjectRoot = fs.mkdtempSync(path.join(tmpRepoDir, "alice-"));
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie: aliceCookie },
      payload: { name: "alice-project", rootPath: aliceProjectRoot },
    });
    expect(createRes.statusCode).toBe(201);
    const projectId = createRes.json().project.id;

    const bobCookie = await registerUser("bob@example.com");

    const bobReadRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie: bobCookie },
    });
    expect(bobReadRes.statusCode).toBe(404);

    const bobFindingsRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/findings`,
      headers: { cookie: bobCookie },
    });
    expect(bobFindingsRes.statusCode).toBe(404);

    const aliceReadRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie: aliceCookie },
    });
    expect(aliceReadRes.statusCode).toBe(200);
  });

  it("does not let one account delete or reconfigure another account's project", async () => {
    const aliceCookie = await registerUser("alice2@example.com");
    const aliceProjectRoot = fs.mkdtempSync(path.join(tmpRepoDir, "alice2-"));
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie: aliceCookie },
      payload: { name: "alice-project-2", rootPath: aliceProjectRoot },
    });
    const projectId = createRes.json().project.id;

    const bobCookie = await registerUser("bob2@example.com");

    const bobDeleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie: bobCookie },
    });
    expect(bobDeleteRes.statusCode).toBe(404);

    const bobSettingsRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/projects/${projectId}/settings`,
      headers: { cookie: bobCookie },
      payload: { applyMode: "direct" },
    });
    expect(bobSettingsRes.statusCode).toBe(404);

    // Alice's project is still there, untouched.
    const stillThereRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}`,
      headers: { cookie: aliceCookie },
    });
    expect(stillThereRes.statusCode).toBe(200);
  });

  it("excludes another account's projects from the project list", async () => {
    const aliceCookie = await registerUser("alice3@example.com");
    const aliceProjectRoot = fs.mkdtempSync(path.join(tmpRepoDir, "alice3-"));
    await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie: aliceCookie },
      payload: { name: "alice-project-3", rootPath: aliceProjectRoot },
    });

    const bobCookie = await registerUser("bob3@example.com");
    const bobProjectRoot = fs.mkdtempSync(path.join(tmpRepoDir, "bob3-"));
    await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { cookie: bobCookie },
      payload: { name: "bob-project-3", rootPath: bobProjectRoot },
    });

    const bobListRes = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: bobCookie },
    });
    const bobProjects = bobListRes.json().projects as Array<{ name: string }>;
    expect(bobProjects.map((p) => p.name)).toEqual(["bob-project-3"]);

    const aliceListRes = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { cookie: aliceCookie },
    });
    const aliceProjects = aliceListRes.json().projects as Array<{ name: string }>;
    expect(aliceProjects.map((p) => p.name)).toEqual(["alice-project-3"]);
  });

  it("still allows unrestricted access in single-user/legacy mode (no accounts registered)", async () => {
    const projectRoot = fs.mkdtempSync(path.join(tmpRepoDir, "legacy-"));
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "legacy-project", rootPath: projectRoot },
    });
    expect(createRes.statusCode).toBe(201);
    const projectId = createRes.json().project.id;

    const readRes = await app.inject({ method: "GET", url: `/api/v1/projects/${projectId}` });
    expect(readRes.statusCode).toBe(200);

    const listRes = await app.inject({ method: "GET", url: "/api/v1/projects" });
    expect(listRes.json().projects.map((p: { id: string }) => p.id)).toContain(projectId);
  });
});
