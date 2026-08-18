-- Migration 006: allow a patch to exist before it has a diff (Phase 17)
--
-- The Phase 0 scaffold's `patch` table (001_init.sql) required `diff_text
-- TEXT NOT NULL` — it assumed a patch row would only ever be created once
-- an AI-generated diff already existed. Phase 17 needs a patch row to
-- exist *before* generation, in a 'pending_approval' status, so the first
-- human-approval gate in docs/AI_MODE.md §4's workflow ("Human Approval →
-- Patch Generation") is a real, persisted, server-checkable state — not
-- just a boolean trusted from the same request that triggers generation.
-- SQLite has no ALTER COLUMN to drop a NOT NULL constraint, so this uses
-- the standard rebuild-and-copy pattern. The `patch`/`patch_review` tables
-- have been empty since Phase 0 (no phase before 17 ever wrote to them),
-- so there is no real data at risk — the copy step is included anyway for
-- the same honesty this project's other migrations follow: never assume
-- a table is empty just because it's expected to be.
CREATE TABLE patch_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  finding_id TEXT REFERENCES finding(id) ON DELETE SET NULL,
  description TEXT,
  diff_text TEXT,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO patch_new (id, project_id, finding_id, description, diff_text, status, created_at)
  SELECT id, project_id, finding_id, description, diff_text, status, created_at FROM patch;

DROP TABLE patch;
ALTER TABLE patch_new RENAME TO patch;
