import { randomUUID } from "node:crypto";
import type { DB } from "../../db/index.js";
import type { TestRunRecord } from "../../db/testRunRepo.js";
import { createAIRequest, createAIResponse, markAIRequestStatus } from "../../db/aiRequestRepo.js";
import { createProvider, type ProviderConfig } from "../provider/registry.js";
import type { AICompletionResult } from "../provider/types.js";
import { selectContextForTestFailure } from "../context/selectContextForTestFailure.js";
import type { ContextBundle, FileForSelection } from "../context/types.js";
import { parseStructuredSections, parseBulletList } from "./parseStructuredResponse.js";

export const FAILURE_DIAGNOSIS_OPERATION_TYPE = "failure-diagnosis";

const DEFAULT_BUDGET_TOKENS = 4000;

export interface DiagnoseFailureOptions {
  db: DB;
  projectId: string;
  projectRoot: string;
  testRun: TestRunRecord;
  files: FileForSelection[];

  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

export interface ParsedFailureDiagnosis {
  likelyCause: string | null;
  evidence: string[] | null;
  suggestedDirection: string | null;

  raw: string;
}

export interface DiagnoseFailureResult {
  requestId: string;
  bundle: ContextBundle;
  diagnosis: ParsedFailureDiagnosis;
  provider: string;
  model: string;
  usage: AICompletionResult["usage"];
}

export async function diagnoseFailure(options: DiagnoseFailureOptions): Promise<DiagnoseFailureResult> {
  const { db, projectId, projectRoot, testRun, files, providerConfig } = options;
  const budgetTokens = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

  const bundle = selectContextForTestFailure({
    root: projectRoot,
    testRun: {
      id: testRun.id,
      command: testRun.command,
      framework: testRun.framework,
      stdout: testRun.stdout_ref ?? "",
      stderr: testRun.stderr_ref ?? "",
    },
    files,
    budgetTokens,
    includeContent: true,
  });

  const provider = createProvider(providerConfig);
  const prompt = buildDiagnosisPrompt(testRun, bundle);
  const estimatedTokens = provider.estimateTokens(prompt.system) + provider.estimateTokens(prompt.user);

  const requestId = randomUUID();
  createAIRequest(db, requestId, {
    projectId,
    findingId: null,
    testRunId: testRun.id,
    provider: providerConfig.kind,
    model: providerConfig.model ?? "unknown",
    operationType: FAILURE_DIAGNOSIS_OPERATION_TYPE,
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
      diagnosis: parseFailureDiagnosisSections(result.content),
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

function buildDiagnosisPrompt(testRun: TestRunRecord, bundle: ContextBundle): { system: string; user: string } {
  const system =
    "You are a senior software engineer diagnosing a failed automated test run. " +
    "Respond in EXACTLY this format, with these three section headers on their own line, in this order:\n\n" +
    "LIKELY_CAUSE:\n" +
    "One paragraph stating your best hypothesis for why the run failed.\n\n" +
    "EVIDENCE:\n" +
    "- one bullet per fact you can directly point to in the captured output or shown code (quote a line, " +
    "error message, or symbol name for each)\n\n" +
    "SUGGESTED_DIRECTION:\n" +
    "One short paragraph pointing toward what a fix might involve. Do NOT write a diff, a patch, or code — " +
    "just describe the direction; a human will decide on and generate any actual change separately.\n\n" +
    "Do not add any other sections.";

  const user = `Test run:\n${testRunSummary(testRun)}\n\nCaptured output and referenced code:\n${contextSections(bundle)}`;

  return { system, user };
}

function testRunSummary(testRun: TestRunRecord): string {
  return [
    `Framework: ${testRun.framework ?? "unknown"}`,
    `Command: ${testRun.command ?? "unknown"}`,
    `Exit code: ${testRun.exit_code ?? "null"}`,
    `Passed: ${testRun.passed ?? "unknown"}, Failed: ${testRun.failed ?? "unknown"}, Skipped: ${testRun.skipped ?? "unknown"}`,
  ].join("\n");
}

function contextSections(bundle: ContextBundle): string {
  const sections = bundle.selected
    .filter((item) => item.content !== undefined)
    .map((item) => `--- ${item.path} (${item.reason}) ---\n${item.content}`)
    .join("\n\n");
  return sections || "(no output or code fit within the context budget)";
}

const FAILURE_DIAGNOSIS_HEADERS = ["LIKELY_CAUSE", "EVIDENCE", "SUGGESTED_DIRECTION"];

export function parseFailureDiagnosisSections(raw: string): ParsedFailureDiagnosis {
  const sections = parseStructuredSections(raw, FAILURE_DIAGNOSIS_HEADERS);
  return {
    likelyCause: sections.LIKELY_CAUSE,
    evidence: parseBulletList(sections.EVIDENCE),
    suggestedDirection: sections.SUGGESTED_DIRECTION,
    raw,
  };
}
