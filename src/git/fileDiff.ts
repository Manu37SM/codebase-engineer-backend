import { execFileSync } from "node:child_process";

/**
 * Returns the unified diff hunk for one file's uncommitted changes
 * (staged + unstaged, relative to HEAD) via `git diff HEAD -- <path>` — the
 * single-file counterpart to `diffStat.ts`'s repo-wide `--numstat` summary.
 * Used by the AI context selector (Phase 13) to include "what actually
 * changed here" as context. Returns null when there's no HEAD to diff
 * against, the path has no uncommitted changes, or `git` isn't available —
 * never a fabricated diff.
 */
export function getUncommittedDiffForFile(root: string, relativePath: string): string | null {
  const output = safeGit(root, ["diff", "HEAD", "--", relativePath]);
  if (output === null || output.trim().length === 0) return null;
  return output;
}

function safeGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}
