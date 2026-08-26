import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";
import { applyPatchToDisk } from "./applyPatch.js";
import { resolveWithinRoot, PathTraversalError } from "../security/paths.js";

export class PatchZipExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchZipExportError";
  }
}

function listTouchedPaths(diffText: string): string[] {
  let output: string;
  try {
    output = execFileSync("git", ["apply", "--numstat", "-"], {
      input: diffText,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
    });
  } catch (err) {
    const stderr =
      err && typeof err === "object" && "stderr" in err ? String((err as { stderr: unknown }).stderr ?? "") : "";
    const gitMessage = stderr.trim() || (err as Error).message;

    const hint = gitMessage.includes("No valid patches in input")
      ? " This usually means the AI's response for this patch wasn't a real diff (see the raw text shown above the patch) — reject it and try regenerating, possibly with a different provider."
      : "";
    throw new PatchZipExportError(`Could not read which files this patch touches: ${gitMessage}${hint}`);
  }

  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split("\t")[2])
    .filter((p): p is string => Boolean(p));
}

export function buildPatchZip(projectRoot: string, diffText: string): Buffer {
  const touchedPaths = listTouchedPaths(diffText);
  if (touchedPaths.length === 0) {
    throw new PatchZipExportError("This patch's diff doesn't touch any recognizable file paths.");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-patch-zip-"));
  try {
    for (const relPath of touchedPaths) {
      let destAbs: string;
      try {
        destAbs = resolveWithinRoot(tempDir, relPath);
      } catch (err) {
        throw new PatchZipExportError(
          err instanceof PathTraversalError
            ? `Refusing to export: the diff references a path outside the project (${relPath}).`
            : (err as Error).message
        );
      }
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });

      let srcAbs: string;
      try {
        srcAbs = resolveWithinRoot(projectRoot, relPath);
      } catch {
        continue; 
      }
      if (fs.existsSync(srcAbs) && fs.statSync(srcAbs).isFile()) {
        fs.copyFileSync(srcAbs, destAbs);
      }
    }

    const result = applyPatchToDisk(tempDir, diffText);
    if (!result.success) {
      throw new PatchZipExportError(`This patch no longer applies cleanly: ${result.error}`);
    }

    const zip = new AdmZip();
    for (const relPath of touchedPaths) {
      const abs = resolveWithinRoot(tempDir, relPath);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const dir = path.posix.dirname(relPath);
        zip.addLocalFile(abs, dir === "." ? "" : dir, path.posix.basename(relPath));
      }
    }
    return zip.toBuffer();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
