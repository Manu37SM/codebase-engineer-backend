import type { DB } from "../../db/index.js";
import type { FindingRecord } from "../../db/findingRepo.js";
import type { ProviderConfig } from "../provider/registry.js";
import type { AICompletionResult } from "../provider/types.js";
import type { ContextBundle, FileForSelection } from "../context/types.js";
import { runFindingWorkflow, findingSummary, contextSections } from "./runFindingWorkflow.js";
import { parseStructuredSections, parseBulletList } from "./parseStructuredResponse.js";

export const ROOT_CAUSE_ANALYSIS_OPERATION_TYPE = "root-cause-analysis";

export interface RootCauseAnalysisOptions {
  db: DB;
  projectId: string;
  projectRoot: string;
  finding: FindingRecord;
  files: FileForSelection[];
  /** The row from `provider_configuration` to use — the caller (the route) is responsible for picking an enabled one. */
  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

/**
 * The parsed form of the model's response, per docs/AI_MODE.md §4's
 * "root cause analysis" step in the AI workflow: evidence (what the shown
 * code actually demonstrates) kept distinct from inference (what the
 * model believes is going on beyond what's directly visible), plus a
 * self-reported confidence level. Any field the model's response doesn't
 * clearly contain is left `null` rather than guessed — `parseSections`
 * never invents structure the response doesn't have.
 */
export interface ParsedRootCauseAnalysis {
  evidence: string[] | null;
  inference: string | null;
  confidence: "high" | "medium" | "low" | null;
  /** The full, unparsed model response — always present, so a parsing miss never loses information, just structure. */
  raw: string;
}

export interface RootCauseAnalysisResult {
  requestId: string;
  bundle: ContextBundle;
  analysis: ParsedRootCauseAnalysis;
  provider: string;
  model: string;
  usage: AICompletionResult["usage"];
}

/**
 * Phase 15's AI workflow: like Phase 14's `explainFinding`, but asks the
 * provider to separate what the code shown actually demonstrates
 * (evidence) from what it believes is the underlying cause beyond that
 * (inference) — the "Root Cause Analysis" step in docs/AI_MODE.md §4's
 * workflow diagram, distinct from the plainer prose Phase 14 asks for.
 * Shares the exact same context-selection, provider-call, and accounting
 * plumbing as `explainFinding` via `runFindingWorkflow` — only the prompt
 * and the response parsing differ.
 *
 * Like Phase 14, this is read-only. Fix planning (structured 7-part plan)
 * is a separate, later workflow (Phase 16) that will likely consume this
 * one's output, not be folded into it.
 */
export async function analyzeRootCause(options: RootCauseAnalysisOptions): Promise<RootCauseAnalysisResult> {
  const result = await runFindingWorkflow({
    ...options,
    operationType: ROOT_CAUSE_ANALYSIS_OPERATION_TYPE,
    buildPrompt: buildRootCausePrompt,
  });

  return {
    requestId: result.requestId,
    bundle: result.bundle,
    analysis: parseRootCauseSections(result.content),
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  };
}

function buildRootCausePrompt(finding: FindingRecord, bundle: ContextBundle): { system: string; user: string } {
  const system =
    "You are a senior software engineer performing root-cause analysis on a static-analysis finding. " +
    "Respond in EXACTLY this format, with these three section headers on their own line, in this order:\n\n" +
    "EVIDENCE:\n" +
    "- one bullet per fact you can directly point to in the code shown (quote a line or symbol name for each)\n\n" +
    "INFERENCE:\n" +
    "One paragraph explaining what you believe the underlying root cause is, going beyond what's directly " +
    "visible in the shown code where reasoning is required. Clearly distinguish this from EVIDENCE — do not " +
    "restate evidence here.\n\n" +
    "CONFIDENCE: high | medium | low\n\n" +
    "Do not add any other sections, and do not propose a fix.";

  const user = `Finding:\n${findingSummary(finding)}\n\nRelevant code:\n${contextSections(bundle)}`;

  return { system, user };
}

const ROOT_CAUSE_HEADERS = ["EVIDENCE", "INFERENCE", "CONFIDENCE"];

/**
 * Parses the model's EVIDENCE/INFERENCE/CONFIDENCE-formatted response via
 * the shared `parseStructuredSections` (Phase 16 factored this out of a
 * bespoke regex pair once fix planning needed the same "split into named
 * sections, honestly" logic for 7 headers instead of 3 — this file's own
 * bug, caught by test before Phase 16 existed, is what motivated making
 * the terminator logic generic in the first place). Providers don't
 * reliably follow formatting instructions, so this is best-effort: a
 * field that doesn't match its expected shape is left `null` (never
 * fabricated), while `raw` always preserves the complete, unparsed
 * response so nothing the model said is ever lost to a parsing miss.
 */
export function parseRootCauseSections(raw: string): ParsedRootCauseAnalysis {
  const sections = parseStructuredSections(raw, ROOT_CAUSE_HEADERS);
  // Only the leading word is checked (not exact-equals) — the model may
  // add trailing commentary after the confidence word (e.g. "high (very
  // confident given the direct evidence)"), which should still parse.
  const confidenceMatch = sections.CONFIDENCE?.match(/^(high|medium|low)\b/i);
  const confidence = confidenceMatch ? (confidenceMatch[1].toLowerCase() as "high" | "medium" | "low") : null;

  return {
    evidence: parseBulletList(sections.EVIDENCE),
    inference: sections.INFERENCE,
    confidence,
    raw,
  };
}
