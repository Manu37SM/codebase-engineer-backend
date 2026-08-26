import type { DB } from "./index.js";
import type { IndexedFile } from "../indexer/index.js";

export interface FileRecord {
  id: string;
  project_id: string;
  relative_path: string;
  language: string | null;
  loc: number | null;
  size_bytes: number;
  is_test: number;
  is_generated: number;
  content_hash: string | null;
  imports: string | null;
}

export function replaceProjectFiles(
  db: DB,
  projectId: string,
  files: IndexedFile[],
  idFactory: () => string
): void {
  const deleteStmt = db.prepare("DELETE FROM file WHERE project_id = ?");
  const insertStmt = db.prepare(
    `INSERT INTO file
      (id, project_id, relative_path, language, loc, size_bytes, is_test, is_generated, content_hash, imports)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction((rows: IndexedFile[]) => {
    deleteStmt.run(projectId);
    for (const file of rows) {
      insertStmt.run(
        idFactory(),
        projectId,
        file.relativePath,
        file.language,
        file.loc,
        file.sizeBytes,
        file.isTest ? 1 : 0,
        file.isGenerated ? 1 : 0,
        file.contentHash,
        JSON.stringify(file.imports)
      );
    }
  });

  tx(files);
}

export interface ListFilesOptions {
  language?: string;
  isTest?: boolean;
  limit?: number;
  offset?: number;
}

export function listProjectFiles(
  db: DB,
  projectId: string,
  options: ListFilesOptions = {}
): { files: FileRecord[]; total: number } {
  const conditions = ["project_id = ?"];
  const params: (string | number)[] = [projectId];

  if (options.language) {
    conditions.push("language = ?");
    params.push(options.language);
  }
  if (options.isTest !== undefined) {
    conditions.push("is_test = ?");
    params.push(options.isTest ? 1 : 0);
  }

  const whereClause = conditions.join(" AND ");
  const total = (
    db.prepare(`SELECT COUNT(*) as count FROM file WHERE ${whereClause}`).get(...params) as {
      count: number;
    }
  ).count;

  const limit = options.limit ?? 200;
  const offset = options.offset ?? 0;
  const files = db
    .prepare(`SELECT * FROM file WHERE ${whereClause} ORDER BY relative_path LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as FileRecord[];

  return { files, total };
}

export function listAllProjectFiles(db: DB, projectId: string): FileRecord[] {
  return db
    .prepare("SELECT * FROM file WHERE project_id = ? ORDER BY relative_path")
    .all(projectId) as FileRecord[];
}
