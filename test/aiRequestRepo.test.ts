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
  markAIRequestStatus,
} from "../src/db/aiRequestRepo.js";

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
});
