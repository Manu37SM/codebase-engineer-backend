import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { openDatabase, DB } from "../src/db/index.js";
import { createProject } from "../src/db/projectRepo.js";
import { replaceProjectFindings, getFindingById } from "../src/db/findingRepo.js";
import { createPatch, setPatchDiff, getPatchById } from "../src/db/patchRepo.js";
import { getAIRequestById, getLatestSuccessfulResponseForPatch } from "../src/db/aiRequestRepo.js";
import { selfReviewPatch, parseSelfReviewSections, SELF_REVIEW_OPERATION_TYPE } from "../src/ai/workflows/selfReview.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

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

const GOOD_REVIEW_RESPONSE =
  "CORRECTNESS: pass - the diff correctly negates the operator, fixing the finding.\n" +
  "SCOPE_CREEP: pass - only the affected line is touched.\n" +
  "REGRESSIONS: concern - no test currently exercises this function's negative-number path.\n" +
  "SECURITY: pass - no security-relevant code is touched.\n" +
  "MISSING_TESTS: fail - a regression test covering this exact case should be added.\n" +
  "UNNECESSARY_COMPLEXITY: pass - this is the minimal fix.\n" +
  "ARCHITECTURE_CONSISTENCY: pass - matches the style of the surrounding code.";

describe("parseSelfReviewSections", () => {
  it("parses a well-formed seven-check response", () => {
    const parsed = parseSelfReviewSections(GOOD_REVIEW_RESPONSE);
    expect(parsed.correctness).toEqual({
      status: "pass",
      note: "the diff correctly negates the operator, fixing the finding.",
    });
    expect(parsed.regressions).toEqual({
      status: "concern",
      note: "no test currently exercises this function's negative-number path.",
    });
    expect(parsed.missingTests).toEqual({
      status: "fail",
      note: "a regression test covering this exact case should be added.",
    });
    expect(parsed.architectureConsistency.status).toBe("pass");
    expect(parsed.raw).toBe(GOOD_REVIEW_RESPONSE);
  });

  it("is case-insensitive on the status word", () => {
    const raw = "CORRECTNESS: PASS - looks right\n\nSCOPE_CREEP: Concern - a bit broad";
    const parsed = parseSelfReviewSections(raw);
    expect(parsed.correctness.status).toBe("pass");
    expect(parsed.scopeCreep.status).toBe("concern");
  });

  it("leaves status null (never fabricated) but keeps the note when the format isn't followed", () => {
    const raw = "CORRECTNESS: this diff looks fine to me.";
    const parsed = parseSelfReviewSections(raw);
    expect(parsed.correctness.status).toBeNull();
    expect(parsed.correctness.note).toBe("this diff looks fine to me.");
  });

  it("leaves an entirely missing section as status null, note null", () => {
    const raw = "CORRECTNESS: pass - fine.";
    const parsed = parseSelfReviewSections(raw);
    expect(parsed.security).toEqual({ status: null, note: null });
  });
});

describe("selfReviewPatch", () => {
  let tmpDbDir: string;
  let db: DB;
  let repoRoot: string;

  afterEach(() => {
    db?.close();
    if (tmpDbDir) fs.rmSync(tmpDbDir, { recursive: true, force: true });
    if (repoRoot) cleanupRepo(repoRoot);
  });

  function setup() {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-selfreview-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    repoRoot = makeTempRepo();
  }

  it("sends a real completion request, parses the checklist, and persists a successful accounting record keyed by patch_id", async () => {
    setup();
    writeFile(repoRoot, "src/a.ts", "export function add(a: number, b: number) { return a - b; }\n");

    const projectId = randomUUID();
    createProject(db, projectId, "test-project", repoRoot);

    const findingId = randomUUID();
    replaceProjectFindings(
      db,
      projectId,
      [
        {
          ruleId: "large-function",
          severity: "medium",
          category: "maintainability",
          filePath: "src/a.ts",
          lineStart: 1,
          lineEnd: 1,
          evidence: "add() subtracts instead of adding",
          explanation: "n/a",
          recommendation: "n/a",
        },
      ],
      () => findingId
    );
    const finding = getFindingById(db, findingId)!;

    const patchId = randomUUID();
    createPatch(db, patchId, { projectId, findingId, description: "fix add()" });
    setPatchDiff(
      db,
      patchId,
      "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export function add(a, b) { return a - b; }\n+export function add(a, b) { return a + b; }\n",
      "proposed"
    );
    const patch = getPatchById(db, patchId)!;

    let receivedBody: any;
    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: GOOD_REVIEW_RESPONSE }, finish_reason: "stop" }],
            usage: { prompt_tokens: 50, completion_tokens: 20 },
          })
        );
      });
    });

    try {
      const result = await selfReviewPatch({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        patch,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      expect(result.review.correctness.status).toBe("pass");
      expect(result.review.missingTests.status).toBe("fail");
      expect(result.usage).toEqual({ promptTokens: 50, completionTokens: 20 });

      const sentText = JSON.stringify(receivedBody);
      expect(sentText).toContain("return a - b");
      expect(sentText).toContain("CORRECTNESS");

      const requestRow = getAIRequestById(db, result.requestId);
      expect(requestRow?.status).toBe("succeeded");
      expect(requestRow?.patch_id).toBe(patchId);
      expect(requestRow?.finding_id).toBe(findingId);

      const stored = getLatestSuccessfulResponseForPatch(db, patchId, SELF_REVIEW_OPERATION_TYPE);
      expect(stored?.content).toContain("MISSING_TESTS");
    } finally {
      await close();
    }
  });

  it("refuses to self-review a patch with no diff yet", async () => {
    setup();
    const projectId = randomUUID();
    createProject(db, projectId, "test-project", repoRoot);
    const findingId = randomUUID();
    replaceProjectFindings(
      db,
      projectId,
      [
        {
          ruleId: "large-function",
          severity: "medium",
          category: "maintainability",
          filePath: "src/a.ts",
          lineStart: 1,
          lineEnd: 1,
          evidence: "n/a",
          explanation: "n/a",
          recommendation: "n/a",
        },
      ],
      () => findingId
    );
    const finding = getFindingById(db, findingId)!;
    const patchId = randomUUID();
    createPatch(db, patchId, { projectId, findingId, description: null });
    const patch = getPatchById(db, patchId)!;

    await expect(
      selfReviewPatch({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        patch,
        files: [],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "gpt-test", apiKey: null },
      })
    ).rejects.toThrow(/no diff_text/);
  });

  it("keeps two self-reviews of two different patches for the same finding independent", async () => {
    setup();
    writeFile(repoRoot, "src/a.ts", "export const x = 1;\n");
    const projectId = randomUUID();
    createProject(db, projectId, "test-project", repoRoot);
    const findingId = randomUUID();
    replaceProjectFindings(
      db,
      projectId,
      [
        {
          ruleId: "large-function",
          severity: "medium",
          category: "maintainability",
          filePath: "src/a.ts",
          lineStart: 1,
          lineEnd: 1,
          evidence: "n/a",
          explanation: "n/a",
          recommendation: "n/a",
        },
      ],
      () => findingId
    );
    const finding = getFindingById(db, findingId)!;

    const patchAId = randomUUID();
    createPatch(db, patchAId, { projectId, findingId, description: null });
    setPatchDiff(db, patchAId, "diff A", "proposed");
    const patchB_Id = randomUUID();
    createPatch(db, patchB_Id, { projectId, findingId, description: null });
    setPatchDiff(db, patchB_Id, "diff B", "proposed");

    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const content = body.includes("diff A") ? "CORRECTNESS: pass - A is fine." : "CORRECTNESS: fail - B is wrong.";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ model: "gpt-test", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
      });
    });

    try {
      const providerConfig = { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null };
      const files = [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }];

      await selfReviewPatch({ db, projectId, projectRoot: repoRoot, finding, patch: getPatchById(db, patchAId)!, files, providerConfig });
      await selfReviewPatch({ db, projectId, projectRoot: repoRoot, finding, patch: getPatchById(db, patchB_Id)!, files, providerConfig });

      const reviewA = getLatestSuccessfulResponseForPatch(db, patchAId, SELF_REVIEW_OPERATION_TYPE);
      const reviewB = getLatestSuccessfulResponseForPatch(db, patchB_Id, SELF_REVIEW_OPERATION_TYPE);
      expect(reviewA?.content).toContain("A is fine");
      expect(reviewB?.content).toContain("B is wrong");
    } finally {
      await close();
    }
  });
});
