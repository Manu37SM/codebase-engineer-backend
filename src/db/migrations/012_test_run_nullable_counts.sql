

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
