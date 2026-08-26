import type { DB } from "../../db/index.js";
import type { FindingRecord } from "../../db/findingRepo.js";
import type { ProviderConfig } from "../provider/registry.js";
import type { AICompletionResult } from "../provider/types.js";
import type { ContextBundle, FileForSelection } from "../context/types.js";
import { getLatestSuccessfulResponse } from "../../db/aiRequestRepo.js";
import { runFindingWorkflow, findingSummary, contextSections } from "./runFindingWorkflow.js";
import { parseStructuredSections, parseBulletList } from "./parseStructuredResponse.js";
import { ROOT_CAUSE_ANALYSIS_OPERATION_TYPE } from "./rootCauseAnalysis.js";

export const FIX_PLAN_OPERATION_TYPE = "fix-plan";

export interface FixPlanOptions {
  db: DB;
  projectId: string;
  projectRoot: string;
  finding: FindingRecord;
  files: FileForSelection[];

  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

export interface ParsedFixPlan {
  problem: string | null;
  rootCause: string | null;
  filesAffected: string[] | null;
  proposedChanges: string | null;
  risks: string | null;
  requiredTests: string | null;
  validationStrategy: string | null;
  raw: string;
}

export interface FixPlanResult {
  requestId: string;
  bundle: ContextBundle;
  plan: ParsedFixPlan;

  usedPriorRootCauseAnalysis: boolean;
  provider: string;
  model: string;
  usage: AICompletionResult["usage"];
}

export async function planFix(options: FixPlanOptions): Promise<FixPlanResult> {
  const priorRootCause = getLatestSuccessfulResponse(options.db, options.finding.id, ROOT_CAUSE_ANALYSIS_OPERATION_TYPE);

  const result = await runFindingWorkflow({
    ...options,
    operationType: FIX_PLAN_OPERATION_TYPE,
    buildPrompt: (finding, bundle) => buildFixPlanPrompt(finding, bundle, priorRootCause?.content ?? null),
  });

  return {
    requestId: result.requestId,
    bundle: result.bundle,
    plan: parseFixPlanSections(result.content),
    usedPriorRootCauseAnalysis: priorRootCause !== undefined,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  };
}

function buildFixPlanPrompt(
  finding: FindingRecord,
  bundle: ContextBundle,
  priorRootCause: string | null
): { system: string; user: string } {
  const system =
    "You are a senior software engineer writing a fix plan for a static-analysis finding. " +
    "This plan will be reviewed by a human before any code is written — you are not generating a patch, " +
    "only proposing one in words. Respond in EXACTLY this format, with these seven section headers on " +
    "their own line, in this order:\n\n" +
    "PROBLEM:\nWhat is wrong, in plain terms.\n\n" +
    "ROOT CAUSE:\nWhy it happened.\n\n" +
    "FILES AFFECTED:\n- one bullet per file you expect to change\n\n" +
    "PROPOSED CHANGES:\nWhat you would change and why, in prose — not a diff.\n\n" +
    "RISKS:\nWhat could go wrong with this change, or what it might break.\n\n" +
    "REQUIRED TESTS:\nWhat should be tested (new or existing) to confirm the fix works and nothing regressed.\n\n" +
    "VALIDATION STRATEGY:\nHow a human reviewer should confirm this plan is correct before it's implemented.\n\n" +
    "Do not add any other sections, and do not include an actual code diff.";

  const priorAnalysisSection = priorRootCause
    ? `\n\nA previous root-cause analysis for this finding already exists — use it as grounding rather than re-deriving from scratch:\n${priorRootCause}`
    : "";

  const user = `Finding:\n${findingSummary(finding)}${priorAnalysisSection}\n\nRelevant code:\n${contextSections(bundle)}`;

  return { system, user };
}

const FIX_PLAN_HEADERS = [
  "PROBLEM",
  "ROOT CAUSE",
  "FILES AFFECTED",
  "PROPOSED CHANGES",
  "RISKS",
  "REQUIRED TESTS",
  "VALIDATION STRATEGY",
];

export function parseFixPlanSections(raw: string): ParsedFixPlan {
  const sections = parseStructuredSections(raw, FIX_PLAN_HEADERS);
  return {
    problem: sections.PROBLEM,
    rootCause: sections["ROOT CAUSE"],
    filesAffected: parseBulletList(sections["FILES AFFECTED"]),
    proposedChanges: sections["PROPOSED CHANGES"],
    risks: sections.RISKS,
    requiredTests: sections["REQUIRED TESTS"],
    validationStrategy: sections["VALIDATION STRATEGY"],
    raw,
  };
}
