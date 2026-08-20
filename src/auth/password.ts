import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Password hashing for local accounts (Task #80) — Node's built-in
 * `scrypt`, not bcrypt/argon2, deliberately: this project already avoids
 * adding native-module dependencies unless there's no pure-JS/built-in
 * alternative (see `backend/README.md`'s dependency notes), and
 * `node:crypto`'s `scryptSync` is a real, still-recommended KDF (OWASP
 * lists it as an acceptable alternative to argon2/bcrypt) with zero extra
 * dependencies. Never a plaintext password stored anywhere, including in
 * logs — nothing in this module ever logs its `plain` argument.
 */

const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 } as const; // OWASP-recommended minimums for scrypt.

/** Returns "<saltHex>:<hashHex>" — the only form ever persisted to `user.password_hash`. */
export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/**
 * Constant-time comparison via `timingSafeEqual` — a plain `===` on
 * derived hashes would leak timing information about how many leading
 * bytes matched, defeating part of the point of hashing in the first
 * place.
 */
export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(plain, salt, expected.length, SCRYPT_PARAMS);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
