import { execFileSync } from "node:child_process";
import type { DiffStatSummary, FileDiffStat } from "./types.js";

/**
 * Summarizes uncommitted changes (staged + unstaged, relative to HEAD) via
 * `git diff HEAD --numstat`. Returns null when there's no HEAD to diff
 * against (a brand-new repo with zero commits) rather than fabricating an
 * empty-but-misleading summary.
 */
export function getUncommittedChanges(root: string): DiffStatSummary | null {
  const output = safeGit(root, ["diff", "HEAD", "--numstat"]);
  if (output === null) return null;

  const files: FileDiffStat[] = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [insertionsRaw, deletionsRaw, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      return {
        path,
        insertions: insertionsRaw === "-" ? null : Number(insertionsRaw),
        deletions: deletionsRaw === "-" ? null : Number(deletionsRaw),
      };
    });

  const insertions = files.reduce((sum, f) => sum + (f.insertions ?? 0), 0);
  const deletions = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

  return { filesChanged: files.length, insertions, deletions, files };
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
