import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; 

function deriveKey(): Buffer {
  const secret = process.env.AUTH_TOKEN_ENCRYPTION_KEY;
  if (!secret || secret.trim().length === 0) {
    throw new Error(
      "AUTH_TOKEN_ENCRYPTION_KEY is not set — required to store an OAuth token securely. " +
        "Set it before enabling Google/GitHub OAuth (see backend/.env.example and docs/AUTH.md)."
    );
  }

  return scryptSync(secret, "codebase-engineer-auth-token-key", 32);
}

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
