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
  /** The row from `provider_configuration` to use — the caller (the route) is responsible for picking an enabled one. */
  providerConfig: ProviderConfig & { id: string; name: string };
  budgetTokens?: number;
}

/**
 * The parsed form of the model's response, per docs/AI_MODE.md §4's
 * "(if failure) AI Diagnosis" workflow step. Mirrors Phase 15's
 * evidence/inference split (`ParsedRootCauseAnalysis`) but for a test
 * failure instead of a static-analysis finding: LIKELY_CAUSE is the
 * model's hypothesis, EVIDENCE is what it can point to directly in the
 * captured output or shown code, SUGGESTED_DIRECTION is a short pointer
 * toward a fix — deliberately NOT a diff or a fix plan; this workflow is
 * read-only diagnosis, same as root-cause analysis, not patch generation.
 * Any field the response doesn't clearly contain is left `null` rather
 * than guessed.
 */
export interface ParsedFailureDiagnosis {
  likelyCause: string | null;
  evidence: string[] | null;
  suggestedDirection: string | null;
  /** The full, unparsed model response — always present, so a parsing miss never loses information, just structure. */
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

/**
 * Phase 20's AI workflow: docs/AI_MODE.md §4's "Apply Patch → Run Tests →
 * (if failure) AI Diagnosis → Proposed Fix → Review" step. Given a real,
 * already-failed `TestRun` (this product never diagnoses a run that
 * passed — the route enforces that, not this function), builds a Phase 20
 * context bundle from the run's own captured output
 * (`selectContextForTestFailure`) and asks the configured provider to
 * separate a likely-cause hypothesis from the concrete evidence it can
 * point to, plus a short pointer toward a fix direction.
 *
 * Deliberately self-contained rather than routed through
 * `runFindingWorkflow` (Phase 15/16/17's shared plumbing): that helper is
 * built around a `Finding` target end to end (its context bundle, its
 * summary string), and a `TestRun` target's shape is different enough
 * (no file/line, no rule/severity/category) that forcing it through the
 * same function would mean threading a fake `Finding`-shaped adapter
 * through it for no real reuse. If a second TestRun-target workflow shows
 * up later, this is the natural place to factor out shared plumbing —
 * same story as `runFindingWorkflow` itself, which Phase 15 factored out
 * of Phase 14's `explainFinding` once a second Finding-target workflow
 * needed the exact same request/response bookkeeping.
 *
 * Read-only, like root-cause analysis: never writes to the test run or
 * proposes an applied change. A human who wants an actual fix still goes
 * through the existing, human-approval-gated fix-plan → patch-generation
 * → diff-review flow (Phases 16-18) — this workflow's job ends at
 * diagnosis.
 */
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

/**
 * Parses the model's LIKELY_CAUSE/EVIDENCE/SUGGESTED_DIRECTION-formatted
 * response via the same shared `parseStructuredSections` root-cause
 * analysis and fix planning already use. A field that doesn't match its
 * expected shape is left `null` (never fabricated); `raw` always
 * preserves the complete, unparsed response.
 */
export function parseFailureDiagnosisSections(raw: string): ParsedFailureDiagnosis {
  const sections = parseStructuredSections(raw, FAILURE_DIAGNOSIS_HEADERS);
  return {
    likelyCause: sections.LIKELY_CAUSE,
    evidence: parseBulletList(sections.EVIDENCE),
    suggestedDirection: sections.SUGGESTED_DIRECTION,
    raw,
  };
}
