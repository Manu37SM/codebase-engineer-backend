import fs from "node:fs";
import { resolveWithinRoot } from "../../security/paths.js";
import { redactSecretsInText } from "../../security/secretPatterns.js";
import { resolveImports, type ImportableFile } from "../../architecture/resolveImports.js";
import { estimateTokens as defaultEstimateTokens } from "../tokenEstimate.js";
import type { ContextBundle, ContextItem, ExcludedItem, FileForSelection, TestFailureTarget } from "./types.js";

const OUTPUT_TAIL_CHARS = 8000;

const MAX_REFERENCED_FILES = 5;

const MAX_IMPORTED_MODULES = 3;

export interface SelectContextForTestFailureOptions {
  root: string;
  testRun: TestFailureTarget;
  files: FileForSelection[];
  budgetTokens: number;
  estimateTokensFn?: (text: string) => number;

  includeContent?: boolean;
}

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
      if (matches.some((m) => m.file.relativePath === importedPath)) continue; 
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
