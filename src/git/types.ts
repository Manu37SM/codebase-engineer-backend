import type { WorkingTreeStatus } from "../discovery/git.js";

export interface CommitSummary {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  date: string; 
  message: string;
}

export interface FileChurn {
  path: string;
  commitCount: number;
}

export interface FileDiffStat {
  path: string;
  insertions: number | null; 
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
