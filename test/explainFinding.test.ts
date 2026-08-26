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
import { getAIRequestById, getLatestSuccessfulResponse } from "../src/db/aiRequestRepo.js";
import { explainFinding, EXPLAIN_FINDING_OPERATION_TYPE } from "../src/ai/workflows/explainFinding.js";
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

describe("explainFinding", () => {
  let tmpDbDir: string;
  let db: DB;
  let repoRoot: string;

  afterEach(() => {
    db?.close();
    if (tmpDbDir) fs.rmSync(tmpDbDir, { recursive: true, force: true });
    if (repoRoot) cleanupRepo(repoRoot);
  });

  function setup() {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-explain-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    repoRoot = makeTempRepo();
  }

  it("sends a real completion request built from the context bundle, and persists a successful accounting record", async () => {
    setup();
    writeFile(repoRoot, "src/a.ts", 'const apiKey = "sk-verysecretvalue1234";\nexport const x = 1;\n');

    const projectId = randomUUID();
    createProject(db, projectId, "test-project", repoRoot, null);

    const findingId = randomUUID();
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
    const finding = getFindingById(db, findingId)!;

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
            choices: [{ message: { content: "This matters because a secret is hardcoded." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 40, completion_tokens: 10 },
          })
        );
      });
    });

    try {
      const result = await explainFinding({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      expect(result.explanation).toBe("This matters because a secret is hardcoded.");
      expect(result.usage).toEqual({ promptTokens: 40, completionTokens: 10 });

      const sentText = JSON.stringify(receivedBody);
      expect(sentText).not.toContain("verysecretvalue1234");
      expect(sentText).toContain("hardcoded-secret");

      const requestRow = getAIRequestById(db, result.requestId);
      expect(requestRow?.status).toBe("succeeded");
      expect(requestRow?.finding_id).toBe(findingId);

      const stored = getLatestSuccessfulResponse(db, findingId, EXPLAIN_FINDING_OPERATION_TYPE);
      expect(stored?.content).toBe("This matters because a secret is hardcoded.");
    } finally {
      await close();
    }
  });

  it("records a failed accounting row and rethrows when the provider errors", async () => {
    setup();
    writeFile(repoRoot, "src/a.ts", "export const x = 1;\n");

    const projectId = randomUUID();
    createProject(db, projectId, "test-project", repoRoot, null);

    const findingId = randomUUID();
    replaceProjectFindings(
      db,
      projectId,
      [
        {
          ruleId: "large-file",
          severity: "medium",
          category: "maintainability",
          filePath: "src/a.ts",
          lineStart: 1,
          lineEnd: 1,
          evidence: "1 line",
          explanation: "n/a",
          recommendation: "n/a",
        },
      ],
      () => findingId
    );
    const finding = getFindingById(db, findingId)!;

    const { url, close } = await startServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid api key" }));
    });

    try {
      await expect(
        explainFinding({
          db,
          projectId,
          projectRoot: repoRoot,
          finding,
          files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
          providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
        })
      ).rejects.toThrow();

      expect(getLatestSuccessfulResponse(db, findingId, EXPLAIN_FINDING_OPERATION_TYPE)).toBeUndefined();
    } finally {
      await close();
    }
  });
});
