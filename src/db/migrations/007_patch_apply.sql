-- Phase 18: adds a column to record why applying a patch to disk failed,
-- for the 'failed' status in docs/ARCHITECTURE.md §3's patch.status enum
-- (proposed|approved|rejected|applied|failed). A simple ADD COLUMN is safe
-- here — unlike migration 006, this doesn't relax an existing constraint,
-- so no table rebuild (and none of migration 006's FK-cascade risk) is
-- needed.
ALTER TABLE patch ADD COLUMN apply_error TEXT;
