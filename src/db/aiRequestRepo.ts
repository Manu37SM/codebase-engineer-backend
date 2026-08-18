import type { DB } from "./index.js";

/**
 * Persistence for the `ai_request`/`ai_response` accounting tables (Phase 0
 * scaffold, extended by migration 005 for Phase 14). Every real call to an
 * `AIProvider.complete()` from a user-facing workflow — starting with
 * finding explanation — writes one request row up front and one response
 * row after the call resolves (success or failure), per docs/AI_MODE.md §7's
 * "tracked per AI call" accounting requirement. This module has no opinion
 * about *why* a call was made; workflow code (e.g. `ai/workflows/explainFinding.ts`)
 * decides that.
 */

export interface AIRequestRecord {
  id: string;
  project_id: string | null;
  finding_id: string | null;
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
  provider: string;
  model: string;
  operationType: string;
  estimatedTokens: number | null;
}

export function createAIRequest(db: DB, id: string, input: CreateAIRequestInput): AIRequestRecord {
  db.prepare(
    `INSERT INTO ai_request (id, project_id, finding_id, provider, model, operation_type, estimated_tokens, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`
  ).run(
    id,
    input.projectId,
    input.findingId,
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

/**
 * The most recent successful explanation on file for a finding, if any —
 * lets the UI show a previously-generated explanation without spending
 * tokens on a repeat call. Joins through `ai_request` since that's where
 * `finding_id` and `operation_type` live.
 */
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
