import type { DB } from "./index.js";
import type { Finding } from "../analysis/index.js";

export interface FindingRecord {
  id: string;
  project_id: string;
  rule_id: string;
  severity: string;
  category: string;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  evidence: string | null;
  explanation: string | null;
  recommendation: string | null;
  source: string;
  created_at: string;
}

export interface AnalysisRunRecord {
  id: string;
  project_id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  findings_count: number;

  critical_count: number | null;
  high_count: number | null;
  medium_count: number | null;
  low_count: number | null;
}

export function replaceProjectFindings(
  db: DB,
  projectId: string,
  findings: Finding[],
  idFactory: () => string
): void {
  const deleteStmt = db.prepare("DELETE FROM finding WHERE project_id = ? AND source = 'deterministic'");
  const insertStmt = db.prepare(
    `INSERT INTO finding
      (id, project_id, rule_id, severity, category, file_path, line_start, line_end, evidence, explanation, recommendation, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'deterministic')`
  );

  const tx = db.transaction((rows: Finding[]) => {
    deleteStmt.run(projectId);
    for (const finding of rows) {
      insertStmt.run(
        idFactory(),
        projectId,
        finding.ruleId,
        finding.severity,
        finding.category,
        finding.filePath,
        finding.lineStart,
        finding.lineEnd,
        finding.evidence,
        finding.explanation,
        finding.recommendation
      );
    }
  });

  tx(findings);
}

export interface ListFindingsOptions {
  severity?: string;
  category?: string;
  limit?: number;
  offset?: number;
}

export function listFindings(
  db: DB,
  projectId: string,
  options: ListFindingsOptions = {}
): { findings: FindingRecord[]; total: number } {
  const conditions = ["project_id = ?"];
  const params: (string | number)[] = [projectId];

  if (options.severity) {
    conditions.push("severity = ?");
    params.push(options.severity);
  }
  if (options.category) {
    conditions.push("category = ?");
    params.push(options.category);
  }

  const whereClause = conditions.join(" AND ");
  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM finding WHERE ${whereClause}`).get(...params) as {
      count: number;
    }
  ).count;

  const limit = options.limit ?? 500;
  const offset = options.offset ?? 0;

  const severityRank = `CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;
  const findings = db
    .prepare(
      `SELECT * FROM finding WHERE ${whereClause} ORDER BY ${severityRank}, file_path LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as FindingRecord[];

  return { findings, total };
}

export function getFindingById(db: DB, id: string): FindingRecord | undefined {
  return db.prepare("SELECT * FROM finding WHERE id = ?").get(id) as FindingRecord | undefined;
}

export interface FindingCounts {
  total: number;
  bySeverity: Record<string, number>;
  byCategory: Record<string, number>;
}

export function getFindingCounts(db: DB, projectId: string): FindingCounts {
  const total = (
    db.prepare("SELECT COUNT(*) as count FROM finding WHERE project_id = ?").get(projectId) as {
      count: number;
    }
  ).count;

  const severityRows = db
    .prepare("SELECT severity, COUNT(*) as count FROM finding WHERE project_id = ? GROUP BY severity")
    .all(projectId) as { severity: string; count: number }[];
  const categoryRows = db
    .prepare("SELECT category, COUNT(*) as count FROM finding WHERE project_id = ? GROUP BY category")
    .all(projectId) as { category: string; count: number }[];

  const bySeverity: Record<string, number> = {};
  for (const row of severityRows) bySeverity[row.severity] = row.count;
  const byCategory: Record<string, number> = {};
  for (const row of categoryRows) byCategory[row.category] = row.count;

  return { total, bySeverity, byCategory };
}

export function createAnalysisRun(db: DB, id: string, projectId: string): AnalysisRunRecord {
  db.prepare(
    "INSERT INTO analysis_run (id, project_id, status) VALUES (?, ?, 'running')"
  ).run(id, projectId);
  return db.prepare("SELECT * FROM analysis_run WHERE id = ?").get(id) as AnalysisRunRecord;
}

export function finishAnalysisRun(
  db: DB,
  id: string,
  status: "completed" | "failed",
  findingsCount: number,
  severityCounts?: { critical: number; high: number; medium: number; low: number }
): void {
  db.prepare(
    `UPDATE analysis_run
     SET finished_at = datetime('now'), status = ?, findings_count = ?,
         critical_count = ?, high_count = ?, medium_count = ?, low_count = ?
     WHERE id = ?`
  ).run(
    status,
    findingsCount,
    severityCounts?.critical ?? null,
    severityCounts?.high ?? null,
    severityCounts?.medium ?? null,
    severityCounts?.low ?? null,
    id
  );
}

export function getLatestAnalysisRun(db: DB, projectId: string): AnalysisRunRecord | undefined {
  return db
    .prepare("SELECT * FROM analysis_run WHERE project_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(projectId) as AnalysisRunRecord | undefined;
}

export function listAnalysisRuns(db: DB, projectId: string): AnalysisRunRecord[] {

  const rows = db
    .prepare(
      `SELECT * FROM analysis_run WHERE project_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 100`
    )
    .all(projectId) as AnalysisRunRecord[];
  return rows.reverse();
}
