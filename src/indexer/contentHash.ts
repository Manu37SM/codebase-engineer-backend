import { createHash } from "node:crypto";
import fs from "node:fs";
import { MAX_READABLE_FILE_BYTES } from "../discovery/fileWalker.js";

export function computeContentHash(absPath: string, sizeBytes: number): string | null {
  if (sizeBytes > MAX_READABLE_FILE_BYTES) return null;
  try {
    const buffer = fs.readFileSync(absPath);
    return createHash("sha256").update(buffer).digest("hex");
  } catch {
    return null;
  }
}
