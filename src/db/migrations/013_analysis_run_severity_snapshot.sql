-- Adds a per-run severity-count snapshot to `analysis_run`, for the
-- Dashboard/Audit "findings trend over time" chart (added alongside the
-- light/dark mode and Changes-page work).
--
-- Why this is needed at all: `finding` rows are wholesale replaced on every
-- analysis run (`replaceProjectFindings` deletes and reinserts), and
-- `finding` has no `analysis_run_id` column linking a row back to the run
-- that produced it. That means the *current* severity breakdown is always
-- derivable from `finding` directly, but a *historical* breakdown — "how
-- many high-severity findings did run #12 report, three weeks ago?" — is
-- not, once a later run has overwritten those rows. Rather than retrofit
-- `finding` with a run_id (a bigger, riskier change touching every finding
-- write path), this snapshots the four severity counts onto `analysis_run`
-- itself at the moment each run finishes — a single extra UPDATE in the
-- same place `finishAnalysisRun` already runs.
--
-- All four columns are nullable with NO DEFAULT, matching this project's
-- "never fabricate — null means unknown" convention (see migration 012 and
-- backend/src/db/testRunRepo.ts): every `analysis_run` row that existed
-- before this migration keeps these as NULL forever (there is no way to
-- reconstruct their historical severity breakdown — the findings that
-- produced it are long gone), and the trends chart must render those runs
-- as "unknown" rather than a fabricated zero. Only runs completed after
-- this migration ships get real counts.
ALTER TABLE analysis_run ADD COLUMN critical_count INTEGER;
ALTER TABLE analysis_run ADD COLUMN high_count INTEGER;
ALTER TABLE analysis_run ADD COLUMN medium_count INTEGER;
ALTER TABLE analysis_run ADD COLUMN low_count INTEGER;
