import type { DB } from "./index.js";

export interface ProviderConfigRecord {
  id: string;
  name: string;
  kind: string;
  base_url: string | null;
  model: string | null;
  api_key: string | null;
  api_key_ref: string | null;
  enabled: number;
  created_at: string;
}

/** The shape ever returned by an API response — `api_key` never leaves this module. */
export interface ProviderConfigPublic {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  model: string | null;
  apiKeyRef: string | null;
  hasApiKey: boolean;
  enabled: boolean;
  createdAt: string;
}

export function toPublic(record: ProviderConfigRecord): ProviderConfigPublic {
  return {
    id: record.id,
    name: record.name,
    kind: record.kind,
    baseUrl: record.base_url,
    model: record.model,
    apiKeyRef: record.api_key_ref,
    hasApiKey: Boolean(record.api_key),
    enabled: record.enabled === 1,
    createdAt: record.created_at,
  };
}

/** Per docs/SECURITY.md §4's redaction style (first N / last N, rest masked) — applied here to API keys, not just secret findings. */
export function maskApiKey(key: string): string {
  if (key.length <= 6) return "*".repeat(key.length);
  return `${key.slice(0, 4)}...${key.slice(-2)}`;
}

export interface CreateProviderConfigInput {
  name: string;
  kind: string;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
}

export function createProviderConfig(
  db: DB,
  id: string,
  input: CreateProviderConfigInput
): ProviderConfigRecord {
  db.prepare(
    `INSERT INTO provider_configuration (id, name, kind, base_url, model, api_key, api_key_ref, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    id,
    input.name,
    input.kind,
    input.baseUrl,
    input.model,
    input.apiKey,
    input.apiKey ? maskApiKey(input.apiKey) : null
  );
  return getProviderConfigById(db, id)!;
}

export function listProviderConfigs(db: DB): ProviderConfigRecord[] {
  // Secondary sort on rowid: created_at has only second-level precision, so
  // two providers created within the same second would otherwise tie and
  // fall back to SQLite's unspecified order.
  return db
    .prepare("SELECT * FROM provider_configuration ORDER BY created_at DESC, rowid DESC")
    .all() as ProviderConfigRecord[];
}

export function getProviderConfigById(db: DB, id: string): ProviderConfigRecord | undefined {
  return db.prepare("SELECT * FROM provider_configuration WHERE id = ?").get(id) as
    | ProviderConfigRecord
    | undefined;
}

export interface UpdateProviderConfigInput {
  name?: string;
  baseUrl?: string | null;
  model?: string | null;
  apiKey?: string | null;
  enabled?: boolean;
}

export function updateProviderConfig(
  db: DB,
  id: string,
  input: UpdateProviderConfigInput
): ProviderConfigRecord | undefined {
  const existing = getProviderConfigById(db, id);
  if (!existing) return undefined;

  const name = input.name ?? existing.name;
  const baseUrl = input.baseUrl !== undefined ? input.baseUrl : existing.base_url;
  const model = input.model !== undefined ? input.model : existing.model;
  const apiKey = input.apiKey !== undefined ? input.apiKey : existing.api_key;
  const apiKeyRef = apiKey ? maskApiKey(apiKey) : null;
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;

  db.prepare(
    `UPDATE provider_configuration
     SET name = ?, base_url = ?, model = ?, api_key = ?, api_key_ref = ?, enabled = ?
     WHERE id = ?`
  ).run(name, baseUrl, model, apiKey, apiKeyRef, enabled, id);

  return getProviderConfigById(db, id);
}

export function deleteProviderConfig(db: DB, id: string): boolean {
  const result = db.prepare("DELETE FROM provider_configuration WHERE id = ?").run(id);
  return result.changes > 0;
}
