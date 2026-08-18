import { randomUUID } from "node:crypto";
import type { DB } from "../../db/index.js";
import type { FindingRecord } from "../../db/findingRepo.js";
import { createAIRequest, createAIResponse, markAIRequestStatus } from "../../db/aiRequestRepo.js";
import { createProvider, type ProviderConfig } from "../provider/registry.js";
import type { AICompletionResult } from "../provider/types.js";
import { selectContextForFinding } from "../context/select.js";
import type { ContextBundle, FileForSelection } from "../context/types.js";

const DEFAULT_BUDGET_TOKENS = 4000;

export interface RunFindingWorkflowOptions {
  db: DB;
  projectId: string;
  projectRoot: string;
  finding: FindingRecord;
  files: FileForSelection[];
  /** The row from `provider_configuration` to use — the caller (the route) is responsible for picking an enabled one. */
  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
  /** Distinguishes this call's accounting row from other Finding-target workflows (e.g. "explain-finding" vs "root-cause-analysis") sharing the same `ai_request`/`ai_response` tables. */
  operationType: string;
  /** Builds the system/user messages from the finding and its (already redacted, content-included) context bundle. */
  buildPrompt: (finding: FindingRecord, bundle: ContextBundle) => { system: string; user: string };
}

export interface RunFindingWorkflowResult {
  requestId: string;
  bundle: ContextBundle;
  content: string;
  provider: string;
  model: string;
  usage: AICompletionResult["usage"];
}

/**
 * Shared plumbing behind every Finding-target AI workflow (Phase 14's
 * `explainFinding`, Phase 15's `analyzeRootCause`, and future ones): build
 * a Phase 13 context bundle with real file content, call the configured
 * provider, and persist an `ai_request`/`ai_response` accounting pair
 * (per docs/AI_MODE.md §7) whether the call succeeds or fails. Factored
 * out once a second workflow needed the exact same request/response
 * bookkeeping `explainFinding` already had — each workflow now only
 * supplies its own prompt and its own parsing of the raw response.
 */
export async function runFindingWorkflow(options: RunFindingWorkflowOptions): Promise<RunFindingWorkflowResult> {
  const { db, projectId, projectRoot, finding, files, providerConfig, operationType, buildPrompt } = options;
  const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

  const bundle = selectContextForFinding({
    root: projectRoot,
    finding: {
      id: finding.id,
      filePath: finding.file_path ?? "",
      lineStart: finding.line_start,
      lineEnd: finding.line_end,
    },
    files,
    budgetTokens,
    includeContent: true,
  });

  const provider = createProvider(providerConfig);
  const prompt = buildPrompt(finding, bundle);
  const estimatedTokens = provider.estimateTokens(prompt.system) + provider.estimateTokens(prompt.user);

  const requestId = randomUUID();
  createAIRequest(db, requestId, {
    projectId,
    findingId: finding.id,
    provider: providerConfig.kind,
    model: providerConfig.model ?? "unknown",
    operationType,
    estimatedTokens,
  });

  const startedAt = Date.now();
  try {
    const result = await provider.complete({
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user },
      ],
    });

    markAIRequestStatus(db, requestId, "succeeded");
    createAIResponse(db, randomUUID(), {
      aiRequestId: requestId,
      estimatedTokens: result.usage.completionTokens,
      latencyMs: Date.now() - startedAt,
      success: true,
      content: result.content,
    });

    return {
      requestId,
      bundle,
      content: result.content,
      provider: providerConfig.kind,
      model: result.model,
      usage: result.usage,
    };
  } catch (err) {
    markAIRequestStatus(db, requestId, "failed");
    createAIResponse(db, randomUUID(), {
      aiRequestId: requestId,
      estimatedTokens: null,
      latencyMs: Date.now() - startedAt,
      success: false,
      content: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

export function findingSummary(finding: FindingRecord): string {
  return [
    `Rule: ${finding.rule_id}`,
    `Severity: ${finding.severity}`,
    `Category: ${finding.category}`,
    `File: ${finding.file_path ?? "unknown"}${finding.line_start ? `:${finding.line_start}` : ""}`,
    finding.evidence ? `Evidence: ${finding.evidence}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function contextSections(bundle: ContextBundle): string {
  const sections = bundle.selected
    .filter((item) => item.content !== undefined)
    .map((item) => `--- ${item.path} (${item.reason}) ---\n${item.content}`)
    .join("\n\n");
  return sections || "(no code fit within the context budget)";
}
