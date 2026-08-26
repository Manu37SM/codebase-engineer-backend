import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, DB } from "../src/db/index.js";
import { createProject } from "../src/db/projectRepo.js";
import { replaceProjectFindings } from "../src/db/findingRepo.js";
import {
  createPatch,
  createPatchReview,
  getPatchById,
  listPatchesForFinding,
  listReviewsForPatch,
  setPatchApplyResult,
  setPatchDiff,
  updatePatchStatus,
} from "../src/db/patchRepo.js";

describe("patchRepo", () => {
  let tmpDir: string;
  let db: DB;
  let projectId: string;
  let findingId: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-patch-repo-test-"));
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

  it("creates a patch with no diff yet, in pending_approval status", () => {
    const id = randomUUID();
    const patch = createPatch(db, id, { projectId, findingId, description: "Fix the secret" });
    expect(patch.status).toBe("pending_approval");
    expect(patch.diff_text).toBeNull();
    expect(patch.description).toBe("Fix the secret");
  });

  it("moves through pending_approval -> approved -> proposed as the caller updates status and sets the diff", () => {
    const id = randomUUID();
    createPatch(db, id, { projectId, findingId, description: null });

    updatePatchStatus(db, id, "approved");
    expect(getPatchById(db, id)!.status).toBe("approved");

    setPatchDiff(db, id, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n", "proposed");
    const final = getPatchById(db, id)!;
    expect(final.status).toBe("proposed");
    expect(final.diff_text).toContain("+new");
  });

  it("lists patches for a finding, most recent first", () => {
    const first = randomUUID();
    createPatch(db, first, { projectId, findingId, description: "first attempt" });
    const second = randomUUID();
    createPatch(db, second, { projectId, findingId, description: "second attempt" });

    const patches = listPatchesForFinding(db, findingId);
    expect(patches.map((p) => p.id)).toEqual([second, first]);
  });

  it("records a patch review decision and lists it back", () => {
    const patchId = randomUUID();
    createPatch(db, patchId, { projectId, findingId, description: null });

    const review = createPatchReview(db, randomUUID(), {
      patchId,
      decision: "approved_for_generation",
      reviewerNote: "Looks reasonable",
    });
    expect(review.decision).toBe("approved_for_generation");

    const reviews = listReviewsForPatch(db, patchId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0].reviewer_note).toBe("Looks reasonable");
  });

  it("moves through proposed -> approved_for_apply -> applied, recording the apply result", () => {
    const id = randomUUID();
    createPatch(db, id, { projectId, findingId, description: null });
    setPatchDiff(db, id, "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n", "proposed");

    createPatchReview(db, randomUUID(), { patchId: id, decision: "approved_for_apply", reviewerNote: null });
    updatePatchStatus(db, id, "approved_for_apply");
    expect(getPatchById(db, id)!.status).toBe("approved_for_apply");

    setPatchApplyResult(db, id, "applied", null);
    const final = getPatchById(db, id)!;
    expect(final.status).toBe("applied");
    expect(final.apply_error).toBeNull();
  });

  it("records a failed apply attempt with the real error, leaving the diff intact for a retry", () => {
    const id = randomUUID();
    createPatch(db, id, { projectId, findingId, description: null });
    const diff = "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
    setPatchDiff(db, id, diff, "proposed");
    updatePatchStatus(db, id, "approved_for_apply");

    setPatchApplyResult(db, id, "failed", "error: patch does not apply");
    const failed = getPatchById(db, id)!;
    expect(failed.status).toBe("failed");
    expect(failed.apply_error).toBe("error: patch does not apply");
    expect(failed.diff_text).toBe(diff); 
  });
});
