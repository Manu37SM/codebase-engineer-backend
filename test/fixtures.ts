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
  // maxRetries/retryDelay: a real pasted Windows `npm test` run (2026-08-19,
  // round 2) showed `EBUSY: resource busy or locked` here after the
  // testrunner's real-process-execution tests — a lingering file lock from
  // a just-killed child process (see run.ts's Windows round-2 note) can
  // outlive the kill by longer than 5 retries * 200ms (~1s) covers.
  // Round 3 (2026-08-20, another real pasted Windows run): still hit EBUSY
  // even with round 2's window on the timeout-kill test specifically —
  // `taskkill /t /f` returning doesn't guarantee Windows has finished
  // releasing the killed process's file handles, so this widens the
  // retry window further (up to ~4.5s) rather than fabricating a pass by
  // just swallowing the error. `fs.rmSync`'s built-in retry (only honored
  // when `recursive` is true) absorbs the OS timing race instead of
  // failing the test on something that isn't a real bug in the cleanup
  // itself.
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 });
}
