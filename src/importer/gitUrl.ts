import { execFileSync } from "node:child_process";
import fs from "node:fs";

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

export function cloneGitUrl(url: string, destDir: string): void {
  assertValidGitUrl(url);
  if (fs.existsSync(destDir)) {
    throw new Error(`Destination already exists: ${destDir}`);
  }
  try {
    execFileSync("git", ["clone", url, destDir], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60 * 1000, 
    });
  } catch (err) {

    try {
      fs.rmSync(destDir, { recursive: true, force: true });
    } catch {

    }
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    throw new Error(`git clone failed${stderr ? `: ${stderr}` : ""}`);
  }
}
