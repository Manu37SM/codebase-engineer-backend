import { execFileSync } from "node:child_process";
import type { FileChurn } from "./types.js";

const DEFAULT_TOP_N = 15;

export function getFileChurn(root: string, windowDays = 90, topN = DEFAULT_TOP_N): FileChurn[] {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const output = safeGit(root, [
    "log",
    `--since=${since}`,
    "--name-only",
    "--pretty=format:",
  ]);
  if (output === null) return [];

  const counts = new Map<string, number>();
  for (const line of output.split("\n")) {
    const filePath = line.trim();
    if (!filePath) continue;
    counts.set(filePath, (counts.get(filePath) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([path, commitCount]) => ({ path, commitCount }))
    .sort((a, b) => b.commitCount - a.commitCount || a.path.localeCompare(b.path))
    .slice(0, topN);
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
