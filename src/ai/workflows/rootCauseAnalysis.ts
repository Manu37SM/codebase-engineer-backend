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

  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

export interface ParsedRootCauseAnalysis {
  evidence: string[] | null;
  inference: string | null;
  confidence: "high" | "medium" | "low" | null;

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

export function parseRootCauseSections(raw: string): ParsedRootCauseAnalysis {
  const sections = parseStructuredSections(raw, ROOT_CAUSE_HEADERS);

  const confidenceMatch = sections.CONFIDENCE?.match(/^(high|medium|low)\b/i);
  const confidence = confidenceMatch ? (confidenceMatch[1].toLowerCase() as "high" | "medium" | "low") : null;

  return {
    evidence: parseBulletList(sections.EVIDENCE),
    inference: sections.INFERENCE,
    confidence,
    raw,
  };
}
