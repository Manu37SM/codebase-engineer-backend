import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { openDatabase, DB } from "../src/db/index.js";
import { createProject } from "../src/db/projectRepo.js";
import { saveTestRun, getTestRun } from "../src/db/testRunRepo.js";
import { getAIRequestById, getLatestSuccessfulResponseForTestRun } from "../src/db/aiRequestRepo.js";
import {
  diagnoseFailure,
  parseFailureDiagnosisSections,
  FAILURE_DIAGNOSIS_OPERATION_TYPE,
} from "../src/ai/workflows/diagnoseFailure.js";
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

describe("parseFailureDiagnosisSections", () => {
  it("parses a well-formed LIKELY_CAUSE/EVIDENCE/SUGGESTED_DIRECTION response", () => {
    const raw =
      "LIKELY_CAUSE:\n" +
      "The add() function returns the wrong sum because it subtracts instead of adds.\n\n" +
      "EVIDENCE:\n" +
      "- Assertion failure: expected 3 but got -1\n" +
      "- src/a.ts line 2 reads `return a - b;`\n\n" +
      "SUGGESTED_DIRECTION:\n" +
      "Fix the operator in add() to use + instead of -.";

    const parsed = parseFailureDiagnosisSections(raw);
    expect(parsed.likelyCause).toBe(
      "The add() function returns the wrong sum because it subtracts instead of adds."
    );
    expect(parsed.evidence).toEqual([
      "Assertion failure: expected 3 but got -1",
      "src/a.ts line 2 reads `return a - b;`",
    ]);
    expect(parsed.suggestedDirection).toBe("Fix the operator in add() to use + instead of -.");
    expect(parsed.raw).toBe(raw);
  });

  it("leaves fields null (never fabricated) when the response doesn't follow the format, but always preserves raw", () => {
    const raw = "The test failed because of a typo somewhere.";
    const parsed = parseFailureDiagnosisSections(raw);
    expect(parsed.likelyCause).toBeNull();
    expect(parsed.evidence).toBeNull();
    expect(parsed.suggestedDirection).toBeNull();
    expect(parsed.raw).toBe(raw);
  });
});

describe("diagnoseFailure", () => {
  let tmpDbDir: string;
  let db: DB;
  let repoRoot: string;

  afterEach(() => {
    db?.close();
    if (tmpDbDir) fs.rmSync(tmpDbDir, { recursive: true, force: true });
    if (repoRoot) cleanupRepo(repoRoot);
  });

  function setup() {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-diagnose-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    repoRoot = makeTempRepo();
  }

  it("sends a real completion request, parses the structured response, and persists a successful accounting record keyed by test_run_id", async () => {
    setup();
    writeFile(repoRoot, "src/a.ts", "export function add(a, b) { return a - b; }\n");
    writeFile(repoRoot, "src/a.test.ts", "import { add } from './a.js';\ntest('adds', () => expect(add(1, 2)).toBe(3));\n");

    const projectId = randomUUID();
    createProject(db, projectId, "test-project", repoRoot, null);

    const runId = randomUUID();
    const run = saveTestRun(db, runId, projectId, {
      supported: true,
      framework: "vitest",
      command: "vitest run",
      exitCode: 1,
      durationMs: 500,
      stdout: "FAIL src/a.test.ts\nAssertionError: expected -1 to be 3\n  at src/a.test.ts:2:33",
      stderr: "",
      passed: 0,
      failed: 1,
      skipped: 0,
      timedOut: false,
    });
    expect(run.status).toBe("failed");

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
            choices: [
              {
                message: {
                  content:
                    "LIKELY_CAUSE:\nadd() subtracts instead of adding.\n\nEVIDENCE:\n- expected -1 to be 3\n\nSUGGESTED_DIRECTION:\nFix the operator.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 40, completion_tokens: 15 },
          })
        );
      });
    });

    try {
      const result = await diagnoseFailure({
        db,
        projectId,
        projectRoot: repoRoot,
        testRun: run,
        files: [
          { relativePath: "src/a.ts", language: "JavaScript", imports: [], isTest: false },
          { relativePath: "src/a.test.ts", language: "JavaScript", imports: ["./a.js"], isTest: true },
        ],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      expect(result.diagnosis.likelyCause).toBe("add() subtracts instead of adding.");
      expect(result.diagnosis.evidence).toEqual(["expected -1 to be 3"]);
      expect(result.diagnosis.suggestedDirection).toBe("Fix the operator.");
      expect(result.usage).toEqual({ promptTokens: 40, completionTokens: 15 });

      const sentText = JSON.stringify(receivedBody);
      expect(sentText).toContain("AssertionError");
      expect(sentText).toContain("LIKELY_CAUSE:");

      const requestRow = getAIRequestById(db, result.requestId);
      expect(requestRow?.status).toBe("succeeded");
      expect(requestRow?.test_run_id).toBe(runId);
      expect(requestRow?.finding_id).toBeNull();

      const stored = getLatestSuccessfulResponseForTestRun(db, runId, FAILURE_DIAGNOSIS_OPERATION_TYPE);
      expect(stored?.content).toContain("SUGGESTED_DIRECTION:");
    } finally {
      await close();
    }
  });

  it("persists a failed accounting record (never throws silently) when the provider call fails", async () => {
    setup();
    writeFile(repoRoot, "src/a.ts", "export function add(a, b) { return a - b; }\n");

    const projectId = randomUUID();
    createProject(db, projectId, "test-project", repoRoot, null);

    const runId = randomUUID();
    const run = saveTestRun(db, runId, projectId, {
      supported: true,
      framework: "vitest",
      command: "vitest run",
      exitCode: 1,
      durationMs: 500,
      stdout: "FAIL src/a.test.ts",
      stderr: "",
      passed: 0,
      failed: 1,
      skipped: 0,
      timedOut: false,
    });

    const { url, close } = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });

    try {
      await expect(
        diagnoseFailure({
          db,
          projectId,
          projectRoot: repoRoot,
          testRun: run,
          files: [],
          providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
        })
      ).rejects.toThrow();

      expect(getLatestSuccessfulResponseForTestRun(db, runId, FAILURE_DIAGNOSIS_OPERATION_TYPE)).toBeUndefined();
    } finally {
      await close();
    }
  });
});
