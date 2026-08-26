import type { DB } from "./index.js";
import type { TestRunOutcome } from "../testrunner/run.js";

export interface TestRunRecord {
  id: string;
  project_id: string;
  framework: string | null;
  command: string | null;
  exit_code: number | null;
  duration_ms: number | null;

  passed: number | null;
  failed: number | null;
  skipped: number | null;
  stdout_ref: string | null;
  stderr_ref: string | null;
  status: string;
  reason: string | null;
  started_at: string;
}

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

export function deleteTestRun(db: DB, id: string): void {
  db.prepare("DELETE FROM test_run WHERE id = ?").run(id);
}

export function deleteAllTestRuns(db: DB, projectId: string): number {
  const result = db.prepare("DELETE FROM test_run WHERE project_id = ?").run(projectId);
  return result.changes;
}
