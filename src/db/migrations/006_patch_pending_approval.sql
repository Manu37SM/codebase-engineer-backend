

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
