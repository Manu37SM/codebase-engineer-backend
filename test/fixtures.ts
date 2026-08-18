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
  fs.rmSync(root, { recursive: true, force: true });
}
