ALTER TABLE project ADD COLUMN user_id TEXT REFERENCES user(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_project_user_id ON project(user_id);

UPDATE project SET user_id = (SELECT id FROM user ORDER BY created_at ASC LIMIT 1)
WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM user);
