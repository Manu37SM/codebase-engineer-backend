

ALTER TABLE ai_request ADD COLUMN test_run_id TEXT REFERENCES test_run(id) ON DELETE CASCADE;
