import type { DB } from "./index.js";
import type { DiscoveryResult } from "../discovery/index.js";

export type ApplyMode = "direct" | "download";

export interface ProjectRecord {
  id: string;
  name: string;
  root_path: string;
  created_at: string;

  apply_mode: ApplyMode;
  /**
   * Owning account's user id (migration 018), or null for a project
   * created before multi-account auth existed and never claimed by a
   * user, or on an instance where auth has never been enabled (no
   * accounts registered — see auth/guard.ts's countUsers()===0 bypass).
   */
  user_id: string | null;
}

export interface RepositorySnapshotRecord {
  id: string;
  project_id: string;
  languages: string; 
  frameworks: string; 
  build_system: string; 
  package_managers: string; 
  git_branch: string | null;
  working_tree_status: string; 
  indexed_at: string;
}

export function createProject(
  db: DB,
  id: string,
  name: string,
  rootPath: string,
  ownerUserId: string | null
): ProjectRecord {
  db.prepare(
    "INSERT INTO project (id, name, root_path, apply_mode, user_id) VALUES (?, ?, ?, 'download', ?)"
  ).run(id, name, rootPath, ownerUserId);
  return getProjectById(db, id)!;
}

export function getProjectById(db: DB, id: string): ProjectRecord | undefined {
  return db.prepare("SELECT * FROM project WHERE id = ?").get(id) as
    | ProjectRecord
    | undefined;
}

/**
 * Ownership-checked project lookup — use this (not the raw `getProjectById`)
 * at every route that takes a `:id`/`:projectId` param, so one account can
 * never read, modify, or trigger AI-Mode disk writes/executions against
 * another account's project. `ownerUserId` should be `request.user?.id`.
 *
 * `undefined` means auth is disabled instance-wide (no accounts registered
 * — see auth/guard.ts's countUsers()===0 bypass): every project is
 * reachable, matching this product's original single-user/local-first
 * behavior. Once auth is enabled, a project is only reachable by the
 * account that owns it — including a project with a null `user_id`
 * (created before ownership existed and never backfilled/claimed), which
 * is denied rather than treated as "anyone's", failing closed.
 *
 * Returns `undefined` (indistinguishable from "doesn't exist") on a
 * mismatch, not a 403 — so a route's existing `if (!project) return 404`
 * check doubles as the ownership check with no other change needed, and a
 * caller can't use the response to tell "not yours" apart from "doesn't
 * exist" and go id-guessing.
 */
export function getProjectForOwner(
  db: DB,
  id: string,
  ownerUserId: string | undefined
): ProjectRecord | undefined {
  const project = getProjectById(db, id);
  if (!project) return undefined;
  if (ownerUserId === undefined) return project;
  if (project.user_id === ownerUserId) return project;
  return undefined;
}

export function getProjectByRootPath(db: DB, rootPath: string): ProjectRecord | undefined {
  return db.prepare("SELECT * FROM project WHERE root_path = ?").get(rootPath) as
    | ProjectRecord
    | undefined;
}

/**
 * `ownerUserId === undefined` (auth disabled instance-wide) lists every
 * project, matching this product's original single-user behavior.
 * Otherwise scoped strictly to that account's own projects — a project
 * with a null `user_id` is excluded here too (see `getProjectForOwner`).
 */
export function listProjects(db: DB, ownerUserId: string | undefined): ProjectRecord[] {
  if (ownerUserId === undefined) {
    return db.prepare("SELECT * FROM project ORDER BY created_at DESC").all() as ProjectRecord[];
  }
  return db
    .prepare("SELECT * FROM project WHERE user_id = ? ORDER BY created_at DESC")
    .all(ownerUserId) as ProjectRecord[];
}

export function deleteProject(db: DB, id: string): void {
  db.prepare("DELETE FROM project WHERE id = ?").run(id);
}

export function setProjectApplyMode(db: DB, id: string, applyMode: ApplyMode): void {
  db.prepare("UPDATE project SET apply_mode = ? WHERE id = ?").run(applyMode, id);
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
