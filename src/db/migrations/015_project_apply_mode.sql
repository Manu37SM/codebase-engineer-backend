-- Task #90: a per-project setting controlling what "/apply" does with an
-- approved patch — write it straight to the project's real files on disk
-- ("direct", the existing/default behavior, unchanged for every project
-- that predates this migration), or package the patched file(s) into a
-- downloadable zip instead, so someone can review/test the change by hand
-- before it ever touches their working tree. A simple ADD COLUMN with a
-- constant default is safe here — same reasoning as migration 007's
-- `patch.apply_error` — no existing constraint is relaxed, so no rebuild.
ALTER TABLE project ADD COLUMN apply_mode TEXT NOT NULL DEFAULT 'direct';
