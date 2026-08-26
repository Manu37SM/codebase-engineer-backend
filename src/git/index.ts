import { detectGit } from "../discovery/git.js";
import { getRecentCommits } from "./commits.js";
import { getFileChurn } from "./churn.js";
import { getUncommittedChanges } from "./diffStat.js";
export { getUncommittedDiffForFile } from "./fileDiff.js";
import type { GitAnalysisResult } from "./types.js";

const DEFAULT_COMMIT_LIMIT = 20;
const DEFAULT_CHURN_WINDOW_DAYS = 90;

export interface GitAnalysisOptions {
  commitLimit?: number;
  churnWindowDays?: number;
}

export function analyzeGit(root: string, options: GitAnalysisOptions = {}): GitAnalysisResult {
  const commitLimit = options.commitLimit ?? DEFAULT_COMMIT_LIMIT;
  const churnWindowDays = options.churnWindowDays ?? DEFAULT_CHURN_WINDOW_DAYS;

  const detection = detectGit(root);
  if (!detection.isGitRepository) {
    return {
      isGitRepository: false,
      branch: null,
      workingTreeStatus: null,
      recentCommits: [],
      fileChurn: [],
      uncommittedChanges: null,
      churnWindowDays,
      analyzedAt: new Date().toISOString(),
    };
  }

  return {
    isGitRepository: true,
    branch: detection.branch,
    workingTreeStatus: detection.workingTreeStatus,
    recentCommits: getRecentCommits(root, commitLimit),
    fileChurn: getFileChurn(root, churnWindowDays),
    uncommittedChanges: getUncommittedChanges(root),
    churnWindowDays,
    analyzedAt: new Date().toISOString(),
  };
}

export type { GitAnalysisResult, CommitSummary, FileChurn, DiffStatSummary, FileDiffStat } from "./types.js";
