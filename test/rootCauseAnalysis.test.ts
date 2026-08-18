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
import { analyzeRootCause, parseRootCauseSections, ROOT_CAUSE_ANALYSIS_OPERATION_TYPE } from "../src/ai/workflows/rootCauseAnalysis.js";
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

describe("parseRootCauseSections", () => {
  it("parses a well-formed EVIDENCE/INFERENCE/CONFIDENCE response", () => {
    const raw =
      "EVIDENCE:\n" +
      "- Line 3 hardcodes an API key literal\n" +
      "- No environment variable is referenced anywhere in the file\n\n" +
      "INFERENCE:\n" +
      "The developer likely pasted a real key during local testing and never removed it before committing.\n\n" +
      "CONFIDENCE: high";

    const parsed = parseRootCauseSections(raw);
    expect(parsed.evidence).toEqual([
      "Line 3 hardcodes an API key literal",
      "No environment variable is referenced anywhere in the file",
    ]);
    expect(parsed.inference).toBe(
      "The developer likely pasted a real key during local testing and never removed it before committing."
    );
    expect(parsed.confidence).toBe("high");
    expect(parsed.raw).toBe(raw);
  });

  it("is case-insensitive on headers and confidence value", () => {
    const raw = "evidence:\n- a thing\n\ninference:\nSome cause.\n\nconfidence: MEDIUM";
    const parsed = parseRootCauseSections(raw);
    expect(parsed.evidence).toEqual(["a thing"]);
    expect(parsed.inference).toBe("Some cause.");
    expect(parsed.confidence).toBe("medium");
  });

  it("leaves fields null (never fabricated) when the response doesn't follow the format, but always preserves raw", () => {
    const raw = "I think this happens because the function is too long.";
    const parsed = parseRootCauseSections(raw);
    expect(parsed.evidence).toBeNull();
    expect(parsed.inference).toBeNull();
    expect(parsed.confidence).toBeNull();
    expect(parsed.raw).toBe(raw);
  });

  it("parses evidence and confidence even when inference is missing", () => {
    const raw = "EVIDENCE:\n- fact one\n\nCONFIDENCE: low";
    const parsed = parseRootCauseSections(raw);
    expect(parsed.evidence).toEqual(["fact one"]);
    expect(parsed.inference).toBeNull();
    expect(parsed.confidence).toBe("low");
  });
});

describe("analyzeRootCause", () => {
  let tmpDbDir: string;
  let db: DB;
  let repoRoot: string;

  afterEach(() => {
    db?.close();
    if (tmpDbDir) fs.rmSync(tmpDbDir, { recursive: true, force: true });
    if (repoRoot) cleanupRepo(repoRoot);
  });

  function setup() {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-rootcause-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    repoRoot = makeTempRepo();
  }

  it("sends a real completion request, parses the structured response, and persists a successful accounting record", async () => {
    setup();
    writeFile(repoRoot, "src/a.ts", 'const apiKey = "sk-verysecretvalue1234";\nexport const x = 1;\n');

    const projectId = randomUUID();
    createProject(db, projectId, "test-project", repoRoot);

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
            choices: [
              {
                message: {
                  content:
                    "EVIDENCE:\n- Line 1 hardcodes a value beginning with sk-\n\nINFERENCE:\nA real credential was likely committed by mistake.\n\nCONFIDENCE: high",
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
      const result = await analyzeRootCause({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      expect(result.analysis.evidence).toEqual(["Line 1 hardcodes a value beginning with sk-"]);
      expect(result.analysis.inference).toBe("A real credential was likely committed by mistake.");
      expect(result.analysis.confidence).toBe("high");
      expect(result.usage).toEqual({ promptTokens: 40, completionTokens: 15 });

      const sentText = JSON.stringify(receivedBody);
      expect(sentText).not.toContain("verysecretvalue1234");
      expect(sentText).toContain("EVIDENCE:");

      const requestRow = getAIRequestById(db, result.requestId);
      expect(requestRow?.status).toBe("succeeded");
      expect(requestRow?.finding_id).toBe(findingId);

      const stored = getLatestSuccessfulResponse(db, findingId, ROOT_CAUSE_ANALYSIS_OPERATION_TYPE);
      expect(stored?.content).toContain("CONFIDENCE: high");
    } finally {
      await close();
    }
  });

  it("keeps explain-finding and root-cause-analysis accounting rows independent for the same finding", async () => {
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

    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: "EVIDENCE:\n- x\n\nINFERENCE:\ny\n\nCONFIDENCE: low" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 5 },
          })
        );
      });
    });

    try {
      await analyzeRootCause({
        db,
        projectId,
        projectRoot: repoRoot,
        finding,
        files: [{ relativePath: "src/a.ts", language: "TypeScript", imports: [], isTest: false }],
        providerConfig: { id: "p1", name: "Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test", apiKey: null },
      });

      // No explain-finding call was ever made for this finding — its operation_type slot must stay empty.
      expect(getLatestSuccessfulResponse(db, findingId, "explain-finding")).toBeUndefined();
      expect(getLatestSuccessfulResponse(db, findingId, ROOT_CAUSE_ANALYSIS_OPERATION_TYPE)).toBeTruthy();
    } finally {
      await close();
    }
  });
});
