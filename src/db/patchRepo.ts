import type { DB } from "./index.js";

/**
 * Persistence for `patch`/`patch_review` (Phase 0 scaffold tables, empty
 * and unused until Phase 17 — the first phase to write anything that
 * could eventually change a file on disk). The patch lifecycle this
 * module supports is a real, persisted state machine per
 * docs/ARCHITECTURE.md §3 and docs/AI_MODE.md §4's two human-approval
 * gates ("Human Approval → Patch Generation" and "Diff Review → Human
 * Approval → Apply Patch"):
 *
 *   pending_approval --(approve)-------> approved --(generate)--> proposed
 *                     \-(reject)-------> rejected
 *
 *   proposed --(approve-apply)--> approved_for_apply --(apply)--> applied
 *            \-(reject-apply)---> rejected                    \-> failed
 *
 * `failed` can be retried via /apply again without re-approving (a diff
 * that failed to apply due to e.g. drift since generation doesn't need a
 * human to re-decide whether the *change* is a good idea — only whether
 * to retry the mechanical apply step, which /apply itself gates by
 * requiring a real dry-run success before touching any file).
 */

export interface PatchRecord {
  id: string;
  project_id: string;
  finding_id: string | null;
  description: string | null;
  diff_text: string | null;
  status: string;
  apply_error: string | null;
  created_at: string;
}

export interface PatchReviewRecord {
  id: string;
  patch_id: string;
  decision: string;
  reviewer_note: string | null;
  decided_at: string;
}

export function createPatch(
  db: DB,
  id: string,
  input: { projectId: string; findingId: string; description: string | null }
): PatchRecord {
  db.prepare(
    `INSERT INTO patch (id, project_id, finding_id, description, diff_text, status)
     VALUES (?, ?, ?, ?, NULL, 'pending_approval')`
  ).run(id, input.projectId, input.findingId, input.description);
  return getPatchById(db, id)!;
}

export function getPatchById(db: DB, id: string): PatchRecord | undefined {
  return db.prepare("SELECT * FROM patch WHERE id = ?").get(id) as PatchRecord | undefined;
}

export function listPatchesForFinding(db: DB, findingId: string): PatchRecord[] {
  return db
    .prepare("SELECT * FROM patch WHERE finding_id = ? ORDER BY created_at DESC, rowid DESC")
    .all(findingId) as PatchRecord[];
}

export interface PatchWithFindingContext extends PatchRecord {
  findingRuleId: string | null;
  findingFilePath: string | null;
  findingSeverity: string | null;
}

/**
 * Every patch for a project, across all findings — the real query behind
 * the Changes page (a unified review queue), as opposed to
 * `listPatchesForFinding` above, which only every existed scoped to a
 * single finding (the Findings page's inline per-finding patch list).
 * Left-joins `finding` (not an inner join) since a patch's finding can in
 * principle have been deleted independently — a patch should still show
 * up for review rather than silently vanishing from the queue.
 */
export function listPatchesForProject(db: DB, projectId: string): PatchWithFindingContext[] {
  return db
    .prepare(
      `SELECT patch.*,
              finding.rule_id AS findingRuleId,
              finding.file_path AS findingFilePath,
              finding.severity AS findingSeverity
       FROM patch
       LEFT JOIN finding ON finding.id = patch.finding_id
       WHERE patch.project_id = ?
       ORDER BY patch.created_at DESC, patch.rowid DESC`
    )
    .all(projectId) as PatchWithFindingContext[];
}

export function updatePatchStatus(db: DB, id: string, status: string): void {
  db.prepare("UPDATE patch SET status = ? WHERE id = ?").run(status, id);
}

export function setPatchDiff(db: DB, id: string, diffText: string, status: string): void {
  db.prepare("UPDATE patch SET diff_text = ?, status = ? WHERE id = ?").run(diffText, status, id);
}

/** Records the outcome of an actual apply-to-disk attempt (Phase 18). */
export function setPatchApplyResult(
  db: DB,
  id: string,
  status: "applied" | "failed",
  applyError: string | null
): void {
  db.prepare("UPDATE patch SET status = ?, apply_error = ? WHERE id = ?").run(status, applyError, id);
}

export function createPatchReview(
  db: DB,
  id: string,
  input: { patchId: string; decision: string; reviewerNote: string | null }
): PatchReviewRecord {
  db.prepare(
    `INSERT INTO patch_review (id, patch_id, decision, reviewer_note) VALUES (?, ?, ?, ?)`
  ).run(id, input.patchId, input.decision, input.reviewerNote);
  return db.prepare("SELECT * FROM patch_review WHERE id = ?").get(id) as PatchReviewRecord;
}

export function listReviewsForPatch(db: DB, patchId: string): PatchReviewRecord[] {
  return db
    .prepare("SELECT * FROM patch_review WHERE patch_id = ? ORDER BY decided_at ASC, rowid ASC")
    .all(patchId) as PatchReviewRecord[];
}
