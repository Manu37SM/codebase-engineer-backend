-- Migration 003: test_run status/reason columns
-- The `test_run` table was created (empty, unused) in 001_init.sql as a
-- placeholder. Phase 9 (test runner) is the first feature to actually write
-- to it, and needs a status enum ('passed'|'failed'|'unsupported'|'timeout')
-- plus a human-readable reason for the 'unsupported' case (e.g. "no test
-- script defined") that the original placeholder schema didn't anticipate.

ALTER TABLE test_run ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE test_run ADD COLUMN reason TEXT;
