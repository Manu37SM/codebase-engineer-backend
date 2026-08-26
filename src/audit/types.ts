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

  snapshot: AuditSnapshotSummary | null;

  findings: {
    latestRun: AnalysisRunRecord | null;
    counts: FindingCounts;
  };

  security: {
    findings: Finding[];
    scannedAt: string;
  };
  dependencies: DependencyAnalysisResult;
  git: GitAnalysisResult;

  latestTestRun: TestRunRecord | null;
}
