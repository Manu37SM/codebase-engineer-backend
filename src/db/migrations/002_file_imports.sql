-- Migration 002: add imports column to file table (Phase 3 — Repository Indexing)
ALTER TABLE file ADD COLUMN imports TEXT;
