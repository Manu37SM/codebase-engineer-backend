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
