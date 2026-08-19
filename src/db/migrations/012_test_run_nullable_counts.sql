-- Migration 012: allow test_run.passed/failed/skipped to be NULL
--
-- 001_init.sql declared these as `INTEGER NOT NULL DEFAULT 0`. That default
-- turned out to be a real honesty bug: `testRunRepo.ts`'s `saveTestRun()`
-- stores `outcome.passed ?? 0` (etc.), so whenever the test-count parser
-- genuinely doesn't recognize a project's test framework (e.g. Node's
-- built-in `node --test` runner before this same change added a parser for
-- it — see parse.ts/detect.ts), a real, successful test run with unknown
-- counts got silently persisted and displayed as "0 passed / 0 failed / 0
-- skipped" — indistinguishable from a real zero, which this project's own
-- documented convention (see e.g. types.ts's LiveFinding/RootCauseAnalysis
-- comments: "never fabricated") says not to do. NULL is the honest value
-- for "we don't know"; the application layer (testRunRepo.ts, Tests.tsx)
-- is updated alongside this migration to store/render that distinction
-- instead of coercing to zero.
--
-- SQLite has no ALTER COLUMN to drop a NOT NULL/DEFAULT constraint, so this
-- uses the same rebuild-and-copy pattern as migration 006. `test_run` has
-- real rows in any project that has ever run tests, so — unlike 006's
-- empty-table case — this copies real data forward; existing rows' 0
-- values are copied as-is (there is no way to retroactively recover which
-- historical 0s were real vs. fabricated-from-null, which is an honestly
-- documented, accepted limitation of fixing this now rather than earlier).
CREATE TABLE test_run_new (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  framework TEXT,
  command TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  passed INTEGER,
  failed INTEGER,
  skipped INTEGER,
  stdout_ref TEXT,
  stderr_ref TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'unknown',
  reason TEXT
);

INSERT INTO test_run_new (id, project_id, framework, command, exit_code, duration_ms, passed, failed, skipped, stdout_ref, stderr_ref, started_at, status, reason)
  SELECT id, project_id, framework, command, exit_code, duration_ms, passed, failed, skipped, stdout_ref, stderr_ref, started_at, status, reason FROM test_run;

DROP TABLE test_run;
ALTER TABLE test_run_new RENAME TO test_run;
