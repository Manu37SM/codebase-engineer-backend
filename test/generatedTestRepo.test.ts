import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, DB } from "../src/db/index.js";
import { createProject } from "../src/db/projectRepo.js";
import { replaceProjectFindings } from "../src/db/findingRepo.js";
import { saveTestRun } from "../src/db/testRunRepo.js";
import {
  createGeneratedTest,
  createGeneratedTestReview,
  getGeneratedTestById,
  listGeneratedTestsForFinding,
  listReviewsForGeneratedTest,
  setGeneratedTestContent,
  setGeneratedTestRunResult,
  updateGeneratedTestStatus,
} from "../src/db/generatedTestRepo.js";

describe("generatedTestRepo", () => {
  let tmpDir: string;
  let db: DB;
  let projectId: string;
  let findingId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-generatedtest-repo-test-"));
    db = openDatabase(path.join(tmpDir, "test.db"));
    projectId = randomUUID();
    createProject(db, projectId, "test-project", "/tmp/test-project-" + randomUUID(), null);
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

  it("creates a generated test with no content yet, in pending_approval status", () => {
    const id = randomUUID();
    const gt = createGeneratedTest(db, id, { projectId, findingId, description: "Cover the secret finding" });
    expect(gt.status).toBe("pending_approval");
    expect(gt.target_path).toBeNull();
    expect(gt.test_code).toBeNull();
    expect(gt.test_run_id).toBeNull();
    expect(gt.description).toBe("Cover the secret finding");
  });

  it("moves through pending_approval -> approved -> proposed as the caller sets content", () => {
    const id = randomUUID();
    createGeneratedTest(db, id, { projectId, findingId, description: null });

    updateGeneratedTestStatus(db, id, "approved");
    expect(getGeneratedTestById(db, id)!.status).toBe("approved");

    setGeneratedTestContent(db, id, "src/a.test.ts", "describe('a', () => {});", "proposed");
    const proposed = getGeneratedTestById(db, id)!;
    expect(proposed.status).toBe("proposed");
    expect(proposed.target_path).toBe("src/a.test.ts");
    expect(proposed.test_code).toContain("describe");
  });

  it("records a real write-and-run outcome linked to a real test_run row", () => {
    const id = randomUUID();
    createGeneratedTest(db, id, { projectId, findingId, description: null });
    setGeneratedTestContent(db, id, "src/a.test.ts", "describe('a', () => {});", "proposed");
    updateGeneratedTestStatus(db, id, "approved_for_write");

    const testRunId = randomUUID();
    saveTestRun(db, testRunId, projectId, {
      supported: true,
      framework: "vitest",
      command: "npm test",
      exitCode: 0,
      durationMs: 120,
      stdout: "1 passed",
      stderr: "",
      passed: 1,
      failed: 0,
      skipped: 0,
      timedOut: false,
    });

    setGeneratedTestRunResult(db, id, "passed", testRunId);
    const final = getGeneratedTestById(db, id)!;
    expect(final.status).toBe("passed");
    expect(final.test_run_id).toBe(testRunId);
  });

  it("lists generated tests for a finding, most recent first", () => {
    const first = randomUUID();
    createGeneratedTest(db, first, { projectId, findingId, description: "first attempt" });
    const second = randomUUID();
    createGeneratedTest(db, second, { projectId, findingId, description: "second attempt" });

    const tests = listGeneratedTestsForFinding(db, findingId);
    expect(tests.map((t) => t.id)).toEqual([second, first]);
  });

  it("records a review decision and lists it back", () => {
    const id = randomUUID();
    createGeneratedTest(db, id, { projectId, findingId, description: null });

    const review = createGeneratedTestReview(db, randomUUID(), {
      generatedTestId: id,
      decision: "approved_for_generation",
      reviewerNote: "Sounds reasonable",
    });
    expect(review.decision).toBe("approved_for_generation");

    const reviews = listReviewsForGeneratedTest(db, id);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reviewer_note).toBe("Sounds reasonable");
  });
});
