import type { DB } from "./index.js";
import type { TestRunOutcome } from "../testrunner/run.js";

export interface TestRunRecord {
  id: string;
  project_id: string;
  framework: string | null;
  command: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  /** null means "ran, but this framework's output couldn't be parsed for counts" — never fabricated as 0. */
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  stdout_ref: string | null;
  stderr_ref: string | null;
  status: string;
  reason: string | null;
  started_at: string;
}

/**
 * Persists a completed test run. `stdout_ref`/`stderr_ref` hold the raw
 * captured output directly (not a pointer into a separate blob store) —
 * this product has no such store yet, and the schema's original "_ref"
 * naming was written speculatively in Phase 0 before this feature existed;
 * documented here rather than silently reinterpreted.
 */
export function saveTestRun(
  db: DB,
  id: string,
  projectId: string,
  outcome: TestRunOutcome
): TestRunRecord {
  const status = deriveStatus(outcome);
  db.prepare(
    `INSERT INTO test_run
      (id, project_id, framework, command, exit_code, duration_ms, passed, failed, skipped, stdout_ref, stderr_ref, status, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    projectId,
    outcome.framework,
    outcome.command,
    outcome.exitCode,
    outcome.durationMs,
    outcome.passed,
    outcome.failed,
    outcome.skipped,
    outcome.stdout,
    outcome.stderr,
    status,
    outcome.reason ?? null
  );
  return getTestRun(db, id)!;
}

function deriveStatus(outcome: TestRunOutcome): string {
  if (!outcome.supported) return "unsupported";
  if (outcome.timedOut) return "timeout";
  if (outcome.exitCode === 0) return "passed";
  return "failed";
}

export function getTestRun(db: DB, id: string): TestRunRecord | undefined {
  return db.prepare("SELECT * FROM test_run WHERE id = ?").get(id) as TestRunRecord | undefined;
}

export function listTestRuns(db: DB, projectId: string, limit = 20): TestRunRecord[] {
  return db
    .prepare(
      "SELECT id, project_id, framework, command, exit_code, duration_ms, passed, failed, skipped, status, reason, started_at FROM test_run WHERE project_id = ? ORDER BY started_at DESC LIMIT ?"
    )
    .all(projectId, limit) as TestRunRecord[];
}

/** Deletes one run from the history. Only ever deletes the run row itself — the real test suite on disk is never touched. */
export function deleteTestRun(db: DB, id: string): void {
  db.prepare("DELETE FROM test_run WHERE id = ?").run(id);
}

/** Pro-tier "Delete all" on the Tests page's run history — clears every recorded run for a project. Returns how many rows were removed. */
export function deleteAllTestRuns(db: DB, projectId: string): number {
  const result = db.prepare("DELETE FROM test_run WHERE project_id = ?").run(projectId);
  return result.changes;
}
