-- Migration 001: initial schema
-- Placeholder core tables per docs/ARCHITECTURE.md §3.
-- These are intentionally minimal for Phase 0/1 (scaffold verification only);
-- columns will be extended as each phase's feature is implemented.

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS repository_snapshot (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  languages TEXT,
  frameworks TEXT,
  build_system TEXT,
  package_managers TEXT,
  git_branch TEXT,
  working_tree_status TEXT,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS file (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  relative_path TEXT NOT NULL,
  language TEXT,
  loc INTEGER,
  size_bytes INTEGER,
  is_test INTEGER NOT NULL DEFAULT 0,
  is_generated INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT
);

CREATE TABLE IF NOT EXISTS finding (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  file_path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  evidence TEXT,
  explanation TEXT,
  recommendation TEXT,
  source TEXT NOT NULL DEFAULT 'deterministic',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS analysis_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  findings_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS test_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  framework TEXT,
  command TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  stdout_ref TEXT,
  stderr_ref TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_request (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  estimated_tokens INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_response (
  id TEXT PRIMARY KEY,
  ai_request_id TEXT NOT NULL REFERENCES ai_request(id) ON DELETE CASCADE,
  estimated_tokens INTEGER,
  latency_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS patch (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  finding_id TEXT REFERENCES finding(id) ON DELETE SET NULL,
  description TEXT,
  diff_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS patch_review (
  id TEXT PRIMARY KEY,
  patch_id TEXT NOT NULL REFERENCES patch(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  reviewer_note TEXT,
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_report (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scores TEXT,
  findings_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS provider_configuration (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  base_url TEXT,
  model TEXT,
  api_key_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
