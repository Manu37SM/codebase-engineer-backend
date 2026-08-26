import { execFileSync } from "node:child_process";
import type { CommitSummary } from "./types.js";

const RECORD_SEP = "\x1e";
const FIELD_SEP = "\x1f";
const PRETTY_FORMAT = `%H${FIELD_SEP}%h${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%ad${FIELD_SEP}%s${RECORD_SEP}`;

export function getRecentCommits(root: string, limit = 20): CommitSummary[] {
  const output = safeGit(root, [
    "log",
    `-n`,
    String(limit),
    `--pretty=format:${PRETTY_FORMAT}`,
    "--date=iso-strict",
  ]);
  if (output === null) return [];

  return output
    .split(RECORD_SEP)
    .map((record) => record.replace(/^\n/, "").trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, shortHash, authorName, authorEmail, date, message] = record.split(FIELD_SEP);
      return {
        hash: hash ?? "",
        shortHash: shortHash ?? "",
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        date: date ?? "",
        message: message ?? "",
      };
    });
}

function safeGit(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return output;
  } catch {
    return null;
  }
}
