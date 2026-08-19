import fs from "node:fs";
import { resolveWithinRoot } from "../../security/paths.js";
import { redactSecretsInText } from "../../security/secretPatterns.js";
import { resolveImports, type ImportableFile } from "../../architecture/resolveImports.js";
import { estimateTokens as defaultEstimateTokens } from "../tokenEstimate.js";
import type { ContextBundle, ContextItem, ExcludedItem, FileForSelection, TestFailureTarget } from "./types.js";

/**
 * How much of the captured stdout/stderr to consider as the primary
 * evidence item, taken from the END of the combined, redacted output —
 * both this product's supported test runners (Vitest, Maven Surefire)
 * print a pass/fail summary and the actual failure detail (assertion
 * diff, stack trace) near the end of the run, with setup/progress noise
 * earlier. This is a length cap in characters, applied before token
 * budgeting, so a truly enormous run's output doesn't get redacted/
 * scanned in full for no benefit.
 */
const OUTPUT_TAIL_CHARS = 8000;
/** How many distinct file paths (beyond the output excerpt itself) are considered as content candidates. */
const MAX_REFERENCED_FILES = 5;
/** How many of a matched failing test file's own imports are pulled in as secondary candidates. */
const MAX_IMPORTED_MODULES = 3;

export interface SelectContextForTestFailureOptions {
  root: string;
  testRun: TestFailureTarget;
  files: FileForSelection[];
  budgetTokens: number;
  estimateTokensFn?: (text: string) => number;
  /** Same meaning as `SelectContextOptions.includeContent` in `select.ts` — attach real (redacted) text, not just the summary. */
  includeContent?: boolean;
}

/**
 * Builds a `ContextBundle` for a failed-`TestRun` target — Phase 20's
 * diagnosis workflow, and the first real implementation of the
 * `TestFailureTarget` docs/AI_MODE.md §3 named but deferred (see
 * `context/types.ts`'s note on `FindingTarget`).
 *
 * Unlike `selectContextForFinding`, there's no single file/line to anchor
 * on — a test failure's relevant context has to be inferred from the
 * captured output itself: which of the project's real indexed files does
 * it actually mention? This never guesses at a failing file from the test
 * *command* alone (which usually just names a whole suite, not a single
 * file) — it only trusts what the output text itself references, kept
 * consistent with this codebase's "never fabricate evidence" rule for
 * deterministic analysis rules (`docs/ARCHITECTURE.md` §6), applied here
 * to context selection instead.
 *
 * Selection order: the captured output excerpt itself (always the primary
 * item — without it there is nothing to diagnose, so unlike a Finding's
 * primary file this is truncated-to-fit rather than ever fully excluded)
 * → real project files whose path text appears in that output, ranked
 * test-files-first then by mention count → the top-ranked matched test
 * file's own imports (the modules it likely exercises). Every candidate's
 * content is redacted before being counted toward the budget, exactly as
 * `selectContextForFinding` does.
 */
export function selectContextForTestFailure(options: SelectContextForTestFailureOptions): ContextBundle {
  const { root, testRun, files, budgetTokens } = options;
  const estimateTokensFn = options.estimateTokensFn ?? defaultEstimateTokens;
  const includeContent = options.includeContent ?? false;

  const redactedStdout = redactSecretsInText(testRun.stdout ?? "").text;
  const redactedStderr = redactSecretsInText(testRun.stderr ?? "").text;
  const combined = [redactedStdout, redactedStderr].filter(Boolean).join("\n");
  const excerpt = combined.length > OUTPUT_TAIL_CHARS ? combined.slice(-OUTPUT_TAIL_CHARS) : combined;

  const selected: ContextItem[] = [];
  const excluded: ExcludedItem[] = [];
  let remaining = budgetTokens;

  // Primary item: the captured output itself. Truncated-to-fit rather
  // than excluded outright, since a diagnosis with zero evidence isn't
  // useful — the model should at least see *something* real.
  if (excerpt.trim().length === 0) {
    excluded.push({ path: "(test run output)", reason: "The test run captured no stdout or stderr." });
  } else {
    const excerptReason =
      combined.length > OUTPUT_TAIL_CHARS
        ? `Captured output from the failed test run (last ${OUTPUT_TAIL_CHARS} characters of ${combined.length} total).`
        : "Captured output from the failed test run.";
    const fitted = fitToBudget(excerpt, remaining, estimateTokensFn);
    if (fitted) {
      selected.push({
        path: "(test run output)",
        reason: fitted.truncatedFurther
          ? `${excerptReason} Further truncated to fit the context budget.`
          : excerptReason,
        tokens: fitted.tokens,
        ...(includeContent ? { content: fitted.content } : {}),
      });
      remaining -= fitted.tokens;
    } else {
      excluded.push({
        path: "(test run output)",
        reason: `Even the smallest usable excerpt of the captured output exceeds the context budget (${remaining} tokens remaining).`,
      });
    }
  }

  // Real project files whose path text appears in the captured output —
  // the only signal this trusts, since it's grounded in what the test
  // runner itself printed rather than guessed from the command line.
  const matches = files
    .map((f) => ({ file: f, count: countOccurrences(combined, f.relativePath) }))
    .filter((m) => m.count > 0)
    .sort((a, b) => Number(b.file.isTest) - Number(a.file.isTest) || b.count - a.count)
    .slice(0, MAX_REFERENCED_FILES);

  for (const { file, count } of matches) {
    const content = readAndRedact(root, file.relativePath);
    if (content === null) continue;
    const reason = `Path referenced in the failed test run's output (${count} time${count === 1 ? "" : "s"}).`;
    addCandidate(file.relativePath, reason, content);
  }

  // The top-ranked matched test file's own imports — likely the modules
  // actually under test, the same "imported symbols used at the failure
  // site" idea `selectContextForFinding` applies to a Finding's file.
  const topTestFile = matches.find((m) => m.file.isTest)?.file;
  if (topTestFile) {
    const importable: ImportableFile[] = files.map((f) => ({
      relativePath: f.relativePath,
      language: f.language,
      imports: f.imports,
    }));
    const { edges } = resolveImports(importable);
    const importedPaths = Array.from(
      new Set(edges.filter((e) => e.fromPath === topTestFile.relativePath).map((e) => e.toPath))
    ).slice(0, MAX_IMPORTED_MODULES);

    for (const importedPath of importedPaths) {
      if (matches.some((m) => m.file.relativePath === importedPath)) continue; // already added above
      const content = readAndRedact(root, importedPath);
      if (content === null) continue;
      addCandidate(
        importedPath,
        `Imported by ${topTestFile.relativePath}, the test file referenced in the failure output — likely a module under test.`,
        content
      );
    }
  }

  return {
    targetId: testRun.id,
    budgetTokens,
    selected,
    excluded,
    totalTokens: selected.reduce((sum, item) => sum + item.tokens, 0),
  };

  function addCandidate(path: string, reason: string, content: string): void {
    const tokens = estimateTokensFn(content);
    if (tokens <= remaining) {
      selected.push({ path, reason, tokens, ...(includeContent ? { content } : {}) });
      remaining -= tokens;
    } else {
      excluded.push({
        path,
        reason: `${reason} Excluded: needs ~${tokens} tokens, ${remaining} remaining in the budget.`,
      });
    }
  }
}

function readAndRedact(root: string, relativePath: string): string | null {
  try {
    const resolved = resolveWithinRoot(root, relativePath);
    const raw = fs.readFileSync(resolved, "utf-8");
    return redactSecretsInText(raw).text;
  } catch {
    return null;
  }
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/**
 * Fits the output excerpt into the remaining budget, truncating from the
 * front (keeping the tail, where failure detail lives) in progressively
 * smaller steps if the whole excerpt doesn't fit. Returns `null` only if
 * even a minimal 500-character tail doesn't fit — at that point there's
 * no useful excerpt left to include.
 */
function fitToBudget(
  excerpt: string,
  budget: number,
  estimateTokensFn: (text: string) => number
): { content: string; tokens: number; truncatedFurther: boolean } | null {
  const fullTokens = estimateTokensFn(excerpt);
  if (fullTokens <= budget) {
    return { content: excerpt, tokens: fullTokens, truncatedFurther: false };
  }

  for (const chars of [4000, 2000, 1000, 500]) {
    if (chars >= excerpt.length) continue;
    const truncated = excerpt.slice(-chars);
    const tokens = estimateTokensFn(truncated);
    if (tokens <= budget) {
      return { content: truncated, tokens, truncatedFurther: true };
    }
  }
  return null;
}
