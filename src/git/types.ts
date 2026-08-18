import type { WorkingTreeStatus } from "../discovery/git.js";

export interface CommitSummary {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  date: string; // ISO 8601 (git --date=iso-strict)
  message: string;
}

export interface FileChurn {
  path: string;
  commitCount: number;
}

export interface FileDiffStat {
  path: string;
  insertions: number | null; // null for binary files (git reports "-")
  deletions: number | null;
}

export interface DiffStatSummary {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: FileDiffStat[];
}

export interface GitAnalysisResult {
  isGitRepository: boolean;
  branch: string | null;
  workingTreeStatus: WorkingTreeStatus | null;
  recentCommits: CommitSummary[];
  fileChurn: FileChurn[];
  uncommittedChanges: DiffStatSummary | null;
  churnWindowDays: number;
  analyzedAt: string;
}
