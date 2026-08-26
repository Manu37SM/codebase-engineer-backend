import { createHash, randomBytes } from "node:crypto";
import type { DB } from "./index.js";

export interface UserRecord {
  id: string;
  email: string;
  display_name: string | null;
  password_hash: string | null;
  created_at: string;
}

export function countUsers(db: DB): number {
  return (db.prepare("SELECT COUNT(*) as count FROM user").get() as { count: number }).count;
}

export function createUser(
  db: DB,
  id: string,
  input: { email: string; displayName: string | null; passwordHash: string | null }
): UserRecord {
  db.prepare(
    `INSERT INTO user (id, email, display_name, password_hash) VALUES (?, ?, ?, ?)`
  ).run(id, input.email.toLowerCase(), input.displayName, input.passwordHash);
  return getUserById(db, id)!;
}

export function getUserById(db: DB, id: string): UserRecord | undefined {
  return db.prepare("SELECT * FROM user WHERE id = ?").get(id) as UserRecord | undefined;
}

export function getUserByEmail(db: DB, email: string): UserRecord | undefined {
  return db.prepare("SELECT * FROM user WHERE email = ?").get(email.toLowerCase()) as
    | UserRecord
    | undefined;
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; 

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(db: DB, id: string, userId: string): string {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO session (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`
  ).run(id, userId, hashToken(token), expiresAt);
  return token;
}

export interface SessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: string;
  expires_at: string;
}

export function getSessionByToken(db: DB, token: string): SessionRecord | undefined {
  const row = db
    .prepare("SELECT * FROM session WHERE token_hash = ?")
    .get(hashToken(token)) as SessionRecord | undefined;
  if (!row) return undefined;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    deleteSession(db, row.id);
    return undefined;
  }
  return row;
}

export function deleteSessionByToken(db: DB, token: string): void {
  db.prepare("DELETE FROM session WHERE token_hash = ?").run(hashToken(token));
}

export function deleteSession(db: DB, id: string): void {
  db.prepare("DELETE FROM session WHERE id = ?").run(id);
}

export function deleteExpiredSessions(db: DB): void {
  db.prepare("DELETE FROM session WHERE expires_at < datetime('now')").run();
}

export interface OauthIdentityRecord {
  id: string;
  user_id: string;
  provider: "google" | "github";
  provider_user_id: string;
  email: string | null;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  created_at: string;
}

export function getOauthIdentity(
  db: DB,
  provider: "google" | "github",
  providerUserId: string
): OauthIdentityRecord | undefined {
  return db
    .prepare("SELECT * FROM oauth_identity WHERE provider = ? AND provider_user_id = ?")
    .get(provider, providerUserId) as OauthIdentityRecord | undefined;
}

export function getOauthIdentityForUser(
  db: DB,
  userId: string,
  provider: "google" | "github"
): OauthIdentityRecord | undefined {
  return db
    .prepare("SELECT * FROM oauth_identity WHERE user_id = ? AND provider = ?")
    .get(userId, provider) as OauthIdentityRecord | undefined;
}

export function createOauthIdentity(
  db: DB,
  id: string,
  input: {
    userId: string;
    provider: "google" | "github";
    providerUserId: string;
    email: string | null;
    accessTokenEnc: string | null;
    refreshTokenEnc: string | null;
  }
): OauthIdentityRecord {
  db.prepare(
    `INSERT INTO oauth_identity (id, user_id, provider, provider_user_id, email, access_token_enc, refresh_token_enc)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.userId,
    input.provider,
    input.providerUserId,
    input.email,
    input.accessTokenEnc,
    input.refreshTokenEnc
  );
  return getOauthIdentityForUser(db, input.userId, input.provider)!;
}

export function updateOauthTokens(
  db: DB,
  id: string,
  accessTokenEnc: string | null,
  refreshTokenEnc: string | null
): void {
  db.prepare(
    "UPDATE oauth_identity SET access_token_enc = ?, refresh_token_enc = COALESCE(?, refresh_token_enc) WHERE id = ?"
  ).run(accessTokenEnc, refreshTokenEnc, id);
}
