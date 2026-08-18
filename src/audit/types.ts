import type { GitAnalysisResult } from "../git/index.js";
import type { DependencyAnalysisResult } from "../dependencies/index.js";
import type { Finding } from "../analysis/index.js";
import type { AnalysisRunRecord, FindingCounts } from "../db/findingRepo.js";
import type { TestRunRecord } from "../db/testRunRepo.js";

export interface AuditSnapshotSummary {
  languages: { language: string; fileCount: number; approxLoc: number }[];
  frameworks: string[];
  buildSystems: string[];
  packageManagers: string[];
  totalFiles: number;
  testFiles: number;
  indexedAt: string;
}

export interface AuditReport {
  project: {
    id: string;
    name: string;
    rootPath: string;
  };
  generatedAt: string;
  /** Null if the project has never been scanned (discover+index). */
  snapshot: AuditSnapshotSummary | null;
  /**
   * Counts from the most recent persisted `POST /analysis` run — the same
   * data the Findings page shows. `latestRun` is null if analysis has never
   * been run for this project.
   */
  findings: {
    latestRun: AnalysisRunRecord | null;
    counts: FindingCounts;
  };
  /**
   * Computed fresh right now (same rules as `GET /security`) — kept
   * separate from `findings` above because it can be more current than the
   * last persisted analysis run (e.g. a `.env` file added since).
   */
  security: {
    findings: Finding[];
    scannedAt: string;
  };
  dependencies: DependencyAnalysisResult;
  git: GitAnalysisResult;
  /** Null if the project's test command has never been run. */
  latestTestRun: TestRunRecord | null;
}
