-- Local auth (Task #80). Additive and inert until used: with zero rows in
-- `user`, the app's own route guard (see backend/src/auth/guard.ts, wired
-- in app.ts) treats the instance as "open" — every existing route behaves
-- exactly as it did before this migration, matching this product's
-- self-hosted/local-first design (docs/PRD.md §7) and the same opt-in
-- pattern already used for billing (migration 011): the feature does
-- nothing until a real user explicitly turns it on, here by registering
-- the first account.
--
-- `password_hash` is nullable — an account created purely via Google/GitHub
-- OAuth (see `oauth_identity` below) never has a local password, and must
-- not be forced to invent one just to satisfy a NOT NULL constraint.
CREATE TABLE IF NOT EXISTS user (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  -- scrypt hash, format "<saltHex>:<hashHex>" — see backend/src/auth/password.ts.
  -- Never the raw/plaintext password.
  password_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per active login session. `token_hash` stores SHA-256 of the
-- real session token, never the token itself — mirrors how the token
-- would need to be looked up anyway (hash the incoming cookie, compare),
-- and means a raw DB read (e.g. a backup file) can't be replayed as a
-- live session. `expires_at` is enforced at the application layer
-- (backend/src/auth/session.ts), not by SQLite itself.
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_user_id ON session(user_id);

-- One row per linked OAuth identity (Google or GitHub — Tasks #82/#83).
-- A `user` can have zero, one, or both linked; `provider` + `provider_user_id`
-- is the real external identity, `email` is a cached copy from the
-- provider (not authoritative — `user.email` is what the app trusts).
-- `access_token_enc`/`refresh_token_enc` are AES-256-GCM-encrypted at rest
-- (backend/src/auth/crypto.ts) using a key derived from
-- AUTH_TOKEN_ENCRYPTION_KEY (see .env.example) — GitHub's token in
-- particular is a real credential capable of reading the user's private
-- repos (Task #84), so it gets the same "never store secrets in plaintext"
-- treatment as everything else in this codebase (docs/SECURITY.md).
CREATE TABLE IF NOT EXISTS oauth_identity (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github')),
  provider_user_id TEXT NOT NULL,
  email TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS idx_oauth_identity_user_id ON oauth_identity(user_id);
