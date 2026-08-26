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

  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;

  operationType: string;

  patchId?: string | null;

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

export async function runFindingWorkflow(options: RunFindingWorkflowOptions): Promise<RunFindingWorkflowResult> {
  const { db, projectId, projectRoot, finding, files, providerConfig, operationType, buildPrompt, patchId } = options;
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
    patchId: patchId ?? null,
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
