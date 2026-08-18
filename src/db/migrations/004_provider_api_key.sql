-- Migration 004: provider_configuration api_key column
-- `provider_configuration` was created (empty, unused) in 001_init.sql with
-- an `api_key_ref` column, on the assumption an external secret-reference
-- indirection would exist. This product has no external secrets manager —
-- the real API key has to live somewhere for the adapter to actually
-- authenticate with the provider. It's stored here, server-side, in this
-- product's local-only SQLite DB (per docs/SECURITY.md §7: "SQLite database
-- is local-only, stored under the application's data directory on the
-- user's machine"). `api_key_ref` is repurposed to hold a masked preview
-- (e.g. "sk-...ab12") for display; the raw `api_key` column is never
-- returned by any API response (see backend/src/routes/aiProviders.ts).

ALTER TABLE provider_configuration ADD COLUMN api_key TEXT;
