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
import { planFix, parseFixPlanSections, FIX_PLAN_OPERATION_TYPE } from "../src/ai/workflows/fixPlan.js";
import { analyzeRootCause } from "../src/ai/workflows/rootCauseAnalysis.js";
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

const FULL_PLAN_TEXT =
  "PROBLEM:\nAn API key is hardcoded in source.\n\n" +
  "ROOT CAUSE:\nA real credential was pasted during testing and never removed.\n\n" +
  "FILES AFFECTED:\n- src/a.ts\n\n" +
  "PROPOSED CHANGES:\nMove the key to an environment variable and read it via process.env.\n\n" +
  "RISKS:\nIf the env var isn't set in every environment, the app could fail to start.\n\n" +
  "REQUIRED TESTS:\nAdd a test asserting the app fails fast with a clear error when the env var is missing.\n\n" +
  "VALIDATION STRATEGY:\nA reviewer should confirm no hardcoded secret remains anywhere in the diff.";

describe("parseFixPlanSections", () => {
  it("parses all seven sections from a well-formed response", () => {
    const plan = parseFixPlanSections(FULL_PLAN_TEXT);
    expect(plan.problem).toBe("An API key is hardcoded in source.");
    expect(plan.rootCause).toBe("A real credential was pasted during testing and never removed.");
    expect(plan.filesAffected).toEqual(["src/a.ts"]);
    expect(plan.proposedChanges).toBe("Move the key to an environment variable and read it via process.env.");
    expect(plan.risks).toBe("If the env var isn't set in every environment, the app could fail to start.");
    expect(plan.requiredTests).toBe(
      "Add a test asserting the app fails fast with a clear error when the env var is missing."
    );
    expect(plan.validationStrategy).toBe("A reviewer should confirm no hardcoded secret remains anywhere in the diff.");
    expect(plan.raw).toBe(FULL_PLAN_TEXT);
  });

  it("leaves every field null (never fabricated) when the response doesn't follow the format, but preserves raw", () => {
    const raw = "I would just rename the variable.";
    const plan = parseFixPlanSections(raw);
    expect(plan.problem).toBeNull();
    expect(plan.rootCause).toBeNull();
    expect(plan.filesAffected).toBeNull();
    expect(plan.proposedChanges).toBeNull();
    expect(plan.risks).toBeNull();
    expect(plan.requiredTests).toBeNull();
    expect(plan.validationStrategy).toBeNull();
    expect(plan.raw).toBe(raw);
  });

  it("stops PROBLEM at ROOT CAUSE even when several middle headers are skipped", () => {
    const raw = "PROBLEM:\nSomething is wrong.\n\nVALIDATION STRATEGY:\nCheck it manually.";
    const plan = parseFixPlanSections(raw);
    expect(plan.problem).toBe("Something is wrong.");
    expect(plan.rootCause).toBeNull();
    expect(plan.validationStrategy).toBe("Check it manually.");
  });
});

describe("planFix", () => {
  let tmpDbDir: string;
  let db: DB;
  let repoRoot: string;

  afterEach(() => {
    db?.close();
    if (tmpDbDir) fs.rmSync(tmpDbDir, { recursive: true, force: true });
    if (repoRoot) cleanupRepo(repoRoot);
  });

  function setup() {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-fixplan-test-"));
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

  it("builds a full plan, persists a successful accounting record, and reports no prior root-cause analysis was used", async () => {
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
            choices: [{ message: { content: FULL_PLAN_TEXT }, finish_reason: "stop" }],
            usage: { prompt_tokens: 60, completion_tokens: 40 },
          })
        );
      });
    });

    try {
      const result = await planFix({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      expect(result.plan.filesAffected).toEqual(["src/a.ts"]);
      expect(result.plan.proposedChanges).toContain("environment variable");
      expect(result.usedPriorRootCauseAnalysis).toBe(false);

      const sentText = JSON.stringify(receivedBody);
      expect(sentText).not.toContain("verysecretvalue1234");
      expect(sentText).not.toContain("A previous root-cause analysis");

      const requestRow = getAIRequestById(db, result.requestId);
      expect(requestRow?.status).toBe("succeeded");
      expect(requestRow?.finding_id).toBe(findingId);

      const stored = getLatestSuccessfulResponse(db, findingId, FIX_PLAN_OPERATION_TYPE);
      expect(stored?.content).toBe(FULL_PLAN_TEXT);
    } finally {
      await close();
    }
  });

  it("folds a prior successful root-cause analysis into the prompt as grounding when one exists", async () => {
    setup();
    const { projectId, finding } = seedFinding();

    const { url: rootCauseUrl, close: closeRootCause } = await startServer((req, res) => {
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
                  content: "EVIDENCE:\n- literal secret\n\nINFERENCE:\nPasted during testing.\n\nCONFIDENCE: high",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 10 },
          })
        );
      });
    });
    await analyzeRootCause({
      db,
      projectId,
      projectRoot: repoRoot,
      finding,
      files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
      providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: rootCauseUrl, model: "gpt-test", apiKey: null },
    });
    await closeRootCause();

    let receivedBody: any;
    const { url: planUrl, close: closePlan } = await startServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        receivedBody = JSON.parse(body);
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
      const result = await planFix({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: planUrl, model: "gpt-test", apiKey: null },
      });

      expect(result.usedPriorRootCauseAnalysis).toBe(true);
      const sentText = JSON.stringify(receivedBody);
      expect(sentText).toContain("A previous root-cause analysis");
      expect(sentText).toContain("Pasted during testing");
    } finally {
      await closePlan();
    }
  });
});
