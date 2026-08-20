import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { assertValidGitUrl } from "./gitUrl.js";

/**
 * Cloning by GitHub URL using a real access token (Task #84's
 * "clone-to-register" step, once the user has picked a repo from the
 * browser list at `GET /api/v1/github/repos`). Separate from
 * `gitUrl.ts`'s plain `cloneGitUrl` because this one needs to send
 * credentials — the repo may be private, and a plain unauthenticated
 * `git clone` would 404 or prompt for a password the backend can't answer.
 *
 * The token is passed via `-c http.extraheader`, never embedded in the
 * URL string itself — an embedded-in-URL token has a habit of ending up
 * in shell history, process listings, and (worse) git's own error/verbose
 * output when something goes wrong; a header set via `-c` does not.
 * `execFileSync` still gets an argv array, not a shell string, matching
 * this project's "no shell interpolation" convention (git/commits.ts,
 * gitUrl.ts).
 */

const FULL_NAME_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

export class InvalidRepoFullNameError extends Error {
  constructor(fullName: string) {
    super(`Not a valid "owner/repo" GitHub identifier: ${fullName}`);
    this.name = "InvalidRepoFullNameError";
  }
}

export function assertValidRepoFullName(fullName: string): void {
  if (!fullName || !FULL_NAME_PATTERN.test(fullName.trim())) {
    throw new InvalidRepoFullNameError(fullName);
  }
}

/** Builds the plain (unauthenticated-looking) clone URL for a `owner/repo` full name — the token travels separately via the extraheader, never in this string. */
export function buildGitHubCloneUrl(fullName: string): string {
  assertValidRepoFullName(fullName);
  return `https://github.com/${fullName.trim()}.git`;
}

/**
 * Clones `url` into `destDir` (which must not already exist) using `token`
 * as a GitHub access token. Works for both private and public repos — a
 * public repo just ignores the extra header. Same partial-clone cleanup
 * and full-history (non-shallow) behavior as `gitUrl.ts#cloneGitUrl`.
 */
export function cloneWithToken(url: string, destDir: string, token: string): void {
  assertValidGitUrl(url);
  if (fs.existsSync(destDir)) {
    throw new Error(`Destination already exists: ${destDir}`);
  }
  const authHeader = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  try {
    execFileSync("git", ["-c", `http.extraheader=${authHeader}`, "clone", url, destDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000,
    });
  } catch (err) {
    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
    // Never let a raw token or the extraheader value leak into a thrown
    // message that might end up in a client response or a log line.
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    const safeStderr = stderr?.replace(new RegExp(authHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[redacted]");
    throw new Error(`git clone failed${safeStderr ? `: ${safeStderr}` : ""}`);
  }
}
