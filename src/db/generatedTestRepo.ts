import type { DB } from "./index.js";

/**
 * Persistence for `generated_test`/`generated_test_review` (Phase 19).
 * Mirrors `patch`/`patch_review`'s (Phases 17-18) two-gate state machine
 * shape, since AI test generation has the same underlying risk profile —
 * writing something to disk based on an AI response — plus one extra step
 * patch generation doesn't have: actually executing what got written, per
 * docs/AI_MODE.md §1's "reviewed & executed, not trusted on compile
 * alone":
 *
 *   pending_approval --(approve)--------> approved --(generate)--> proposed
 *                     \-(reject)--------> rejected
 *
 *   proposed --(approve-write)--> approved_for_write --(write-and-run)--> written | passed | failed_tests
 *            \-(reject-write)---> rejected
 *
 * `written` means the file was created but the suite couldn't actually be
 * run (e.g. no supported test command detected) — an honest degrade, not
 * a failure of the write itself. `passed`/`failed_tests` mean the suite
 * really ran (via the existing Phase 9 test runner) after the file was
 * written; `test_run_id` links to that real, full `test_run` row (stdout/
 * stderr/counts), so nothing about the execution is re-invented here.
 */

export interface GeneratedTestRecord {
  id: string;
  project_id: string;
  finding_id: string | null;
  target_path: string | null;
  description: string | null;
  test_code: string | null;
  status: string;
  test_run_id: string | null;
  created_at: string;
}

export interface GeneratedTestReviewRecord {
  id: string;
  generated_test_id: string;
  decision: string;
  reviewer_note: string | null;
  decided_at: string;
}

export function createGeneratedTest(
  db: DB,
  id: string,
  input: { projectId: string; findingId: string; description: string | null }
): GeneratedTestRecord {
  db.prepare(
    `INSERT INTO generated_test (id, project_id, finding_id, target_path, description, test_code, status)
     VALUES (?, ?, ?, NULL, ?, NULL, 'pending_approval')`
  ).run(id, input.projectId, input.findingId, input.description);
  return getGeneratedTestById(db, id)!;
}

export function getGeneratedTestById(db: DB, id: string): GeneratedTestRecord | undefined {
  return db.prepare("SELECT * FROM generated_test WHERE id = ?").get(id) as GeneratedTestRecord | undefined;
}

export function listGeneratedTestsForFinding(db: DB, findingId: string): GeneratedTestRecord[] {
  return db
    .prepare("SELECT * FROM generated_test WHERE finding_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(findingId) as GeneratedTestRecord[];
}

export interface GeneratedTestWithFindingContext extends GeneratedTestRecord {
  findingRuleId: string | null;
  findingFilePath: string | null;
  findingSeverity: string | null;
}

/**
 * Every generated test for a project, across all findings — mirrors
 * `patchRepo.ts`'s `listPatchesForProject`, for the same Changes-page
 * unified review queue.
 */
export function listGeneratedTestsForProject(db: DB, projectId: string): GeneratedTestWithFindingContext[] {
  return db
    .prepare(
      `SELECT generated_test.*,
              finding.rule_id AS findingRuleId,
              finding.file_path AS findingFilePath,
              finding.severity AS findingSeverity
       FROM generated_test
       LEFT JOIN finding ON finding.id = generated_test.finding_id
       WHERE generated_test.project_id = ?
       ORDER BY generated_test.created_at DESC, generated_test.rowid DESC`
    )
    .all(projectId) as GeneratedTestWithFindingContext[];
}

export function updateGeneratedTestStatus(db: DB, id: string, status: string): void {
  db.prepare("UPDATE generated_test SET status = ? WHERE id = ?").run(status, id);
}

export function setGeneratedTestContent(
  db: DB,
  id: string,
  targetPath: string | null,
  testCode: string | null,
  status: string
): void {
  db.prepare("UPDATE generated_test SET target_path = ?, test_code = ?, status = ? WHERE id = ?").run(
    targetPath,
    testCode,
    status,
    id
  );
}

/** Records the outcome of actually writing the file and running the suite (Phase 19's "executed" step). */
export function setGeneratedTestRunResult(db: DB, id: string, status: string, testRunId: string | null): void {
  db.prepare("UPDATE generated_test SET status = ?, test_run_id = ? WHERE id = ?").run(status, testRunId, id);
}

export function createGeneratedTestReview(
  db: DB,
  id: string,
  input: { generatedTestId: string; decision: string; reviewerNote: string | null }
): GeneratedTestReviewRecord {
  db.prepare(
    `INSERT INTO generated_test_review (id, generated_test_id, decision, reviewer_note) VALUES (?, ?, ?, ?)`
  ).run(id, input.generatedTestId, input.decision, input.reviewerNote);
  return db.prepare("SELECT * FROM generated_test_review WHERE id = ?").get(id) as GeneratedTestReviewRecord;
}

export function listReviewsForGeneratedTest(db: DB, generatedTestId: string): GeneratedTestReviewRecord[] {
  return db
    .prepare("SELECT * FROM generated_test_review WHERE generated_test_id = ? ORDER BY decided_at ASC, rowid ASC")
    .all(generatedTestId) as GeneratedTestReviewRecord[];
}
