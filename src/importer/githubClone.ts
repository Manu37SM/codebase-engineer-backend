import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { assertValidGitUrl } from "./gitUrl.js";

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

export function buildGitHubCloneUrl(fullName: string): string {
  assertValidRepoFullName(fullName);
  return `https://github.com/${fullName.trim()}.git`;
}

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

    }

    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    const safeStderr = stderr?.replace(new RegExp(authHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "[redacted]");
    throw new Error(`git clone failed${safeStderr ? `: ${safeStderr}` : ""}`);
  }
}
