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
import { generatePatch, PATCH_GENERATION_OPERATION_TYPE } from "../src/ai/workflows/generatePatch.js";
import { planFix } from "../src/ai/workflows/fixPlan.js";
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

const A_DIFF = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-const apiKey = \"sk-verysecretvalue1234\";\n+const apiKey = process.env.API_KEY;\n export const x = 1;\n";

describe("generatePatch", () => {
  let tmpDbDir: string;
  let db: DB;
  let repoRoot: string;

  afterEach(() => {
    db?.close();
    if (tmpDbDir) fs.rmSync(tmpDbDir, { recursive: true, force: true });
    if (repoRoot) cleanupRepo(repoRoot);
  });

  function setup() {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-generatepatch-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    repoRoot = makeTempRepo();
  }

  function seedFinding() {
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
    return { projectId, findingId, finding: getFindingById(db, findingId)! };
  }

  it("returns the raw diff text unparsed, persists a successful accounting record, and reports no prior fix plan was used", async () => {
    setup();
    const { projectId, findingId, finding } = seedFinding();

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
            choices: [{ message: { content: A_DIFF }, finish_reason: "stop" }],
            usage: { prompt_tokens: 70, completion_tokens: 30 },
          })
        );
      });
    });

    try {
      const result = await generatePatch({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      expect(result.diffText).toBe(A_DIFF);
      expect(result.usedFixPlan).toBe(false);

      const sentText = JSON.stringify(receivedBody);
      expect(sentText).not.toContain("verysecretvalue1234");

      const requestRow = getAIRequestById(db, result.requestId);
      expect(requestRow?.status).toBe("succeeded");
      expect(requestRow?.finding_id).toBe(findingId);

      const stored = getLatestSuccessfulResponse(db, findingId, PATCH_GENERATION_OPERATION_TYPE);
      expect(stored?.content).toBe(A_DIFF);
    } finally {
      await close();
    }
  });

  it("folds a prior fix plan into the prompt as grounding when one exists", async () => {
    setup();
    const { projectId, finding } = seedFinding();

    const { url: planUrl, close: closePlan } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [
              {
                message: {
                  content:
                    "PROBLEM:\nHardcoded secret.\n\nROOT CAUSE:\nPasted during testing.\n\nFILES AFFECTED:\n- src/a.ts\n\nPROPOSED CHANGES:\nUse an env var.\n\nRISKS:\nNone significant.\n\nREQUIRED TESTS:\nNone new.\n\nVALIDATION STRATEGY:\nGrep for the literal.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          })
        );
      });
    });
    await planFix({
      db,
      projectId,
      projectRoot: repoRoot,
      finding,
      files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
      providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: planUrl, model: "gpt-test", apiKey: null },
    });
    await closePlan();

    let receivedBody: any;
    const { url: patchUrl, close: closePatch } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: A_DIFF }, finish_reason: "stop" }],
            usage: { prompt_tokens: 70, completion_tokens: 30 },
          })
        );
      });
    });

    try {
      const result = await generatePatch({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: patchUrl, model: "gpt-test", apiKey: null },
      });

      expect(result.usedFixPlan).toBe(true);
      const sentText = JSON.stringify(receivedBody);
      expect(sentText).toContain("A fix plan for this finding was already approved");
      expect(sentText).toContain("Use an env var");
    } finally {
      await closePatch();
    }
  });

  it("preserves a NO_PATCH response verbatim rather than treating it as an error", async () => {
    setup();
    const { projectId, finding } = seedFinding();

    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: "NO_PATCH: the fix requires a config change outside the shown code." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 15 },
          })
        );
      });
    });

    try {
      const result = await generatePatch({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      expect(result.diffText).toBe("NO_PATCH: the fix requires a config change outside the shown code.");
    } finally {
      await close();
    }
  });
});
