import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { openDatabase, DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { makeTempRepo, writeFile, cleanupRepo, initGit, gitCommitAll } from "./fixtures.js";

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("projects API", () => {
  let tmpDbDir: string;
  let db: DB;
  let app: FastifyInstance;
  let repoRoot: string;

  beforeEach(() => {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-api-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db });
    repoRoot = makeTempRepo();
    writeFile(repoRoot, "package.json", JSON.stringify({ name: "fixture", dependencies: { vite: "^5.0.0" } }));
    writeFile(repoRoot, "src/main.ts", "console.log('hi');\n");
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    cleanupRepo(repoRoot);
  });

  it("rejects registering a project with a non-existent root path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "bad", rootPath: "/definitely/not/a/real/path" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects registering a project with a relative root path (traversal-adjacent)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "bad", rootPath: "../../etc" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("registers a project, then discovers it end to end", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "fixture-project", rootPath: repoRoot },
    });
    expect(createRes.statusCode).toBe(201);
    const { project } = createRes.json();
    expect(project.id).toBeTruthy();
    expect(project.root_path).toBe(repoRoot);

    const discoverRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/discover`,
    });
    expect(discoverRes.statusCode).toBe(200);
    const { result, snapshot } = discoverRes.json();
    expect(result.buildSystems).toContain("npm");
    expect(result.frameworks).toContain("Vite");
    expect(snapshot.project_id).toBe(project.id);

    const getRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}` });
    expect(getRes.statusCode).toBe(200);
    const getBody = getRes.json();
    expect(getBody.latestSnapshot.id).toBe(snapshot.id);
  });

  it("returns 404 discovering an unknown project id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/discover",
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects registering the same root path twice", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "one", rootPath: repoRoot },
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "two", rootPath: repoRoot },
    });
    expect(second.statusCode).toBe(409);
  });

  it("indexes a project, lists files, and reindex reflects deletions", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "fixture-project", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const indexRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/index`,
    });
    expect(indexRes.statusCode).toBe(200);
    const indexBody = indexRes.json();
    expect(indexBody.totalFiles).toBe(2); // package.json + src/main.ts

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/files`,
    });
    expect(listRes.statusCode).toBe(200);
    const listBody = listRes.json();
    expect(listBody.total).toBe(2);
    const mainFile = listBody.files.find((f: { relative_path: string }) => f.relative_path === "src/main.ts");
    expect(mainFile).toBeTruthy();
    expect(mainFile.language).toBe("TypeScript");

    // Remove a file on disk and reindex — the stale row must be gone, not accumulated.
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.rmSync(path.join(repoRoot, "src/main.ts"));

    const reindexRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/index`,
    });
    expect(reindexRes.json().totalFiles).toBe(1);

    const listAfter = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/files`,
    });
    expect(listAfter.json().total).toBe(1);
  });

  it("filters file listing by language", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "fixture-project", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/files?language=TypeScript`,
    });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.files[0].relative_path).toBe("src/main.ts");
  });

  it("returns an empty architecture view before the project has ever been indexed", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "fixture-project", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/architecture`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.empty).toBe(true);
    expect(body.nodes).toEqual([]);
  });

  it("returns an aggregated architecture view after indexing, honoring the depth param", async () => {
    writeFile(repoRoot, "src/lib/util.ts", "export const util = 1;\n");
    writeFile(repoRoot, "src/main.ts", "import { util } from './lib/util';\nconsole.log(util);\n");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "fixture-project", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });

    const depth2 = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/architecture?depth=2`,
    });
    const body2 = depth2.json();
    expect(body2.empty).toBe(false);
    expect(body2.edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: "src", to: "src/lib", weight: 1 })])
    );

    const depth1 = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/architecture?depth=1`,
    });
    const body1 = depth1.json();
    // At depth 1, main.ts and lib/util.ts both collapse into module "src" —
    // the edge between them becomes intra-module and must disappear.
    // (root) also appears because the fixture's package.json lives at the
    // repo root, outside any directory.
    expect(body1.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["(root)", "src"]);
    expect(body1.edges).toEqual([]);
  });

  it("rejects a non-positive depth", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "fixture-project", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/architecture?depth=0`,
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs analysis, persists findings, and lists them severity-sorted with a rerun replacing stale ones", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\n`);
    writeFile(repoRoot, "src/small.ts", "export const a = 1;\n");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "fixture-project", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const analysisRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/analysis`,
    });
    expect(analysisRes.statusCode).toBe(200);
    expect(analysisRes.json().findingsCount).toBeGreaterThan(0);

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings`,
    });
    const listBody = listRes.json();
    expect(listBody.total).toBeGreaterThan(0);
    expect(listBody.findings[0].severity).toBe("high"); // secret finding sorts first (highest severity present)
    expect(listBody.latestRun.status).toBe("completed");

    // Remove the offending file and rerun — the stale finding must be gone.
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.rmSync(path.join(repoRoot, "src/config.ts"));

    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });
    const listAfter = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings?severity=critical`,
    });
    expect(listAfter.json().total).toBe(0);
  });

  it("returns 404 for findings/analysis on an unknown project", async () => {
    const analysisRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/analysis",
    });
    expect(analysisRes.statusCode).toBe(404);

    const findingsRes = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/findings",
    });
    expect(findingsRes.statusCode).toBe(404);
  });

  it("returns branch, commits, and uncommitted changes for a registered git repo", async () => {
    initGit(repoRoot);
    gitCommitAll(repoRoot, "initial commit");
    writeFile(repoRoot, "src/main.ts", "console.log('changed');\n");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "git-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/git`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isGitRepository).toBe(true);
    expect(body.recentCommits).toHaveLength(1);
    expect(body.recentCommits[0].message).toBe("initial commit");
    expect(body.uncommittedChanges.filesChanged).toBe(1);
  });

  it("returns a non-git result for a project whose root has no .git directory", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "no-git-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/git`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isGitRepository).toBe(false);
  });

  it("rejects an invalid commitLimit and returns 404 for an unknown project", async () => {
    initGit(repoRoot);
    gitCommitAll(repoRoot, "initial commit");
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "git-fixture-2", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const badRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/git?commitLimit=0`,
    });
    expect(badRes.statusCode).toBe(400);

    const notFoundRes = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/git",
    });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it("runs tests, persists the run, and can fetch it and the run history", async () => {
    writeFile(
      repoRoot,
      "package.json",
      JSON.stringify({ scripts: { test: "node -e \"console.log('ok')\"" } })
    );

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "test-runner-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const runRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tests/run`,
    });
    expect(runRes.statusCode).toBe(200);
    const runBody = runRes.json();
    expect(runBody.supported).toBe(true);
    expect(runBody.run.status).toBe("passed");
    expect(runBody.run.exit_code).toBe(0);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tests/${runBody.run.id}`,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().run.stdout_ref).toContain("ok");

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tests`,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().runs).toHaveLength(1);
  });

  it("reports supported:false and persists a reason for an unsupported project", async () => {
    // repoRoot's default package.json (from beforeEach) has no test script.
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "unsupported-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const runRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/tests/run`,
    });
    expect(runRes.statusCode).toBe(200);
    const runBody = runRes.json();
    expect(runBody.supported).toBe(false);
    expect(runBody.run.status).toBe("unsupported");
    expect(runBody.run.reason).toMatch(/No test script/);
  });

  it("returns 404 for test-run endpoints on an unknown project or run id", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "test-404-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const badRunRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/tests/run",
    });
    expect(badRunRes.statusCode).toBe(404);

    const badGetRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/tests/00000000-0000-0000-0000-000000000000`,
    });
    expect(badGetRes.statusCode).toBe(404);
  });

  it("returns live security findings for a registered project", async () => {
    writeFile(repoRoot, ".env", "SECRET=abc\n");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "security-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/security`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.findings.find((f: { ruleId: string }) => f.ruleId === "env-file-committed")).toBeTruthy();
  });

  it("returns 404 for security on an unknown project", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/security",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns dependency analysis for a registered npm project", async () => {
    // repoRoot's default package.json (from beforeEach) has a "vite" dependency.
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "deps-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/dependencies`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ecosystem).toBe("npm");
    expect(body.direct.find((d: { name: string }) => d.name === "vite")).toBeTruthy();
  });

  it("returns 404 for dependencies on an unknown project", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/dependencies",
    });
    expect(res.statusCode).toBe(404);
  });

  it("aggregates a full audit report for a scanned, analyzed, tested project", async () => {
    writeFile(repoRoot, ".env", "SECRET=abc\n");
    initGit(repoRoot);
    gitCommitAll(repoRoot, "initial commit");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "audit-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/audit`,
    });
    expect(res.statusCode).toBe(200);
    const report = res.json();

    expect(report.project.id).toBe(project.id);
    expect(report.snapshot).not.toBeNull();
    expect(report.snapshot.buildSystems).toContain("npm");
    expect(report.findings.latestRun).not.toBeNull();
    expect(report.findings.counts.total).toBeGreaterThanOrEqual(0);
    expect(report.security.findings.find((f: { ruleId: string }) => f.ruleId === "env-file-committed")).toBeTruthy();
    expect(report.dependencies.ecosystem).toBe("npm");
    expect(report.git.isGitRepository).toBe(true);
    expect(report.git.branch).toBeTruthy();
    // Test runner was never invoked in this test — an audit report must
    // say so honestly rather than fabricate a run.
    expect(report.latestTestRun).toBeNull();
  });

  it("reports nulls honestly for a freshly registered, never-scanned project", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "unscanned", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/audit`,
    });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.snapshot).toBeNull();
    expect(report.findings.latestRun).toBeNull();
    expect(report.findings.counts.total).toBe(0);
    expect(report.latestTestRun).toBeNull();
  });

  it("returns 404 for audit on an unknown project", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/audit",
    });
    expect(res.statusCode).toBe(404);
  });

  it("exports the audit report as a downloadable Markdown document", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "export-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/audit/export`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".md");
    expect(res.body).toContain("# Audit Report — export-fixture");
    expect(res.body).toContain("## Repository snapshot");
    expect(res.body).toContain("## Security scan (live)");
  });

  it("returns 404 for audit export on an unknown project", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/audit/export",
    });
    expect(res.statusCode).toBe(404);
  });

  it("builds a real AI context bundle for a persisted finding", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "context-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

    const findingsRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings?severity=high`,
    });
    const finding = findingsRes.json().findings.find((f: { rule_id: string }) => f.rule_id === "hardcoded-secret");
    expect(finding).toBeTruthy();

    const contextRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/context`,
    });
    expect(contextRes.statusCode).toBe(200);
    const bundle = contextRes.json();
    expect(bundle.targetId).toBe(finding.id);
    expect(bundle.selected.some((s: { path: string }) => s.path === "src/config.ts")).toBe(true);
    // The secret must never appear anywhere in the response — the context
    // layer's own redaction, independent of the finding evidence's own redaction.
    expect(contextRes.body).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("respects a custom budgetTokens and rejects an invalid one", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "budget-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

    const findingsRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings` });
    const finding = findingsRes.json().findings[0];
    expect(finding).toBeTruthy();

    const tinyBudgetRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/context?budgetTokens=1`,
    });
    expect(tinyBudgetRes.statusCode).toBe(200);
    expect(tinyBudgetRes.json().budgetTokens).toBe(1);

    const invalidRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/context?budgetTokens=notanumber`,
    });
    expect(invalidRes.statusCode).toBe(400);
  });

  it("returns 404 for context on an unknown finding or project", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "ctx-404-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const unknownFindingRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings/00000000-0000-0000-0000-000000000000/context`,
    });
    expect(unknownFindingRes.statusCode).toBe(404);

    const unknownProjectRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/00000000-0000-0000-0000-000000000000/findings/00000000-0000-0000-0000-000000000000/context`,
    });
    expect(unknownProjectRes.statusCode).toBe(404);
  });

  it("explains a finding via a real local AI provider, persists it, and serves it back via GET", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: "This is a real secret leak." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 30, completion_tokens: 8 },
          })
        );
      });
    });

    try {
      const providerRes = await app.inject({
        method: "POST",
        url: "/api/v1/ai/providers",
        payload: { name: "Local Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test" },
      });
      const { provider } = providerRes.json();
      await app.inject({
        method: "PATCH",
        url: `/api/v1/ai/providers/${provider.id}`,
        payload: { enabled: true },
      });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "explain-fixture", rootPath: repoRoot },
      });
      const { project } = createRes.json();
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

      const findingsRes = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/findings?severity=high`,
      });
      const finding = findingsRes.json().findings.find((f: { rule_id: string }) => f.rule_id === "hardcoded-secret");
      expect(finding).toBeTruthy();

      const explainRes = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/findings/${finding.id}/explain`,
      });
      expect(explainRes.statusCode).toBe(200);
      const body = explainRes.json();
      expect(body.explanation).toBe("This is a real secret leak.");
      expect(body.provider).toBe("openai-compatible");
      expect(body.usage).toEqual({ promptTokens: 30, completionTokens: 8 });
      expect(explainRes.body).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");

      const storedRes = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/findings/${finding.id}/explanation`,
      });
      expect(storedRes.statusCode).toBe(200);
      expect(storedRes.json().explanation).toBe("This is a real secret leak.");
    } finally {
      await close();
    }
  });

  it("returns 400 when explaining a finding with no AI provider enabled", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "explain-no-provider-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

    const findingsRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings` });
    const finding = findingsRes.json().findings[0];
    expect(finding).toBeTruthy();

    const explainRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/explain`,
    });
    expect(explainRes.statusCode).toBe(400);
    expect(explainRes.json().error).toMatch(/No AI provider is configured/);
  });

  it("returns { explanation: null } when no explanation has been generated yet", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "explanation-empty-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

    const findingsRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings` });
    const finding = findingsRes.json().findings[0];
    expect(finding).toBeTruthy();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/explanation`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ explanation: null });
  });

  it("returns 404 for explain/explanation on an unknown finding or project", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "explain-404-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const explainRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/00000000-0000-0000-0000-000000000000/explain`,
    });
    expect(explainRes.statusCode).toBe(404);

    const explanationRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/00000000-0000-0000-0000-000000000000/findings/00000000-0000-0000-0000-000000000000/explanation`,
    });
    expect(explanationRes.statusCode).toBe(404);
  });

  it("analyzes root cause via a real local AI provider, parses evidence/inference/confidence, and serves it back via GET", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [
              {
                message: {
                  content:
                    "EVIDENCE:\n- Line 1 hardcodes a literal beginning with sk_live_\n\nINFERENCE:\nA real production key was committed by mistake.\n\nCONFIDENCE: high",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 35, completion_tokens: 18 },
          })
        );
      });
    });

    try {
      const providerRes = await app.inject({
        method: "POST",
        url: "/api/v1/ai/providers",
        payload: { name: "Local Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test" },
      });
      const { provider } = providerRes.json();
      await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${provider.id}`, payload: { enabled: true } });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "root-cause-fixture", rootPath: repoRoot },
      });
      const { project } = createRes.json();
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

      const findingsRes = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/findings?severity=high`,
      });
      const finding = findingsRes.json().findings.find((f: { rule_id: string }) => f.rule_id === "hardcoded-secret");
      expect(finding).toBeTruthy();

      const rootCauseRes = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/findings/${finding.id}/root-cause`,
      });
      expect(rootCauseRes.statusCode).toBe(200);
      const body = rootCauseRes.json();
      expect(body.analysis.evidence).toEqual(["Line 1 hardcodes a literal beginning with sk_live_"]);
      expect(body.analysis.inference).toBe("A real production key was committed by mistake.");
      expect(body.analysis.confidence).toBe("high");
      expect(rootCauseRes.body).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");

      const storedRes = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/findings/${finding.id}/root-cause`,
      });
      expect(storedRes.statusCode).toBe(200);
      expect(storedRes.json().analysis.confidence).toBe("high");
    } finally {
      await close();
    }
  });

  it("returns 400 when analyzing root cause with no AI provider enabled, and { analysis: null } before any analysis exists", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "root-cause-no-provider-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

    const findingsRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings` });
    const finding = findingsRes.json().findings[0];
    expect(finding).toBeTruthy();

    const emptyRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/root-cause`,
    });
    expect(emptyRes.statusCode).toBe(200);
    expect(emptyRes.json()).toEqual({ analysis: null });

    const rootCauseRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/root-cause`,
    });
    expect(rootCauseRes.statusCode).toBe(400);
    expect(rootCauseRes.json().error).toMatch(/No AI provider is configured/);
  });

  it("returns 404 for root-cause on an unknown finding or project", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "root-cause-404-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const postRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/00000000-0000-0000-0000-000000000000/root-cause`,
    });
    expect(postRes.statusCode).toBe(404);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/00000000-0000-0000-0000-000000000000/findings/00000000-0000-0000-0000-000000000000/root-cause`,
    });
    expect(getRes.statusCode).toBe(404);
  });

  const FULL_PLAN_TEXT =
    "PROBLEM:\nAn API key is hardcoded in source.\n\n" +
    "ROOT CAUSE:\nA real credential was pasted during testing and never removed.\n\n" +
    "FILES AFFECTED:\n- src/config.ts\n\n" +
    "PROPOSED CHANGES:\nMove the key to an environment variable.\n\n" +
    "RISKS:\nThe app could fail to start if the env var is unset.\n\n" +
    "REQUIRED TESTS:\nAdd a test for the missing-env-var startup failure.\n\n" +
    "VALIDATION STRATEGY:\nA reviewer should confirm no secret remains in the diff.";

  it("builds a fix plan via a real local AI provider, parses all seven sections, and serves it back via GET", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: FULL_PLAN_TEXT }, finish_reason: "stop" }],
            usage: { prompt_tokens: 60, completion_tokens: 40 },
          })
        );
      });
    });

    try {
      const providerRes = await app.inject({
        method: "POST",
        url: "/api/v1/ai/providers",
        payload: { name: "Local Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test" },
      });
      const { provider } = providerRes.json();
      await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${provider.id}`, payload: { enabled: true } });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "fix-plan-fixture", rootPath: repoRoot },
      });
      const { project } = createRes.json();
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

      const findingsRes = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/findings?severity=high`,
      });
      const finding = findingsRes.json().findings.find((f: { rule_id: string }) => f.rule_id === "hardcoded-secret");
      expect(finding).toBeTruthy();

      const planRes = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/findings/${finding.id}/fix-plan`,
      });
      expect(planRes.statusCode).toBe(200);
      const body = planRes.json();
      expect(body.plan.filesAffected).toEqual(["src/config.ts"]);
      expect(body.plan.proposedChanges).toContain("environment variable");
      expect(body.usedPriorRootCauseAnalysis).toBe(false);
      expect(planRes.body).not.toContain("ABCDEFGHIJKLMNOPQRSTUV");

      const storedRes = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/findings/${finding.id}/fix-plan`,
      });
      expect(storedRes.statusCode).toBe(200);
      expect(storedRes.json().plan.filesAffected).toEqual(["src/config.ts"]);
    } finally {
      await close();
    }
  });

  it("returns 400 when building a fix plan with no AI provider enabled, and { plan: null } before any plan exists", async () => {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "fix-plan-no-provider-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

    const findingsRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings` });
    const finding = findingsRes.json().findings[0];
    expect(finding).toBeTruthy();

    const emptyRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/fix-plan`,
    });
    expect(emptyRes.statusCode).toBe(200);
    expect(emptyRes.json()).toEqual({ plan: null });

    const planRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/fix-plan`,
    });
    expect(planRes.statusCode).toBe(400);
    expect(planRes.json().error).toMatch(/No AI provider is configured/);
  });

  it("returns 404 for fix-plan on an unknown finding or project", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "fix-plan-404-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const postRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/00000000-0000-0000-0000-000000000000/fix-plan`,
    });
    expect(postRes.statusCode).toBe(404);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/00000000-0000-0000-0000-000000000000/findings/00000000-0000-0000-0000-000000000000/fix-plan`,
    });
    expect(getRes.statusCode).toBe(404);
  });

  const PATCH_DIFF = "--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1,2 +1,2 @@\n-const apiKey = \"sk_live_ABCDEFGHIJKLMNOPQRSTUV\";\n+const apiKey = process.env.API_KEY;\n export const x = 1;\n";

  async function setUpFindingWithFixPlan(): Promise<{ project: any; finding: any }> {
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [
              {
                message: {
                  content:
                    "PROBLEM:\nHardcoded secret.\n\nROOT CAUSE:\nPasted during testing.\n\nFILES AFFECTED:\n- src/config.ts\n\nPROPOSED CHANGES:\nUse an env var.\n\nRISKS:\nNone significant.\n\nREQUIRED TESTS:\nNone new.\n\nVALIDATION STRATEGY:\nGrep for the literal.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          })
        );
      });
    });

    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Local Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test" },
    });
    const { provider } = providerRes.json();
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${provider.id}`, payload: { enabled: true } });

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "patch-fixture-" + randomUUID(), rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

    const findingsRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings?severity=high` });
    const finding = findingsRes.json().findings.find((f: { rule_id: string }) => f.rule_id === "hardcoded-secret");
    expect(finding).toBeTruthy();

    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/findings/${finding.id}/fix-plan` });
    await close();

    return { project, finding };
  }

  it("requires a fix plan before a patch can be created", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "patch-no-plan-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });
    const findingsRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings` });
    const finding = findingsRes.json().findings[0];

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/patches`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Generate a fix plan/);
  });

  it("walks the full patch lifecycle: create (pending_approval) -> approve -> generate (proposed), with a real diff", async () => {
    const { project, finding } = await setUpFindingWithFixPlan();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/patches`,
    });
    expect(createRes.statusCode).toBe(201);
    const patch = createRes.json().patch;
    expect(patch.status).toBe("pending_approval");
    expect(patch.diff_text).toBeNull();
    expect(patch.description).toBe("Hardcoded secret.");

    // Generation must be refused before approval — the server-enforced gate, not a UI convention.
    const { url: genUrl, close: closeGen } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: PATCH_DIFF }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    try {
      const providerRes = await app.inject({
        method: "POST",
        url: "/api/v1/ai/providers",
        payload: { name: "Gen Provider", kind: "openai-compatible", baseUrl: genUrl, model: "gpt-test" },
      });
      await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });

      const prematureGenerateRes = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/patches/${patch.id}/generate`,
      });
      expect(prematureGenerateRes.statusCode).toBe(400);
      expect(prematureGenerateRes.json().error).toMatch(/not "approved"/);

      const approveRes = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/patches/${patch.id}/approve`,
        payload: { reviewerNote: "Looks reasonable" },
      });
      expect(approveRes.statusCode).toBe(200);
      expect(approveRes.json().patch.status).toBe("approved");

      const generateRes = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/patches/${patch.id}/generate`,
      });
      expect(generateRes.statusCode).toBe(200);
      const body = generateRes.json();
      expect(body.patch.status).toBe("proposed");
      expect(body.patch.diff_text).toBe(PATCH_DIFF);
      expect(body.usedFixPlan).toBe(true);
      // Note: unlike /explain, /root-cause, and /fix-plan, the diff text
      // itself is the model's own generated output, not context assembled
      // from the codebase — so it is stored verbatim (including a "-" line
      // quoting the secret being removed, exactly as a real diff would).
      // Redaction guarantees apply to what's sent TO the provider (the
      // context bundle), not to what the provider sends back.

      const fetchRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/patches/${patch.id}` });
      expect(fetchRes.json().patch.diff_text).toBe(PATCH_DIFF);

      const listRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings/${finding.id}/patches` });
      expect(listRes.json().patches.map((p: { id: string }) => p.id)).toContain(patch.id);
    } finally {
      await closeGen();
    }
  });

  it("rejects a patch before generation and then refuses to generate it", async () => {
    const { project, finding } = await setUpFindingWithFixPlan();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/patches`,
    });
    const patch = createRes.json().patch;

    const rejectRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/${patch.id}/reject`,
      payload: { reviewerNote: "Not worth automating" },
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().patch.status).toBe("rejected");

    const generateRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/${patch.id}/generate`,
    });
    expect(generateRes.statusCode).toBe(400);
    expect(generateRes.json().error).toMatch(/not "approved"/);
  });

  it("walks the second approval gate: proposed -> approve-apply -> apply, writing a real diff to disk", async () => {
    const { project, finding } = await setUpFindingWithFixPlan();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/patches`,
    });
    const patch = createRes.json().patch;

    const { url: genUrl, close: closeGen } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: PATCH_DIFF }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Apply Gen Provider", kind: "openai-compatible", baseUrl: genUrl, model: "gpt-test" },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/approve` });
    const generateRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/generate` });
    await closeGen();
    expect(generateRes.json().patch.status).toBe("proposed");

    // The second gate refuses to let /apply run before this diff is itself reviewed and approved.
    const prematureApplyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/${patch.id}/apply`,
    });
    expect(prematureApplyRes.statusCode).toBe(400);
    expect(prematureApplyRes.json().error).toMatch(/not "approved_for_apply"/);

    const approveApplyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/${patch.id}/approve-apply`,
      payload: { reviewerNote: "Diff looks correct" },
    });
    expect(approveApplyRes.statusCode).toBe(200);
    expect(approveApplyRes.json().patch.status).toBe("approved_for_apply");

    const applyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/${patch.id}/apply`,
    });
    expect(applyRes.statusCode).toBe(200);
    const appliedPatch = applyRes.json().patch;
    expect(appliedPatch.status).toBe("applied");
    expect(appliedPatch.apply_error).toBeNull();

    // The real file on disk actually changed — this is the first route in the
    // product that writes to a file, so this is the assertion that matters.
    const fileContent = fs.readFileSync(path.join(repoRoot, "src/config.ts"), "utf-8");
    expect(fileContent).toContain("process.env.API_KEY");
    expect(fileContent).not.toContain("sk_live_ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("rejects a diff after review and refuses to apply it", async () => {
    const { project, finding } = await setUpFindingWithFixPlan();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/patches`,
    });
    const patch = createRes.json().patch;

    const { url: genUrl, close: closeGen } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: PATCH_DIFF }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Reject Apply Gen Provider", kind: "openai-compatible", baseUrl: genUrl, model: "gpt-test" },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/approve` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/generate` });
    await closeGen();

    const rejectApplyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/${patch.id}/reject-apply`,
      payload: { reviewerNote: "Diff is wrong" },
    });
    expect(rejectApplyRes.statusCode).toBe(200);
    expect(rejectApplyRes.json().patch.status).toBe("rejected");

    const applyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/${patch.id}/apply`,
    });
    expect(applyRes.statusCode).toBe(400);
    expect(applyRes.json().error).toMatch(/not "approved_for_apply"/);

    // Nothing was written — the file is untouched.
    const fileContent = fs.readFileSync(path.join(repoRoot, "src/config.ts"), "utf-8");
    expect(fileContent).toContain("sk_live_ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("records a failed apply (diff no longer matches the working tree) without touching the file, and allows a retry", async () => {
    const { project, finding } = await setUpFindingWithFixPlan();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/patches`,
    });
    const patch = createRes.json().patch;

    const { url: genUrl, close: closeGen } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: PATCH_DIFF }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Failed Apply Gen Provider", kind: "openai-compatible", baseUrl: genUrl, model: "gpt-test" },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/approve` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/generate` });
    await closeGen();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/approve-apply` });

    // The file drifted since the diff was generated — the real dry run must catch this.
    writeFile(repoRoot, "src/config.ts", "totally different content now\n");

    const applyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/${patch.id}/apply`,
    });
    expect(applyRes.statusCode).toBe(200);
    const failedPatch = applyRes.json().patch;
    expect(failedPatch.status).toBe("failed");
    expect(failedPatch.apply_error).toBeTruthy();
    const fileContent = fs.readFileSync(path.join(repoRoot, "src/config.ts"), "utf-8");
    expect(fileContent).toBe("totally different content now\n"); // untouched by the failed apply

    // Retry is allowed directly from 'failed' without re-approving.
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);
    const retryRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/${patch.id}/apply`,
    });
    expect(retryRes.statusCode).toBe(200);
    expect(retryRes.json().patch.status).toBe("applied");
  });

  it("returns 404 for patch routes on an unknown patch or project", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "patch-404-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/patches/00000000-0000-0000-0000-000000000000`,
    });
    expect(getRes.statusCode).toBe(404);

    const approveRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/00000000-0000-0000-0000-000000000000/approve`,
    });
    expect(approveRes.statusCode).toBe(404);

    const approveApplyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/00000000-0000-0000-0000-000000000000/approve-apply`,
    });
    expect(approveApplyRes.statusCode).toBe(404);

    const rejectApplyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/00000000-0000-0000-0000-000000000000/reject-apply`,
    });
    expect(rejectApplyRes.statusCode).toBe(404);

    const applyRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/patches/00000000-0000-0000-0000-000000000000/apply`,
    });
    expect(applyRes.statusCode).toBe(404);

    const generateRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/00000000-0000-0000-0000-000000000000/patches/00000000-0000-0000-0000-000000000000/generate`,
    });
    expect(generateRes.statusCode).toBe(404);
  });

  // --- Phase 21: AI self-review ---------------------------------------------

  const GOOD_SELF_REVIEW_RESPONSE =
    "CORRECTNESS: pass - the diff reads the key from an environment variable instead of hardcoding it.\n" +
    "SCOPE_CREEP: pass - only the affected line changes.\n" +
    "REGRESSIONS: pass - no other code path is affected.\n" +
    "SECURITY: pass - the hardcoded secret is removed.\n" +
    "MISSING_TESTS: concern - no test asserts the env var is actually read.\n" +
    "UNNECESSARY_COMPLEXITY: pass - minimal fix.\n" +
    "ARCHITECTURE_CONSISTENCY: pass - matches existing config-loading style.";

  async function setUpGeneratedPatch(): Promise<{ project: any; finding: any; patch: any }> {
    const { project, finding } = await setUpFindingWithFixPlan();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/patches`,
    });
    const patch = createRes.json().patch;

    const { url: genUrl, close: closeGen } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: PATCH_DIFF }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Self-Review Gen Provider", kind: "openai-compatible", baseUrl: genUrl, model: "gpt-test" },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/approve` });
    const generateRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/generate` });
    await closeGen();
    expect(generateRes.json().patch.status).toBe("proposed");

    return { project, finding, patch: generateRes.json().patch };
  }

  it("GET self-review returns null before any self-review has been generated", async () => {
    const { project, patch } = await setUpGeneratedPatch();

    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/patches/${patch.id}/self-review` });
    expect(res.statusCode).toBe(200);
    expect(res.json().review).toBeNull();
  });

  it("refuses to self-review a patch with no diff yet", async () => {
    const { project, finding } = await setUpFindingWithFixPlan();
    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/patches`,
    });
    const patch = createRes.json().patch;

    const res = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/self-review` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/no diff yet/);
  });

  it("self-reviews a real generated patch end to end, then serves the stored review on GET, without changing the patch's status", async () => {
    const { project, patch } = await setUpGeneratedPatch();

    const { url: reviewUrl, close: closeReview } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "gpt-test",
          choices: [{ message: { content: GOOD_SELF_REVIEW_RESPONSE }, finish_reason: "stop" }],
          usage: { prompt_tokens: 30, completion_tokens: 12 },
        })
      );
    });
    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Self-Review Provider", kind: "openai-compatible", baseUrl: reviewUrl, model: "gpt-test" },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });

    const reviewRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/self-review` });
    await closeReview();
    expect(reviewRes.statusCode).toBe(200);
    const body = reviewRes.json();
    expect(body.review.correctness.status).toBe("pass");
    expect(body.review.missingTests.status).toBe("concern");
    expect(body.contextBundle.selected.length).toBeGreaterThan(0);

    // Self-review is advisory only — the patch's own status is untouched.
    const patchAfter = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/patches/${patch.id}` });
    expect(patchAfter.json().patch.status).toBe("proposed");

    const getRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/patches/${patch.id}/self-review` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().review.correctness.status).toBe("pass");
    expect(getRes.json().provider).toBe("openai-compatible");
  });

  it("refuses self-review without an enabled AI provider", async () => {
    const { project, patch } = await setUpGeneratedPatch();

    // setUpGeneratedPatch left a provider enabled (used for generation) —
    // disable it so this test genuinely exercises the "no enabled
    // provider" 400 path rather than a real network failure against the
    // now-closed generation server.
    const providersRes = await app.inject({ method: "GET", url: "/api/v1/ai/providers" });
    for (const p of providersRes.json().providers) {
      await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${p.id}`, payload: { enabled: false } });
    }

    const res = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${patch.id}/self-review` });
    expect(res.statusCode).toBe(400);
  });

  it("404s for self-review routes on an unknown patch or project", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "self-review-404-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    const unknownId = "00000000-0000-0000-0000-000000000000";

    const getRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/patches/${unknownId}/self-review` });
    expect(getRes.statusCode).toBe(404);

    const postRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/patches/${unknownId}/self-review` });
    expect(postRes.statusCode).toBe(404);
  });

  // --- Phase 19: AI test generation ----------------------------------------

  const GOOD_TEST_RESPONSE =
    "TARGET_PATH:\nsrc/config.test.ts\n\nTEST_CODE:\nimport { describe, it, expect } from \"vitest\";\n\ndescribe(\"config\", () => {\n  it(\"does not hardcode the secret\", () => {\n    expect(true).toBe(true);\n  });\n});\n";

  async function setUpFindingForGeneratedTest(): Promise<{ project: any; finding: any }> {
    writeFile(repoRoot, "package.json", JSON.stringify({ scripts: { test: "node -e \"console.log('1 passed')\"" } }));
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "generated-test-fixture-" + randomUUID(), rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

    const findingsRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings?severity=high` });
    const finding = findingsRes.json().findings.find((f: { rule_id: string }) => f.rule_id === "hardcoded-secret");
    expect(finding).toBeTruthy();

    return { project, finding };
  }

  it("walks the full generated-test lifecycle: create -> approve -> generate -> approve-write -> write-and-run, with a real file written and a real test command executed", async () => {
    const { project, finding } = await setUpFindingForGeneratedTest();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/generated-tests`,
    });
    expect(createRes.statusCode).toBe(201);
    const generatedTest = createRes.json().generatedTest;
    expect(generatedTest.status).toBe("pending_approval");
    expect(generatedTest.test_code).toBeNull();

    // Generation must be refused before approval.
    const prematureGenerateRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/generate`,
    });
    expect(prematureGenerateRes.statusCode).toBe(400);
    expect(prematureGenerateRes.json().error).toMatch(/not "approved"/);

    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/approve` });

    const { url: genUrl, close: closeGen } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: GOOD_TEST_RESPONSE }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Test Gen Provider", kind: "openai-compatible", baseUrl: genUrl, model: "gpt-test" },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });

    const generateRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/generate`,
    });
    await closeGen();
    expect(generateRes.statusCode).toBe(200);
    const proposed = generateRes.json().generatedTest;
    expect(proposed.status).toBe("proposed");
    expect(proposed.target_path).toBe("src/config.test.ts");
    expect(proposed.test_code).toContain("describe(");

    // Writing must be refused before the diff-review-equivalent second gate.
    const prematureWriteRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/write-and-run`,
    });
    expect(prematureWriteRes.statusCode).toBe(400);
    expect(prematureWriteRes.json().error).toMatch(/not "approved_for_write"/);

    const approveWriteRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/approve-write`,
      payload: { reviewerNote: "Looks like a reasonable test" },
    });
    expect(approveWriteRes.statusCode).toBe(200);
    expect(approveWriteRes.json().generatedTest.status).toBe("approved_for_write");

    const writeRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/write-and-run`,
    });
    expect(writeRes.statusCode).toBe(200);
    const writeBody = writeRes.json();
    expect(writeBody.generatedTest.status).toBe("passed");
    expect(writeBody.supported).toBe(true);
    expect(writeBody.testRun.status).toBe("passed");

    // The real file actually exists on disk with the AI-generated content.
    const fileContent = fs.readFileSync(path.join(repoRoot, "src/config.test.ts"), "utf-8");
    expect(fileContent).toContain('describe("config"');

    // The real test_run row is independently fetchable via the existing Tests page API.
    const testRunRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/tests/${writeBody.testRun.id}` });
    expect(testRunRes.statusCode).toBe(200);
    expect(testRunRes.json().run.stdout_ref).toContain("1 passed");
  });

  it("refuses to overwrite a file that already exists", async () => {
    const { project, finding } = await setUpFindingForGeneratedTest();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/generated-tests`,
    });
    const generatedTest = createRes.json().generatedTest;
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/approve` });

    // The model proposes a path that already exists (src/config.ts, not a new test file).
    const conflictingResponse =
      "TARGET_PATH:\nsrc/config.ts\n\nTEST_CODE:\nimport { describe, it, expect } from \"vitest\";\n\ndescribe(\"whoops\", () => {\n  it(\"conflicts\", () => {\n    expect(true).toBe(true);\n  });\n});\n";
    const { url: genUrl, close: closeGen } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: conflictingResponse }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Conflict Gen Provider", kind: "openai-compatible", baseUrl: genUrl, model: "gpt-test" },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/generate` });
    await closeGen();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/approve-write` });

    const originalContent = fs.readFileSync(path.join(repoRoot, "src/config.ts"), "utf-8");

    const writeRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/write-and-run`,
    });
    expect(writeRes.statusCode).toBe(400);
    expect(writeRes.json().error).toMatch(/already exists/);

    // Untouched — the conflict check ran before any write.
    const afterContent = fs.readFileSync(path.join(repoRoot, "src/config.ts"), "utf-8");
    expect(afterContent).toBe(originalContent);
  });

  it("rejects a generated test after code review and refuses to write it", async () => {
    const { project, finding } = await setUpFindingForGeneratedTest();

    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/findings/${finding.id}/generated-tests`,
    });
    const generatedTest = createRes.json().generatedTest;
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/approve` });

    const { url: genUrl, close: closeGen } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { content: GOOD_TEST_RESPONSE }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    });
    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Reject Write Gen Provider", kind: "openai-compatible", baseUrl: genUrl, model: "gpt-test" },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/generate` });
    await closeGen();

    const rejectWriteRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/reject-write`,
      payload: { reviewerNote: "Test doesn't actually assert anything useful" },
    });
    expect(rejectWriteRes.statusCode).toBe(200);
    expect(rejectWriteRes.json().generatedTest.status).toBe("rejected");

    const writeRes = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/generated-tests/${generatedTest.id}/write-and-run`,
    });
    expect(writeRes.statusCode).toBe(400);
    expect(writeRes.json().error).toMatch(/not "approved_for_write"/);
    expect(fs.existsSync(path.join(repoRoot, "src/config.test.ts"))).toBe(false);
  });

  it("returns 404 for generated-test routes on an unknown test or project", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "generated-test-404-fixture", rootPath: repoRoot },
    });
    const { project } = createRes.json();
    const unknownId = "00000000-0000-0000-0000-000000000000";

    const getRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/generated-tests/${unknownId}` });
    expect(getRes.statusCode).toBe(404);

    const approveRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${unknownId}/approve` });
    expect(approveRes.statusCode).toBe(404);

    const rejectRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${unknownId}/reject` });
    expect(rejectRes.statusCode).toBe(404);

    const generateRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${unknownId}/generate` });
    expect(generateRes.statusCode).toBe(404);

    const approveWriteRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${unknownId}/approve-write` });
    expect(approveWriteRes.statusCode).toBe(404);

    const rejectWriteRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${unknownId}/reject-write` });
    expect(rejectWriteRes.statusCode).toBe(404);

    const writeRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/generated-tests/${unknownId}/write-and-run` });
    expect(writeRes.statusCode).toBe(404);
  });

  async function setUpFailedTestRun(): Promise<{ project: any; run: any }> {
    // A real "test" script that exits non-zero — runTests() (Phase 9) is a
    // real subprocess execution, not a mock, so the resulting test_run row
    // is a genuine 'failed' status this diagnose route can act on.
    writeFile(
      repoRoot,
      "package.json",
      JSON.stringify({ scripts: { test: "node -e \"console.error('FAIL src/a.test.ts'); console.error('AssertionError: expected 3 but got -1'); process.exit(1)\"" } })
    );
    writeFile(repoRoot, "src/a.ts", "export function add(a, b) { return a - b; }\n");
    writeFile(repoRoot, "src/a.test.ts", "import { add } from './a.js';\ntest('adds', () => add(1, 2));\n");

    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "diagnose-fixture-" + randomUUID(), rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });

    const runRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/tests/run` });
    expect(runRes.statusCode).toBe(200);
    const { run } = runRes.json();
    expect(run.status).toBe("failed");

    return { project, run };
  }

  it("GET diagnosis returns null before any diagnosis has been generated", async () => {
    const { project, run } = await setUpFailedTestRun();

    const res = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/tests/${run.id}/diagnosis` });
    expect(res.statusCode).toBe(200);
    expect(res.json().diagnosis).toBeNull();
  });

  it("refuses to diagnose a run that isn't 'failed'", async () => {
    writeFile(repoRoot, "package.json", JSON.stringify({ scripts: { test: "node -e \"console.log('ok')\"" } }));
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      payload: { name: "diagnose-passed-fixture-" + randomUUID(), rootPath: repoRoot },
    });
    const { project } = createRes.json();
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
    await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
    const runRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/tests/run` });
    const { run } = runRes.json();
    expect(run.status).toBe("passed");

    const res = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/tests/${run.id}/diagnose` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/status is 'passed'/);
  });

  it("refuses to diagnose without an enabled AI provider", async () => {
    const { project, run } = await setUpFailedTestRun();

    const res = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/tests/${run.id}/diagnose` });
    expect(res.statusCode).toBe(400);
  });

  it("diagnoses a real failed run end to end, then serves the stored diagnosis on GET", async () => {
    const { project, run } = await setUpFailedTestRun();

    const { url: genUrl, close: closeGen } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "gpt-test",
          choices: [
            {
              message: {
                content:
                  "LIKELY_CAUSE:\nadd() subtracts instead of adding.\n\nEVIDENCE:\n- expected 3 but got -1\n\nSUGGESTED_DIRECTION:\nFix the operator in add().",
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        })
      );
    });
    const providerRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Diagnose Provider", kind: "openai-compatible", baseUrl: genUrl, model: "gpt-test" },
    });
    await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${providerRes.json().provider.id}`, payload: { enabled: true } });

    const diagnoseRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/tests/${run.id}/diagnose` });
    await closeGen();
    expect(diagnoseRes.statusCode).toBe(200);
    const body = diagnoseRes.json();
    expect(body.diagnosis.likelyCause).toBe("add() subtracts instead of adding.");
    expect(body.diagnosis.evidence).toEqual(["expected 3 but got -1"]);
    expect(body.contextBundle.selected.map((s: any) => s.path)).toContain("(test run output)");

    const getRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/tests/${run.id}/diagnosis` });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().diagnosis.likelyCause).toBe("add() subtracts instead of adding.");
    expect(getRes.json().provider).toBe("openai-compatible");
  });

  it("404s for an unknown project or test run on the diagnose routes", async () => {
    const { project } = await setUpFailedTestRun();
    const unknownId = "00000000-0000-0000-0000-000000000000";

    const getRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/tests/${unknownId}/diagnosis` });
    expect(getRes.statusCode).toBe(404);

    const postRes = await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/tests/${unknownId}/diagnose` });
    expect(postRes.statusCode).toBe(404);

    const wrongProjectRes = await app.inject({ method: "GET", url: `/api/v1/projects/${unknownId}/tests/${unknownId}/diagnosis` });
    expect(wrongProjectRes.statusCode).toBe(404);
  });
});
