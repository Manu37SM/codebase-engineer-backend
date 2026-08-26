import type { DB } from "../../db/index.js";
import type { FindingRecord } from "../../db/findingRepo.js";
import type { ProviderConfig } from "../provider/registry.js";
import type { AICompletionResult } from "../provider/types.js";
import type { ContextBundle, FileForSelection } from "../context/types.js";
import { getLatestSuccessfulResponse } from "../../db/aiRequestRepo.js";
import { runFindingWorkflow, findingSummary, contextSections } from "./runFindingWorkflow.js";
import { FIX_PLAN_OPERATION_TYPE, parseFixPlanSections } from "./fixPlan.js";
import { parseStructuredSections } from "./parseStructuredResponse.js";

export const GENERATE_TEST_OPERATION_TYPE = "test-generation";

export interface GeneratedTestData {

  targetPath: string | null;

  testCode: string | null;
  raw: string;
}

export interface GenerateTestOptions {
  db: DB;
  projectId: string;
  projectRoot: string;
  finding: FindingRecord;
  files: FileForSelection[];

  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

export interface GenerateTestResult {
  requestId: string;
  bundle: ContextBundle;
  data: GeneratedTestData;
  usedFixPlan: boolean;
  provider: string;
  model: string;
  usage: AICompletionResult["usage"];
}

export async function generateTest(options: GenerateTestOptions): Promise<GenerateTestResult> {
  const priorFixPlan = getLatestSuccessfulResponse(options.db, options.finding.id, FIX_PLAN_OPERATION_TYPE);
  const requiredTestsHint = priorFixPlan ? parseFixPlanSections(priorFixPlan.content ?? "").requiredTests : null;

  const result = await runFindingWorkflow({
    ...options,
    operationType: GENERATE_TEST_OPERATION_TYPE,
    buildPrompt: (finding, bundle) => buildTestPrompt(finding, bundle, requiredTestsHint),
  });

  return {
    requestId: result.requestId,
    bundle: result.bundle,
    data: parseGeneratedTest(result.content),
    usedFixPlan: priorFixPlan !== undefined,
    provider: result.provider,
    model: result.model,
    usage: result.usage,
  };
}

function buildTestPrompt(
  finding: FindingRecord,
  bundle: ContextBundle,
  requiredTestsHint: string | null
): { system: string; user: string } {
  const system =
    "You are a senior software engineer writing a NEW automated test file for a static-analysis finding. " +
    "The test must be a complete, real, runnable file in the project's existing test framework and conventions, " +
    "based only on the code shown — never invent APIs or behavior the code doesn't have. A human will review it, " +
    "and it will actually be executed before anyone trusts it. Respond with exactly two sections, in this order, " +
    "and nothing else:\n\n" +
    "TARGET_PATH:\n" +
    "A single project-root-relative path (forward slashes) for a NEW test file that does not already exist — " +
    "do not choose a path that would overwrite an existing file.\n\n" +
    "TEST_CODE:\n" +
    "The complete content of that file, and nothing else in this section (no markdown code fences, no commentary).\n\n" +
    "If you cannot confidently produce a real test from the code shown, respond with exactly: " +
    "NO_TEST: <a one-line reason>, and omit both sections.";

  const requiredTestsSection = requiredTestsHint
    ? `\n\nThe approved fix plan's "Required tests" section for this finding says:\n${requiredTestsHint}`
    : "";

  const user = `Finding:\n${findingSummary(finding)}${requiredTestsSection}\n\nRelevant code:\n${contextSections(bundle)}`;

  return { system, user };
}

const NO_TEST_PATTERN = /^\s*NO_TEST:/i;

export function parseGeneratedTest(raw: string): GeneratedTestData {
  if (NO_TEST_PATTERN.test(raw)) {
    return { targetPath: null, testCode: null, raw };
  }

  const sections = parseStructuredSections(raw, ["TARGET_PATH", "TEST_CODE"]);
  const targetPath = sections.TARGET_PATH ? sections.TARGET_PATH.trim().split("\n")[0].trim() : null;
  const testCode = sections.TEST_CODE ? stripCodeFence(sections.TEST_CODE) : null;

  return { targetPath: targetPath || null, testCode, raw };
}

function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/^```[^\n]*\n([\s\S]*?)\n```\s*$/);
  return fenceMatch ? fenceMatch[1] : text;
}
