import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import AdmZip from "adm-zip";
import { applyPatchToDisk } from "./applyPatch.js";
import { resolveWithinRoot, PathTraversalError } from "../security/paths.js";

/**
 * Task #90: the "download as zip" half of the apply-mode setting
 * (`project.apply_mode`) — when a project is set to `"download"` instead
 * of `"direct"`, an approved patch is never written to the user's real
 * files. Instead, this builds a small zip containing just the file(s) the
 * diff touches, each already patched, at their real relative path — so the
 * user can inspect/apply/test the change by hand (unzip over the project,
 * or diff the extracted files against the originals) before anything on
 * their machine actually changes. Deliberately zips only the touched
 * files, not the whole project: a patch from Phase 17's generator
 * realistically touches one or a handful of files for one finding, and
 * zipping an entire repository for that would be needlessly slow/large.
 *
 * Reuses the exact same `git apply` machinery as the direct-write path
 * (`applyPatchToDisk`) — including its dry-run-then-real-apply and
 * autocrlf-neutralizing behavior — just pointed at a scratch temp
 * directory containing copies of only the touched files instead of the
 * real project root, so "download" and "direct" modes apply a diff
 * identically; only the destination differs.
 */
export class PatchZipExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchZipExportError";
  }
}

/**
 * Lists the relative paths a unified diff touches, via `git apply
 * --numstat` (a real parse of the diff by git itself, not a hand-rolled
 * regex) — this is the same diff format Phase 17's `generatePatch()`
 * produces and Phase 18's `applyPatchToDisk()` already consumes.
 */
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
    // "No valid patches in input" specifically means git couldn't find
    // anything shaped like a unified diff at all — not "the diff doesn't
    // apply cleanly" (a different, later failure). By design (see
    // generatePatch.ts's doc comment), the AI's raw response is stored as
    // diff_text unvalidated, so this is almost always the model having
    // responded with prose, an explicit "NO_PATCH: ..." decline, or a
    // diff wrapped in markdown fences instead of a real diff — something
    // the reviewer should reject rather than something to debug here.
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

/**
 * Builds a zip of `diffText` applied to `projectRoot`'s real (current, on
 * disk) file content — without writing anything to `projectRoot` itself.
 * Throws `PatchZipExportError` if the diff can't be parsed or doesn't
 * apply cleanly against the project's current files (the same
 * "drifted since generation" case `applyPatchToDisk`'s dry run already
 * guards against for the direct-write path).
 */
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

      // A modified/deleted file needs its real current content copied in
      // as context for `git apply`; a brand-new file (no matching real
      // file yet) is created entirely from the diff itself, so there's
      // nothing to copy.
      let srcAbs: string;
      try {
        srcAbs = resolveWithinRoot(projectRoot, relPath);
      } catch {
        continue; // path doesn't resolve within the real project — treat as new-file case
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
