import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Registration by remote git URL (Task #85) — one of the four project
 * sources the user explicitly asked for, alongside local path, GitHub repo
 * browsing (Task #84), and zip/download URL (zipUrl.ts). Still local-first:
 * this clones the repository onto the SAME machine this backend runs on,
 * under its own data directory — nothing is uploaded anywhere, and the
 * resulting local clone is registered exactly like any other local
 * repository (`docs/PRD.md` §3).
 */

const ALLOWED_URL_PATTERN = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/i;

export class InvalidGitUrlError extends Error {
  constructor(url: string) {
    super(`Not a recognized git URL (expected http(s)://, ssh://, git@..., or file://): ${url}`);
    this.name = "InvalidGitUrlError";
  }
}

export function assertValidGitUrl(url: string): void {
  if (!url || !ALLOWED_URL_PATTERN.test(url.trim())) {
    throw new InvalidGitUrlError(url);
  }
}

/**
 * Clones `url` into `destDir` (which must not already exist — the caller
 * picks a fresh directory per import so this never overwrites anything).
 * Uses `execFileSync` with an argv array, never a shell string — same
 * "no shell interpolation" principle as `git/commits.ts` — so nothing in
 * the URL (even a maliciously crafted one) can inject an extra command.
 * A full clone, not `--depth 1`: this product's own Git Activity /
 * churn-hotspot features (Phase 8) read real commit history, and a
 * shallow clone would silently make those features report much less than
 * they normally would for a locally-registered repo.
 */
export function cloneGitUrl(url: string, destDir: string): void {
  assertValidGitUrl(url);
  if (fs.existsSync(destDir)) {
    throw new Error(`Destination already exists: ${destDir}`);
  }
  try {
    execFileSync("git", ["clone", url, destDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000, // 5 minutes — generous for a large repo, but not unbounded.
    });
  } catch (err) {
    // Clean up a partial clone rather than leaving a half-cloned directory
    // registered as a project root.
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    throw new Error(`git clone failed${stderr ? `: ${stderr}` : ""}`);
  }
}
