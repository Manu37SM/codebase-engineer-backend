

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
