import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Creates a fresh temp directory for a fixture repository. */
export function makeTempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ce-fixture-"));
}

export function writeFile(root: string, relPath: string, contents: string): void {
  const fullPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, contents);
}

export function initGit(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
}

export function gitCommitAll(root: string, message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root });
}

export function cleanupRepo(root: string): void {
  // maxRetries/retryDelay: a real pasted Windows `npm test` run (2026-08-19)
  // showed `EBUSY: resource busy or locked` here after the testrunner's
  // real-process-execution tests — a lingering file lock from a just-killed
  // child process (see run.ts's Windows round-2 note) can outlive the kill
  // by a few tens of milliseconds. `fs.rmSync`'s built-in retry (linear
  // backoff on EBUSY/EPERM/ENOTEMPTY/etc., only honored when `recursive` is
  // true) absorbs that instead of failing the test on an OS timing race
  // that isn't a real bug in the cleanup itself.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
