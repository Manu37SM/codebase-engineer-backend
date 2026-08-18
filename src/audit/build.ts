import type { DB } from "../db/index.js";
import type { ProjectRecord } from "../db/projectRepo.js";
import { getLatestSnapshot } from "../db/projectRepo.js";
import { listProjectFiles } from "../db/fileRepo.js";
import { getFindingCounts, getLatestAnalysisRun } from "../db/findingRepo.js";
import { listTestRuns } from "../db/testRunRepo.js";
import { analyzeGit } from "../git/index.js";
import { scanSecurity } from "../security/scan.js";
import { analyzeDependencies } from "../dependencies/index.js";
import type { AuditReport, AuditSnapshotSummary } from "./types.js";

/**
 * Builds a single consolidated audit view by aggregating this product's
 * existing per-feature data sources — it does not run any new analysis of
 * its own. Some of what it reports is persisted (the repository snapshot
 * from the last Scan, findings from the last "Run Analysis") and some is
 * computed live right now (security scan, dependency analysis, Git
 * activity) — same "computed vs. persisted" split used by every other
 * feature in this product; the audit report is a read-only aggregation, so
 * there is nothing new to persist. Nothing here is cached: calling this
 * twice in a row re-reads the DB and re-walks the repo both times.
 */
export function buildAuditReport(db: DB, project: ProjectRecord): AuditReport {
  const generatedAt = new Date().toISOString();

  const snapshotRecord = getLatestSnapshot(db, project.id);
  let snapshot: AuditSnapshotSummary | null = null;
  if (snapshotRecord) {
    const { total: totalFiles } = listProjectFiles(db, project.id, { limit: 1 });
    const { total: testFiles } = listProjectFiles(db, project.id, { limit: 1, isTest: true });
    snapshot = {
      languages: safeParse(snapshotRecord.languages, []),
      frameworks: safeParse(snapshotRecord.frameworks, []),
      buildSystems: safeParse(snapshotRecord.build_system, []),
      packageManagers: safeParse(snapshotRecord.package_managers, []),
      totalFiles,
      testFiles,
      indexedAt: snapshotRecord.indexed_at,
    };
  }

  const latestRun = getLatestAnalysisRun(db, project.id) ?? null;
  const counts = getFindingCounts(db, project.id);

  const security = scanSecurity(project.root_path);
  const dependencies = analyzeDependencies(project.root_path);
  const git = analyzeGit(project.root_path);

  const [latestTestRun] = listTestRuns(db, project.id, 1);

  return {
    project: { id: project.id, name: project.name, rootPath: project.root_path },
    generatedAt,
    snapshot,
    findings: { latestRun, counts },
    security,
    dependencies,
    git,
    latestTestRun: latestTestRun ?? null,
  };
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
