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
  // outlive the kill. Windows locks a running (or just-dying) process's
  // working directory until the OS has fully torn the process down, and
  // — per round 3's and this round's (2026-08-20) real pasted runs — that
  // teardown, or an antivirus scan of the freshly written/killed test
  // fixture files, can take several seconds under load, longer than even
  // a generous fixed retry window reliably covers. `fs.rmSync`'s built-in
  // retry (only honored when `recursive` is true) is given a large ceiling
  // (up to ~20s) to absorb that first.
  //
  // If it's STILL locked after that, this now warns and moves on instead
  // of failing the test: the test's own assertions about `runTests`'
  // behavior (e.g. `timedOut: true`) already ran and passed by this
  // point — a leftover OS-temp-dir cleanup race on a machine under heavy
  // load isn't a real bug in this project's own code, and Windows/CI
  // routinely sweeps its own temp directory regardless. This is
  // deliberately narrower than swallowing all cleanup errors: any error
  // OTHER than a lock-contention code still throws, so a genuine bug
  // (e.g. a bad path) still fails loudly.
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 500 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY") {
      // eslint-disable-next-line no-console
      console.warn(`cleanupRepo: leaving ${root} in place — still locked after retrying (${code}).`);
      return;
    }
    throw err;
  }
}
