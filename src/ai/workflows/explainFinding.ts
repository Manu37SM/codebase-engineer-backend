import type { DB } from "../../db/index.js";
import type { FindingRecord } from "../../db/findingRepo.js";
import type { ProviderConfig } from "../provider/registry.js";
import type { AICompletionResult } from "../provider/types.js";
import type { ContextBundle, FileForSelection } from "../context/types.js";
import { runFindingWorkflow, findingSummary, contextSections } from "./runFindingWorkflow.js";

export const EXPLAIN_FINDING_OPERATION_TYPE = "explain-finding";

export interface ExplainFindingOptions {
  db: DB;
  projectId: string;
  projectRoot: string;
  finding: FindingRecord;
  files: FileForSelection[];

  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

export interface ExplainFindingResult {
  requestId: string;
  bundle: ContextBundle;
  explanation: string;
  provider: string;
  model: string;
  usage: AICompletionResult["usage"];
}

export async function explainFinding(options: ExplainFindingOptions): Promise<ExplainFindingResult> {
  const result = await runFindingWorkflow({
    ...options,
    operationType: EXPLAIN_FINDING_OPERATION_TYPE,
    buildPrompt: buildExplanationPrompt,
  });

  return {
    requestId: result.requestId,
    bundle: result.bundle,
    explanation: result.content,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  };
}

function buildExplanationPrompt(finding: FindingRecord, bundle: ContextBundle): { system: string; user: string } {
  const system =
    "You are a senior software engineer explaining a static-analysis finding to another developer. " +
    "Explain (1) why this finding matters in practice, and (2) the likely root cause given the code shown. " +
    "Be concise and specific to the code provided. Do not invent code you cannot see, and do not propose a fix — " +
    "only explain the finding.";

  const user = `Finding:\n${findingSummary(finding)}\n\nRelevant code:\n${contextSections(bundle)}`;

  return { system, user };
}
