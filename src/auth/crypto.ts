import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * At-rest encryption for OAuth access/refresh tokens (Task #82/#83) —
 * AES-256-GCM via `node:crypto`, no extra dependency. A GitHub access
 * token in particular is a real, live credential capable of reading a
 * user's private repositories (Task #84), so it never touches
 * `oauth_identity.access_token_enc`/`refresh_token_enc` in plaintext,
 * matching this project's "secrets are never stored/logged in the clear"
 * convention (docs/SECURITY.md).
 *
 * The key is derived (via `scryptSync`, not used directly) from
 * `AUTH_TOKEN_ENCRYPTION_KEY` — see `.env.example`. Deliberately throws
 * rather than silently falling back to a hardcoded key when that env var
 * is unset: an OAuth flow that would need this only runs once a server
 * operator has actually configured OAuth (Google/GitHub client
 * id/secret) in the first place, so requiring the encryption key at that
 * same point is not a new barrier to the app's default, key-free
 * operation — the same "opt-in, never silently degrades security"
 * reasoning as `billing/config.ts`.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended IV length for GCM.

function deriveKey(): Buffer {
  const secret = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      "AUTH_TOKEN_ENCRYPTION_KEY is not set — required to store an OAuth token securely. " +
        "Set it before enabling Google/GitHub OAuth (see backend/.env.example and docs/AUTH.md)."
    );
  }
  // Fixed salt is acceptable here: this derives a single application-wide
  // key from one already-secret input, not a per-user password hash where
  // salt reuse would matter.
  return scryptSync(secret, "codebase-engineer-auth-token-key", 32);
}

/** Returns "<ivHex>:<authTagHex>:<ciphertextHex>". */
export function encryptToken(plain: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

export function decryptToken(stored: string): string {
  const key = deriveKey();
  const [ivHex, authTagHex, ciphertextHex] = stored.split(":");
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error("Malformed encrypted token.");
  }
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
