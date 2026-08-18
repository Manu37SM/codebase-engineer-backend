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
  /** The row from `provider_configuration` to use — the caller (the route) is responsible for picking an enabled one. */
  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

export interface GeneratePatchResult {
  requestId: string;
  bundle: ContextBundle;
  /** The raw text the provider returned — expected to be a unified diff, but NOT parsed, validated, or dry-run applied in this phase. See the module doc comment for why. */
  diffText: string;
  usedFixPlan: boolean;
  provider: string;
  model: string;
  usage: AICompletionResult["usage"];
}

/**
 * Phase 17's AI workflow: asks the provider to produce an actual unified
 * diff for a finding, grounded in the finding's most recent Phase 16 fix
 * plan when one exists (same "consume a prior workflow's output" pattern
 * Phase 16 established for Phase 15's root-cause analysis).
 *
 * Important scope boundary: this function returns raw text from the
 * provider. It does NOT parse the text as a diff, does NOT validate it
 * (e.g. via `git apply --check`), and does NOT write it to any file.
 * Whether the returned text is even a syntactically valid patch is left
 * entirely to the human reviewer to judge — inventing a "looks like a
 * diff" heuristic here would be worse than being honest that this phase
 * doesn't attempt one. Actually applying an approved, reviewed diff to
 * disk is explicitly out of scope for Phase 17 (see docs/AI_MODE.md §4's
 * workflow diagram — "Apply Patch" comes after a *second* human-approval
 * gate this phase doesn't implement).
 *
 * Whether generation is even allowed to run at all is enforced by the
 * caller (the `/generate` route), which checks the patch's persisted
 * `status` is `'approved'` — the first of the two approval gates named in
 * docs/AI_MODE.md §4, and the reason `db/patchRepo.ts`'s `pending_approval
 * -> approved -> proposed` state machine exists instead of generating a
 * patch straight from a POST request.
 */
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
