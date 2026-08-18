-- Phase 19: AI test generation. Two new tables, both purely additive
-- (fresh CREATE TABLE, nothing existing altered) — no rebuild, no FK
-- toggling needed, unlike migration 006.
--
-- generated_test mirrors the two-gate shape of patch/patch_review
-- (Phases 17-18): pending_approval -> approved -> proposed (has real
-- test_code + target_path) -> approved_for_write -> written/passed/
-- failed_tests, or rejected at either gate. test_run_id links to the
-- real test_run row (Phase 9's existing test runner) produced by
-- actually executing the suite after writing the generated test to
-- disk — "reviewed & executed, not trusted on compile alone" per
-- docs/AI_MODE.md §1.
CREATE TABLE IF NOT EXISTS generated_test (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  finding_id TEXT REFERENCES finding(id) ON DELETE SET NULL,
  target_path TEXT,
  description TEXT,
  test_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  test_run_id TEXT REFERENCES test_run(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS generated_test_review (
  id TEXT PRIMARY KEY,
  generated_test_id TEXT NOT NULL REFERENCES generated_test(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  reviewer_note TEXT,
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);
