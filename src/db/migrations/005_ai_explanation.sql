

ALTER TABLE ai_request ADD COLUMN finding_id TEXT REFERENCES finding(id) ON DELETE CASCADE;
ALTER TABLE ai_response ADD COLUMN content TEXT;
