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
  /** The row from `provider_configuration` to use — the caller (the route) is responsible for picking an enabled one. */
  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

/** One of docs/AI_MODE.md §6's seven self-review checklist items. `status` is `null`, never guessed, when the response didn't clearly state one. */
export interface SelfReviewCheck {
  status: "pass" | "concern" | "fail" | null;
  note: string | null;
}

/**
 * The parsed form of the model's response, per docs/AI_MODE.md §6's
 * self-review checklist, applied to a real proposed patch (its diff)
 * rather than a Finding or a TestRun. Every field the response doesn't
 * clearly address is left with a `null` status/note — never fabricated —
 * same honesty rule every other structured-response parser in this
 * codebase follows.
 */
export interface ParsedSelfReview {
  correctness: SelfReviewCheck;
  scopeCreep: SelfReviewCheck;
  regressions: SelfReviewCheck;
  security: SelfReviewCheck;
  missingTests: SelfReviewCheck;
  unnecessaryComplexity: SelfReviewCheck;
  architectureConsistency: SelfReviewCheck;
  /** The full, unparsed model response — always present, so a parsing miss never loses information, just structure. */
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

/**
 * Phase 21's AI workflow: docs/AI_MODE.md §6's self-review checklist —
 * correctness, scope creep, regressions, security, missing tests,
 * unnecessary complexity, and consistency with existing architecture —
 * run against a real proposed patch's real diff text. Per §6, "self-
 * review output is shown alongside the diff, not used to auto-approve":
 * this is advisory only, exactly like Phase 15's root-cause analysis and
 * Phase 20's failure diagnosis. It never changes the patch's `status`,
 * never blocks `/approve-apply` or `/apply`, and can be requested (or
 * re-requested) at any point once a patch has a real `diff_text` —
 * there's no separate approval gate for it, because it isn't one.
 *
 * Reuses `runFindingWorkflow` (self-review's grounding is the same
 * Finding + context-bundle shape generation itself used — the patch adds
 * only its diff text on top, not a different target kind), unlike Phase
 * 20's `diagnoseFailure`, which genuinely needed a different context
 * shape for a `TestRun` target.
 */
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

/**
 * Parses the model's seven-checklist response via the shared
 * `parseStructuredSections` root-cause analysis, fix planning, and
 * failure diagnosis all use. Each section is expected to start with a
 * pass/concern/fail status word followed by a note (e.g. "concern - the
 * diff also reformats an unrelated function"); a section that doesn't
 * match that shape gets `status: null` but keeps whatever text was there
 * as `note`, so nothing the model said is silently dropped even when it
 * doesn't follow the exact format.
 */
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
