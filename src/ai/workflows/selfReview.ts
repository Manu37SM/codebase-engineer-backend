import type { DB } from "../../db/index.js";
import type { FindingRecord } from "../../db/findingRepo.js";
import type { PatchRecord } from "../../db/patchRepo.js";
import type { ProviderConfig } from "../provider/registry.js";
import type { AICompletionResult } from "../provider/types.js";
import type { ContextBundle, FileForSelection } from "../context/types.js";
import { runFindingWorkflow, findingSummary, contextSections } from "./runFindingWorkflow.js";
import { parseStructuredSections } from "./parseStructuredResponse.js";

export const SELF_REVIEW_OPERATION_TYPE = "patch-self-review";

export interface SelfReviewOptions {
  db: DB;
  projectId: string;
  projectRoot: string;
  finding: FindingRecord;
  patch: PatchRecord;
  files: FileForSelection[];

  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

export interface SelfReviewCheck {
  status: "pass" | "concern" | "fail" | null;
  note: string | null;
}

export interface ParsedSelfReview {
  correctness: SelfReviewCheck;
  scopeCreep: SelfReviewCheck;
  regressions: SelfReviewCheck;
  security: SelfReviewCheck;
  missingTests: SelfReviewCheck;
  unnecessaryComplexity: SelfReviewCheck;
  architectureConsistency: SelfReviewCheck;

  raw: string;
}

export interface SelfReviewResult {
  requestId: string;
  bundle: ContextBundle;
  review: ParsedSelfReview;
  provider: string;
  model: string;
  usage: AICompletionResult["usage"];
}

export async function selfReviewPatch(options: SelfReviewOptions): Promise<SelfReviewResult> {
  const { patch } = options;
  if (!patch.diff_text) {
    throw new Error("Cannot self-review a patch with no diff_text yet.");
  }

  const result = await runFindingWorkflow({
    ...options,
    operationType: SELF_REVIEW_OPERATION_TYPE,
    patchId: patch.id,
    buildPrompt: (finding, bundle) => buildSelfReviewPrompt(finding, bundle, patch.diff_text!),
  });

  return {
    requestId: result.requestId,
    bundle: result.bundle,
    review: parseSelfReviewSections(result.content),
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  };
}

const SELF_REVIEW_HEADERS = [
  "CORRECTNESS",
  "SCOPE_CREEP",
  "REGRESSIONS",
  "SECURITY",
  "MISSING_TESTS",
  "UNNECESSARY_COMPLEXITY",
  "ARCHITECTURE_CONSISTENCY",
];

function buildSelfReviewPrompt(
  finding: FindingRecord,
  bundle: ContextBundle,
  diffText: string
): { system: string; user: string } {
  const system =
    "You are a senior software engineer performing a self-review of a proposed code patch, BEFORE a human " +
    "reviews it. This is advisory only — you are not approving or applying anything, only surfacing concerns " +
    "for the human reviewer. Check the diff against these seven criteria. Respond in EXACTLY this format, " +
    "with these seven section headers on their own line, in this order, each followed by a status word " +
    "(pass, concern, or fail) and a one-sentence note:\n\n" +
    SELF_REVIEW_HEADERS.map((h) => `${h}: pass|concern|fail - <one-sentence note>`).join("\n") +
    "\n\nWhere the checks mean:\n" +
    "- CORRECTNESS: does the diff actually fix the finding described below?\n" +
    "- SCOPE_CREEP: does the diff change anything beyond what's needed to fix the finding?\n" +
    "- REGRESSIONS: could this diff plausibly break existing behavior shown in the relevant code?\n" +
    "- SECURITY: does the diff introduce or fail to address any security concern?\n" +
    "- MISSING_TESTS: does this change need a test that doesn't already exist?\n" +
    "- UNNECESSARY_COMPLEXITY: is there a simpler way to make the same fix?\n" +
    "- ARCHITECTURE_CONSISTENCY: does the diff follow the patterns already used in the shown code?\n\n" +
    "Do not add any other sections, and do not propose a different diff — only assess the one shown.";

  const user = `Finding:\n${findingSummary(finding)}\n\nProposed patch (unified diff):\n${diffText}\n\nRelevant code:\n${contextSections(bundle)}`;

  return { system, user };
}

export function parseSelfReviewSections(raw: string): ParsedSelfReview {
  const sections = parseStructuredSections(raw, SELF_REVIEW_HEADERS);
  return {
    correctness: parseCheck(sections.CORRECTNESS),
    scopeCreep: parseCheck(sections.SCOPE_CREEP),
    regressions: parseCheck(sections.REGRESSIONS),
    security: parseCheck(sections.SECURITY),
    missingTests: parseCheck(sections.MISSING_TESTS),
    unnecessaryComplexity: parseCheck(sections.UNNECESSARY_COMPLEXITY),
    architectureConsistency: parseCheck(sections.ARCHITECTURE_CONSISTENCY),
    raw,
  };
}

function parseCheck(section: string | null): SelfReviewCheck {
  if (!section) return { status: null, note: null };
  const match = section.match(/^(pass|concern|fail)\b\s*[-:]?\s*(.*)$/is);
  if (!match) return { status: null, note: section };
  const status = match[1].toLowerCase() as "pass" | "concern" | "fail";
  const note = match[2].trim() || null;
  return { status, note };
}
