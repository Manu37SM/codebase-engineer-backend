import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface WorkingTreeStatus {
  modified: number;
  staged: number;
  untracked: number;
  clean: boolean;
}

export interface GitDetectionResult {
  isGitRepository: boolean;
  branch: string | null;
  workingTreeStatus: WorkingTreeStatus | null;
}

export function detectGit(root: string): GitDetectionResult {
  if (!fs.existsSync(path.join(root, ".git"))) {
    return { isGitRepository: false, branch: null, workingTreeStatus: null };
  }

  const branch = safeGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const statusOutput = safeGit(root, ["status", "--porcelain=v1"]);

  let workingTreeStatus: WorkingTreeStatus | null = null;
  if (statusOutput !== null) {
    workingTreeStatus = summarizeStatus(statusOutput);
  }

  return {
    isGitRepository: true,
    branch: branch,
    workingTreeStatus,
  };
}

function summarizeStatus(porcelain: string): WorkingTreeStatus {
  const lines = porcelain.split("\n").filter((l) => l.length > 0);
  let staged = 0;
  let modified = 0;
  let untracked = 0;

  for (const line of lines) {
    const indexStatus = line[0];
    const worktreeStatus = line[1];
    if (indexStatus === "?" && worktreeStatus === "?") {
      untracked++;
      continue;
    }
    if (indexStatus !== " " && indexStatus !== "?") staged++;
    if (worktreeStatus !== " " && worktreeStatus !== "?") modified++;
  }

  return { modified, staged, untracked, clean: lines.length === 0 };
}

function safeGit(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });

    return output.replace(/\s+$/, "");
  } catch {
    return null; 
  }
}
