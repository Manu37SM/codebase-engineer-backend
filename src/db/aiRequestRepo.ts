import type { DB } from "./index.js";

export interface AIRequestRecord {
  id: string;
  project_id: string | null;
  finding_id: string | null;

  test_run_id: string | null;

  patch_id: string | null;
  provider: string;
  model: string;
  operation_type: string;
  estimated_tokens: number | null;
  status: string;
  created_at: string;
}

export interface AIResponseRecord {
  id: string;
  ai_request_id: string;
  estimated_tokens: number | null;
  latency_ms: number | null;
  success: number;
  content: string | null;
}

export interface CreateAIRequestInput {
  projectId: string | null;
  findingId: string | null;

  testRunId?: string | null;

  patchId?: string | null;
  provider: string;
  model: string;
  operationType: string;
  estimatedTokens: number | null;
}

export function createAIRequest(db: DB, id: string, input: CreateAIRequestInput): AIRequestRecord {
  db.prepare(
    `INSERT INTO ai_request (id, project_id, finding_id, test_run_id, patch_id, provider, model, operation_type, estimated_tokens, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    id,
    input.projectId,
    input.findingId,
    input.testRunId ?? null,
    input.patchId ?? null,
    input.provider,
    input.model,
    input.operationType,
    input.estimatedTokens
  );
  return getAIRequestById(db, id)!;
}

export function getAIRequestById(db: DB, id: string): AIRequestRecord | undefined {
  return db.prepare("SELECT * FROM ai_request WHERE id = ?").get(id) as AIRequestRecord | undefined;
}

export function markAIRequestStatus(db: DB, id: string, status: "succeeded" | "failed"): void {
  db.prepare("UPDATE ai_request SET status = ? WHERE id = ?").run(status, id);
}

export interface CreateAIResponseInput {
  aiRequestId: string;
  estimatedTokens: number | null;
  latencyMs: number | null;
  success: boolean;
  content: string | null;
}

export function createAIResponse(db: DB, id: string, input: CreateAIResponseInput): AIResponseRecord {
  db.prepare(
    `INSERT INTO ai_response (id, ai_request_id, estimated_tokens, latency_ms, success, content)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, input.aiRequestId, input.estimatedTokens, input.latencyMs, input.success ? 1 : 0, input.content);
  return db.prepare("SELECT * FROM ai_response WHERE id = ?").get(id) as AIResponseRecord;
}

export function getLatestSuccessfulResponse(
  db: DB,
  findingId: string,
  operationType: string
): (AIResponseRecord & { requestCreatedAt: string; provider: string; model: string }) | undefined {
  return db
    .prepare(
      `SELECT r.*, q.created_at as requestCreatedAt, q.provider as provider, q.model as model
       FROM ai_response r
       JOIN ai_request q ON q.id = r.ai_request_id
       WHERE q.finding_id = ? AND q.operation_type = ? AND r.success = 1
       ORDER BY r.rowid DESC
       LIMIT 1`
    )
    .get(findingId, operationType) as
    | (AIResponseRecord & { requestCreatedAt: string; provider: string; model: string })
    | undefined;
}

export function getLatestSuccessfulResponseForTestRun(
  db: DB,
  testRunId: string,
  operationType: string
): (AIResponseRecord & { requestCreatedAt: string; provider: string; model: string }) | undefined {
  return db
    .prepare(
      `SELECT r.*, q.created_at as requestCreatedAt, q.provider as provider, q.model as model
       FROM ai_response r
       JOIN ai_request q ON q.id = r.ai_request_id
       WHERE q.test_run_id = ? AND q.operation_type = ? AND r.success = 1
       ORDER BY r.rowid DESC
       LIMIT 1`
    )
    .get(testRunId, operationType) as
    | (AIResponseRecord & { requestCreatedAt: string; provider: string; model: string })
    | undefined;
}

export function getLatestSuccessfulResponseForPatch(
  db: DB,
  patchId: string,
  operationType: string
): (AIResponseRecord & { requestCreatedAt: string; provider: string; model: string }) | undefined {
  return db
    .prepare(
      `SELECT r.*, q.created_at as requestCreatedAt, q.provider as provider, q.model as model
       FROM ai_response r
       JOIN ai_request q ON q.id = r.ai_request_id
       WHERE q.patch_id = ? AND q.operation_type = ? AND r.success = 1
       ORDER BY r.rowid DESC
       LIMIT 1`
    )
    .get(patchId, operationType) as
    | (AIResponseRecord & { requestCreatedAt: string; provider: string; model: string })
    | undefined;
}
