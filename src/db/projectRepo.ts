import type { DB } from "./index.js";
import type { DiscoveryResult } from "../discovery/index.js";

export interface ProjectRecord {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
}

export interface RepositorySnapshotRecord {
  id: string;
  project_id: string;
  languages: string; // JSON
  frameworks: string; // JSON
  build_system: string; // JSON
  package_managers: string; // JSON
  git_branch: string | null;
  working_tree_status: string; // JSON
  indexed_at: string;
}

export function createProject(db: DB, id: string, name: string, rootPath: string): ProjectRecord {
  db.prepare(
    "INSERT INTO project (id, name, root_path) VALUES (?, ?, ?)"
  ).run(id, name, rootPath);
  return getProjectById(db, id)!;
}

export function getProjectById(db: DB, id: string): ProjectRecord | undefined {
  return db.prepare("SELECT * FROM project WHERE id = ?").get(id) as
    | ProjectRecord
    | undefined;
}

export function getProjectByRootPath(db: DB, rootPath: string): ProjectRecord | undefined {
  return db.prepare("SELECT * FROM project WHERE root_path = ?").get(rootPath) as
    | ProjectRecord
    | undefined;
}

export function listProjects(db: DB): ProjectRecord[] {
  return db.prepare("SELECT * FROM project ORDER BY created_at DESC").all() as ProjectRecord[];
}

/**
 * Removes a project's own record from Codebase Engineer — findings,
 * snapshots, indexed files, analysis/test runs, patches, generated tests,
 * and audit reports all cascade-delete with it (every one of those tables
 * declares `project_id ... REFERENCES project(id) ON DELETE CASCADE` —
 * see migrations 001/006/008 — and `db/index.ts` turns on
 * `PRAGMA foreign_keys = ON`, so a single DELETE here is enough; SQLite
 * enforces the cascade, not application code).
 *
 * Deliberately does NOT touch anything on disk: the repository at
 * `root_path` is the user's own, on their own machine (Task #94, "remove
 * from workspace") — this only forgets that Codebase Engineer ever
 * registered it. Re-registering the same path afterwards starts fresh,
 * with no memory of the deleted project's findings/history.
 */
export function deleteProject(db: DB, id: string): void {
  db.prepare("DELETE FROM project WHERE id = ?").run(id);
}

export function saveDiscoverySnapshot(
  db: DB,
  id: string,
  projectId: string,
  result: DiscoveryResult
): RepositorySnapshotRecord {
  db.prepare(
    `INSERT INTO repository_snapshot
      (id, project_id, languages, frameworks, build_system, package_managers, git_branch, working_tree_status, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    projectId,
    JSON.stringify(result.languages),
    JSON.stringify(result.frameworks),
    JSON.stringify(result.buildSystems),
    JSON.stringify(result.packageManagers),
    result.gitBranch,
    JSON.stringify(result.workingTreeStatus),
    result.discoveredAt
  );
  return db
    .prepare("SELECT * FROM repository_snapshot WHERE id = ?")
    .get(id) as RepositorySnapshotRecord;
}

export function getLatestSnapshot(db: DB, projectId: string): RepositorySnapshotRecord | undefined {
  return db
    .prepare(
      "SELECT * FROM repository_snapshot WHERE project_id = ? ORDER BY indexed_at DESC LIMIT 1"
    )
    .get(projectId) as RepositorySnapshotRecord | undefined;
}
