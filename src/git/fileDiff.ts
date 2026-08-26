import { execFileSync } from "node:child_process";

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
