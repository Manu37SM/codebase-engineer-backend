import type { DB } from "../../db/index.js";
import type { FindingRecord } from "../../db/findingRepo.js";
import type { ProviderConfig } from "../provider/registry.js";
import type { AICompletionResult } from "../provider/types.js";
import type { ContextBundle, FileForSelection } from "../context/types.js";
import { getLatestSuccessfulResponse } from "../../db/aiRequestRepo.js";
import { runFindingWorkflow, findingSummary, contextSections } from "./runFindingWorkflow.js";
import { FIX_PLAN_OPERATION_TYPE } from "./fixPlan.js";

export const PATCH_GENERATION_OPERATION_TYPE = "patch-generation";

export interface GeneratePatchOptions {
  db: DB;
  projectId: string;
  projectRoot: string;
  finding: FindingRecord;
  files: FileForSelection[];

  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

export interface GeneratePatchResult {
  requestId: string;
  bundle: ContextBundle;

  diffText: string;
  usedFixPlan: boolean;
  provider: string;
  model: string;
  usage: AICompletionResult["usage"];
}

export async function generatePatch(options: GeneratePatchOptions): Promise<GeneratePatchResult> {
  const priorFixPlan = getLatestSuccessfulResponse(options.db, options.finding.id, FIX_PLAN_OPERATION_TYPE);

  const result = await runFindingWorkflow({
    ...options,
    operationType: PATCH_GENERATION_OPERATION_TYPE,
    buildPrompt: (finding, bundle) => buildPatchPrompt(finding, bundle, priorFixPlan?.content ?? null),
  });

  return {
    requestId: result.requestId,
    bundle: result.bundle,
    diffText: result.content,
    usedFixPlan: priorFixPlan !== undefined,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  };
}

function buildPatchPrompt(
  finding: FindingRecord,
  bundle: ContextBundle,
  priorFixPlan: string | null
): { system: string; user: string } {
  const system =
    "You are a senior software engineer generating a code patch for a static-analysis finding. " +
    "A human will review this diff before it is ever applied — you are proposing a change, not applying one. " +
    "Respond with ONLY a unified diff (git-style, with --- and +++ file headers and @@ hunk headers) that " +
    "fixes the finding, based on the code shown. Do not include any prose, explanation, or commentary — the " +
    "response must be the diff and nothing else. If you cannot produce a correct diff from the code shown, " +
    "respond with exactly: NO_PATCH: <a one-line reason>.";

  const priorPlanSection = priorFixPlan
    ? `\n\nA fix plan for this finding was already approved — implement it:\n${priorFixPlan}`
    : "";

  const user = `Finding:\n${findingSummary(finding)}${priorPlanSection}\n\nRelevant code:\n${contextSections(bundle)}`;

  return { system, user };
}
