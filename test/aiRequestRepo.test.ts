import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, DB } from "../src/db/index.js";
import { createProject } from "../src/db/projectRepo.js";
import { replaceProjectFindings } from "../src/db/findingRepo.js";
import {
  createAIRequest,
  createAIResponse,
  getAIRequestById,
  getLatestSuccessfulResponse,
  getLatestSuccessfulResponseForTestRun,
  getLatestSuccessfulResponseForPatch,
  markAIRequestStatus,
} from "../src/db/aiRequestRepo.js";
import { saveTestRun } from "../src/db/testRunRepo.js";
import { createPatch } from "../src/db/patchRepo.js";

describe("aiRequestRepo", () => {
  let tmpDir: string;
  let db: DB;
  let projectId: string;
  let findingId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-ai-request-test-"));
    db = openDatabase(path.join(tmpDir, "test.db"));
    projectId = randomUUID();
    createProject(db, projectId, "test-project", "/tmp/test-project-" + randomUUID());

    findingId = randomUUID();
    replaceProjectFindings(
      db,
      projectId,
      [
        {
          ruleId: "hardcoded-secret",
          severity: "high",
          category: "security",
          filePath: "src/a.ts",
          lineStart: 1,
          lineEnd: 1,
          evidence: "const apiKey = ...",
          explanation: "Secret found",
          recommendation: "Move to env var",
        },
      ],
      () => findingId
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates and reads back an ai_request row", () => {
    const id = randomUUID();
    const created = createAIRequest(db, id, {
      projectId,
      findingId,
      provider: "openai-compatible",
      model: "gpt-test",
      operationType: "explain-finding",
      estimatedTokens: 42,
    });

    expect(created.status).toBe("pending");
    expect(getAIRequestById(db, id)).toMatchObject({ finding_id: findingId, status: "pending" });
  });

  it("marks a request succeeded and records its response content", () => {
    const requestId = randomUUID();
    createAIRequest(db, requestId, {
      projectId,
      findingId,
      provider: "openai-compatible",
      model: "gpt-test",
      operationType: "explain-finding",
      estimatedTokens: 42,
    });

    markAIRequestStatus(db, requestId, "succeeded");
    createAIResponse(db, randomUUID(), {
      aiRequestId: requestId,
      estimatedTokens: 12,
      latencyMs: 250,
      success: true,
      content: "This finding matters because...",
    });

    expect(getAIRequestById(db, requestId)!.status).toBe("succeeded");

    const latest = getLatestSuccessfulResponse(db, findingId, "explain-finding");
    expect(latest?.content).toBe("This finding matters because...");
    expect(latest?.provider).toBe("openai-compatible");
    expect(latest?.model).toBe("gpt-test");
  });

  it("does not return a failed response as the latest successful one", () => {
    const requestId = randomUUID();
    createAIRequest(db, requestId, {
      projectId,
      findingId,
      provider: "openai-compatible",
      model: "gpt-test",
      operationType: "explain-finding",
      estimatedTokens: 42,
    });
    markAIRequestStatus(db, requestId, "failed");
    createAIResponse(db, randomUUID(), {
      aiRequestId: requestId,
      estimatedTokens: null,
      latencyMs: 50,
      success: false,
      content: "unreachable: connection refused",
    });

    expect(getLatestSuccessfulResponse(db, findingId, "explain-finding")).toBeUndefined();
  });

  it("returns the most recent successful response when there are several", () => {
    for (const content of ["first explanation", "second explanation"]) {
      const requestId = randomUUID();
      createAIRequest(db, requestId, {
        projectId,
        findingId,
        provider: "openai-compatible",
        model: "gpt-test",
        operationType: "explain-finding",
        estimatedTokens: 10,
      });
      markAIRequestStatus(db, requestId, "succeeded");
      createAIResponse(db, randomUUID(), {
        aiRequestId: requestId,
        estimatedTokens: 5,
        latencyMs: 10,
        success: true,
        content,
      });
    }

    expect(getLatestSuccessfulResponse(db, findingId, "explain-finding")?.content).toBe("second explanation");
  });

  it("keeps test_run_id-keyed accounting rows (Phase 20) independent of finding_id-keyed ones", () => {
    const run = saveTestRun(db, randomUUID(), projectId, {
      supported: true,
      framework: "vitest",
      command: "vitest run",
      exitCode: 1,
      durationMs: 100,
      stdout: "FAIL",
      stderr: "",
      passed: 0,
      failed: 1,
      skipped: 0,
      timedOut: false,
    });

    const requestId = randomUUID();
    const created = createAIRequest(db, requestId, {
      projectId,
      findingId: null,
      testRunId: run.id,
      provider: "openai-compatible",
      model: "gpt-test",
      operationType: "failure-diagnosis",
      estimatedTokens: 20,
    });
    expect(created.test_run_id).toBe(run.id);
    expect(created.finding_id).toBeNull();

    markAIRequestStatus(db, requestId, "succeeded");
    createAIResponse(db, randomUUID(), {
      aiRequestId: requestId,
      estimatedTokens: 8,
      latencyMs: 30,
      success: true,
      content: "LIKELY_CAUSE:\nsomething broke.",
    });

    const stored = getLatestSuccessfulResponseForTestRun(db, run.id, "failure-diagnosis");
    expect(stored?.content).toContain("something broke");

    // A finding-keyed lookup with the same operation_type must not see this row.
    expect(getLatestSuccessfulResponse(db, findingId, "failure-diagnosis")).toBeUndefined();
  });

  it("keeps patch_id-keyed accounting rows (Phase 21) independent per patch, even for the same finding", () => {
    const patchAId = randomUUID();
    createPatch(db, patchAId, { projectId, findingId, description: null });
    const patchB_Id = randomUUID();
    createPatch(db, patchB_Id, { projectId, findingId, description: null });

    for (const [patchId, content] of [
      [patchAId, "CORRECTNESS: pass - fine for A."],
      [patchB_Id, "CORRECTNESS: fail - wrong for B."],
    ] as const) {
      const requestId = randomUUID();
      const created = createAIRequest(db, requestId, {
        projectId,
        findingId,
        patchId,
        provider: "openai-compatible",
        model: "gpt-test",
        operationType: "patch-self-review",
        estimatedTokens: 15,
      });
      expect(created.patch_id).toBe(patchId);
      markAIRequestStatus(db, requestId, "succeeded");
      createAIResponse(db, randomUUID(), {
        aiRequestId: requestId,
        estimatedTokens: 6,
        latencyMs: 20,
        success: true,
        content,
      });
    }

    expect(getLatestSuccessfulResponseForPatch(db, patchAId, "patch-self-review")?.content).toContain("fine for A");
    expect(getLatestSuccessfulResponseForPatch(db, patchB_Id, "patch-self-review")?.content).toContain("wrong for B");
  });
});
