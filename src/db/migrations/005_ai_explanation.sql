-- Migration 005: AI finding explanation (Phase 14)
--
-- The Phase 0 scaffold's ai_request/ai_response tables (see 001_init.sql)
-- were generic accounting placeholders with no room to store which target
-- a request was about or what the provider actually said back. Phase 14 is
-- the first real AI workflow, so this migration adds exactly what it needs:
-- ai_request.finding_id links a request to the Finding it explained (kept
-- nullable since docs/AI_MODE.md names other target kinds — TestRun,
-- refactor request — that aren't implemented yet and would need this same
-- column to stay nullable for them too); ai_response.content stores the
-- actual explanation text so a previously-generated explanation can be
-- shown again without re-calling the provider (and re-spending tokens).
ALTER TABLE ai_request ADD COLUMN finding_id TEXT REFERENCES finding(id) ON DELETE CASCADE;
ALTER TABLE ai_response ADD COLUMN content TEXT;
