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
import { generateTest, parseGeneratedTest, GENERATE_TEST_OPERATION_TYPE } from "../src/ai/workflows/generateTest.js";
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

const A_TEST_RESPONSE =
  "TARGET_PATH:\nsrc/a.test.ts\n\nTEST_CODE:\nimport { describe, it, expect } from \"vitest\";\n\ndescribe(\"a\", () => {\n  it(\"does not hardcode a secret\", () => {\n    expect(true).toBe(true);\n  });\n});\n";

describe("parseGeneratedTest", () => {
  it("splits a well-formed response into target path and test code", () => {
    const data = parseGeneratedTest(A_TEST_RESPONSE);
    expect(data.targetPath).toBe("src/a.test.ts");
    expect(data.testCode).toContain('describe("a"');
    expect(data.testCode).toContain("expect(true).toBe(true);");
  });

  it("returns null fields for a NO_TEST response, preserving the raw text", () => {
    const raw = "NO_TEST: the behavior can't be tested without a live network call.";
    const data = parseGeneratedTest(raw);
    expect(data.targetPath).toBeNull();
    expect(data.testCode).toBeNull();
    expect(data.raw).toBe(raw);
  });

  it("strips a single wrapping markdown code fence from TEST_CODE", () => {
    const raw = "TARGET_PATH:\nsrc/b.test.ts\n\nTEST_CODE:\n```typescript\nexport const x = 1;\n```\n";
    const data = parseGeneratedTest(raw);
    expect(data.testCode).toBe("export const x = 1;");
  });

  it("leaves testCode null (not fabricated) when TEST_CODE is missing entirely", () => {
    const raw = "TARGET_PATH:\nsrc/c.test.ts\n";
    const data = parseGeneratedTest(raw);
    expect(data.targetPath).toBe("src/c.test.ts");
    expect(data.testCode).toBeNull();
  });
});

describe("generateTest", () => {
  let tmpDbDir: string;
  let db: DB;
  let repoRoot: string;

  afterEach(() => {
    db?.close();
    if (tmpDbDir) fs.rmSync(tmpDbDir, { recursive: true, force: true });
    if (repoRoot) cleanupRepo(repoRoot);
  });

  function setup() {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-generatetest-test-"));
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

  it("returns the parsed target path and test code, persists a successful accounting record, and reports no prior fix plan was used", async () => {
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
            choices: [{ message: { content: A_TEST_RESPONSE }, finish_reason: "stop" }],
            usage: { prompt_tokens: 70, completion_tokens: 30 },
          })
        );
      });
    });

    try {
      const result = await generateTest({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      expect(result.data.targetPath).toBe("src/a.test.ts");
      expect(result.data.testCode).toContain("describe(");
      expect(result.usedFixPlan).toBe(false);

      const sentText = JSON.stringify(receivedBody);
      expect(sentText).not.toContain("verysecretvalue1234");

      const requestRow = getAIRequestById(db, result.requestId);
      expect(requestRow?.status).toBe("succeeded");
      expect(requestRow?.finding_id).toBe(findingId);

      const stored = getLatestSuccessfulResponse(db, findingId, GENERATE_TEST_OPERATION_TYPE);
      expect(stored?.content).toBe(A_TEST_RESPONSE);
    } finally {
      await close();
    }
  });

  it("folds a prior fix plan's Required Tests section into the prompt as grounding when one exists", async () => {
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
                    "PROBLEM:\nHardcoded secret.\n\nROOT CAUSE:\nPasted during testing.\n\nFILES AFFECTED:\n- src/a.ts\n\nPROPOSED CHANGES:\nUse an env var.\n\nRISKS:\nNone significant.\n\nREQUIRED TESTS:\nAssert the source file never contains the literal secret string.\n\nVALIDATION STRATEGY:\nGrep for the literal.",
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
    const { url: testUrl, close: closeTest } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        receivedBody = JSON.parse(body);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: A_TEST_RESPONSE }, finish_reason: "stop" }],
            usage: { prompt_tokens: 70, completion_tokens: 30 },
          })
        );
      });
    });

    try {
      const result = await generateTest({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: testUrl, model: "gpt-test", apiKey: null },
      });

      expect(result.usedFixPlan).toBe(true);
      const sentText = JSON.stringify(receivedBody);
      expect(sentText).toContain('Required tests\\" section');
      expect(sentText).toContain("Assert the source file never contains the literal secret string.");
    } finally {
      await closeTest();
    }
  });

  it("preserves a NO_TEST response verbatim rather than treating it as an error", async () => {
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
            choices: [{ message: { content: "NO_TEST: the finding concerns build configuration, not testable runtime behavior." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 15 },
          })
        );
      });
    });

    try {
      const result = await generateTest({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      expect(result.data.targetPath).toBeNull();
      expect(result.data.testCode).toBeNull();
      expect(result.data.raw).toBe("NO_TEST: the finding concerns build configuration, not testable runtime behavior.");
    } finally {
      await close();
    }
  });
});
