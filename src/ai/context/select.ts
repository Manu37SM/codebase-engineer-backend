import fs from "node:fs";
import { resolveWithinRoot } from "../../security/paths.js";
import { redactSecretsInText } from "../../security/secretPatterns.js";
import { resolveImports, type ImportableFile } from "../../architecture/resolveImports.js";
import { getUncommittedDiffForFile } from "../../git/fileDiff.js";
import { detectGit } from "../../discovery/git.js";
import { estimateTokens as defaultEstimateTokens } from "../tokenEstimate.js";
import type { ContextBundle, ContextItem, ExcludedItem, FileForSelection, FindingTarget } from "./types.js";

const MANIFEST_FILES = ["package.json", "pom.xml"];
/** Line-window sizes (lines of context on each side of the finding) tried, largest first, when the full primary file doesn't fit the budget. */
const WINDOW_SIZES = [200, 80, 30, 10];

interface Candidate {
  /** Display path — usually a real file's relative path; the Git-diff item uses a synthetic label since it isn't file content. */
  path: string;
  reason: string;
  /** Lazily computed (and already redacted) so we never read/redact a file we won't end up considering. */
  getContent: () => string | null;
  /** True only for the primary file — the one candidate eligible for line-windowed truncation instead of a hard include/exclude. */
  isPrimary?: boolean;
}

export interface SelectContextOptions {
  root: string;
  finding: FindingTarget;
  files: FileForSelection[];
  budgetTokens: number;
  estimateTokensFn?: (text: string) => number;
  /**
   * When true, each selected item's actual (redacted) text is attached as
   * `content`. Defaults to false so the existing preview API/UI (Phase 13)
   * keeps returning the lightweight summary docs/AI_MODE.md §3 defines,
   * without every finding-context request paying to serialize full file
   * bodies over HTTP. Phase 14's `explainFinding` workflow, which actually
   * builds a prompt from this content, passes `true`.
   */
  includeContent?: boolean;
}

/**
 * Builds a `ContextBundle` for a `Finding` target, per docs/AI_MODE.md §3's
 * selection order: directly affected file → directly relevant methods/
 * functions → imported symbols used at the finding site → known callers →
 * associated test file(s) → relevant config → relevant Git diff hunk.
 *
 * "Directly relevant methods/functions" is approximated by windowing the
 * primary file around the finding's line range when the full file doesn't
 * fit the budget — this product has no AST parser (imports are
 * regex-extracted, same documented tradeoff as everywhere else), so true
 * function-boundary extraction isn't attempted rather than faked.
 *
 * Every candidate's content is redacted (`security/secretPatterns.ts`)
 * before it's ever counted toward the budget — per docs/SECURITY.md §4,
 * redaction happens before network egress, not after, and this is the
 * only place in the codebase content is assembled for that purpose.
 */
export function selectContextForFinding(options: SelectContextOptions): ContextBundle {
  const { root, finding, files, budgetTokens } = options;
  const estimateTokensFn = options.estimateTokensFn ?? defaultEstimateTokens;
  const includeContent = options.includeContent ?? false;

  const primaryFile = files.find((f) => f.relativePath === finding.filePath);
  const candidates: Candidate[] = [];

  // 1. Directly affected file (handled specially below for windowing — not
  // pushed through the generic candidate list since it needs different
  // include/exclude logic).

  // 2. Imported symbols used at the finding site, and 3. known callers —
  // both derived from the same file-level import graph the Architecture
  // explorer and the missing-test-file rule already use.
  const importable: ImportableFile[] = files.map((f) => ({
    relativePath: f.relativePath,
    language: f.language,
    imports: f.imports,
  }));
  const { edges } = resolveImports(importable);

  const importedPaths = edges.filter((e) => e.fromPath === finding.filePath).map((e) => e.toPath);
  const callerPaths = edges.filter((e) => e.toPath === finding.filePath).map((e) => e.fromPath);

  for (const importedPath of dedupe(importedPaths)) {
    candidates.push({
      path: importedPath,
      reason: `Imported by ${finding.filePath}, the file where the finding was reported.`,
      getContent: () => readAndRedact(root, importedPath),
    });
  }

  // Test-file callers get their own, more specific candidate below — skip
  // them here so a test-file caller doesn't appear twice with two reasons.
  const nonTestCallerPaths = callerPaths.filter((p) => !files.find((f) => f.relativePath === p)?.isTest);
  for (const callerPath of dedupe(nonTestCallerPaths)) {
    candidates.push({
      path: callerPath,
      reason: `Imports ${finding.filePath} — a known caller of the affected file.`,
      getContent: () => readAndRedact(root, callerPath),
    });
  }

  // 4. Associated test file(s): prefer a caller that's itself a test file
  // (the same usage-based signal the missing-test-file rule uses); fall
  // back to the naming-convention check only if no test file imports it.
  const callerTestPaths = callerPaths.filter((p) => files.find((f) => f.relativePath === p)?.isTest);
  if (callerTestPaths.length > 0) {
    for (const testPath of dedupe(callerTestPaths)) {
      candidates.push({
        path: testPath,
        reason: `Test file that imports ${finding.filePath}.`,
        getContent: () => readAndRedact(root, testPath),
      });
    }
  } else {
    const conventionTestPath = findTestByNamingConvention(finding.filePath, files);
    if (conventionTestPath) {
      candidates.push({
        path: conventionTestPath,
        reason: `Test file matching ${finding.filePath}'s naming convention (no importing test file found).`,
        getContent: () => readAndRedact(root, conventionTestPath),
      });
    }
  }

  // 5. Relevant config — this product's manifest-based dependency analysis
  // (Phase 10) only looks at a root-level package.json/pom.xml, so that's
  // the same "relevant config" this reuses, rather than inventing a
  // separate per-directory config resolution strategy.
  for (const manifestName of MANIFEST_FILES) {
    if (files.some((f) => f.relativePath === manifestName)) {
      candidates.push({
        path: manifestName,
        reason: "Project's main dependency manifest, for build/framework context.",
        getContent: () => readAndRedact(root, manifestName),
      });
      break; // at most one — a project has either an npm or a Maven manifest, not both, per Phase 10's dependency analyzer.
    }
  }

  // 6. Relevant Git diff hunk — only meaningful if the primary file has
  // uncommitted changes; skipped entirely (not even considered, let alone
  // excluded-for-budget) when it doesn't, or the repo has no Git history.
  if (detectGit(root).isGitRepository) {
    const diffLabel = `${finding.filePath} (uncommitted diff)`;
    candidates.push({
      path: diffLabel,
      reason: `Uncommitted changes to ${finding.filePath} since the last commit.`,
      getContent: () => {
        const diff = getUncommittedDiffForFile(root, finding.filePath);
        return diff === null ? null : redactSecretsInText(diff).text;
      },
    });
  }

  const selected: ContextItem[] = [];
  const excluded: ExcludedItem[] = [];
  let remaining = budgetTokens;

  // Primary file first, with windowing if the full file doesn't fit.
  if (primaryFile) {
    const full = readAndRedact(root, finding.filePath);
    if (full === null) {
      excluded.push({ path: finding.filePath, reason: "Directly affected file could not be read from disk." });
    } else {
      const fullTokens = estimateTokensFn(full);
      if (fullTokens <= remaining) {
        selected.push({
          path: finding.filePath,
          reason: "Directly affected file — where the finding was reported.",
          tokens: fullTokens,
          ...(includeContent ? { content: full } : {}),
        });
        remaining -= fullTokens;
      } else {
        const windowed = windowAroundFinding(full, finding, remaining, estimateTokensFn);
        if (windowed) {
          selected.push({
            path: finding.filePath,
            reason: `Directly affected file, showing lines ${windowed.startLine}-${windowed.endLine} around the finding (full file needs ~${fullTokens} tokens, exceeding the remaining budget).`,
            tokens: windowed.tokens,
            ...(includeContent ? { content: windowed.content } : {}),
          });
          remaining -= windowed.tokens;
        } else {
          excluded.push({
            path: finding.filePath,
            reason: `Even a small window around the finding exceeds the remaining context budget (~${fullTokens} tokens needed for the full file, ${remaining} remaining).`,
          });
        }
      }
    }
  } else {
    excluded.push({ path: finding.filePath, reason: "File is not in the current index — it may have been deleted or renamed since the last scan." });
  }

  for (const candidate of candidates) {
    const content = candidate.getContent();
    if (content === null) {
      // Not an exclusion in the "budget" sense — the item genuinely has
      // nothing to contribute (e.g. no uncommitted diff), so it's simply
      // not selected, not reported as a budget casualty.
      continue;
    }
    const tokens = estimateTokensFn(content);
    if (tokens <= remaining) {
      selected.push({
        path: candidate.path,
        reason: candidate.reason,
        tokens,
        ...(includeContent ? { content } : {}),
      });
      remaining -= tokens;
    } else {
      excluded.push({
        path: candidate.path,
        reason: `${candidate.reason} Excluded: needs ~${tokens} tokens, ${remaining} remaining in the budget.`,
      });
    }
  }

  return {
    targetId: finding.id,
    budgetTokens,
    selected,
    excluded,
    totalTokens: selected.reduce((sum, item) => sum + item.tokens, 0),
  };
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

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function findTestByNamingConvention(filePath: string, files: FileForSelection[]): string | null {
  const lastSlash = filePath.lastIndexOf("/");
  const dir = lastSlash === -1 ? "" : filePath.slice(0, lastSlash);
  const fileName = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
  const dotIdx = fileName.lastIndexOf(".");
  const baseName = dotIdx === -1 ? fileName : fileName.slice(0, dotIdx);
  const ext = dotIdx === -1 ? "" : fileName.slice(dotIdx);

  const candidates = [
    `${baseName}.test${ext}`,
    `${baseName}.spec${ext}`,
    `${baseName}Test${ext}`,
    `${baseName}Tests${ext}`,
    `${baseName}IT${ext}`,
  ];
  for (const file of files) {
    const name = file.relativePath.slice(file.relativePath.lastIndexOf("/") + 1);
    const fileDir = file.relativePath.slice(0, file.relativePath.length - name.length - 1);
    if (fileDir !== dir) continue;
    if (candidates.includes(name)) return file.relativePath;
  }
  return null;
}

interface WindowResult {
  content: string;
  startLine: number;
  endLine: number;
  tokens: number;
}

function windowAroundFinding(
  fullText: string,
  finding: FindingTarget,
  budget: number,
  estimateTokensFn: (text: string) => number
): WindowResult | null {
  const lines = fullText.split("\n");
  const center = finding.lineStart ?? 1;
  const centerEnd = finding.lineEnd ?? center;

  for (const contextLines of WINDOW_SIZES) {
    const startLine = Math.max(1, center - contextLines);
    const endLine = Math.min(lines.length, centerEnd + contextLines);
    const windowed = lines.slice(startLine - 1, endLine).join("\n");
    const tokens = estimateTokensFn(windowed);
    if (tokens <= budget) {
      return { content: windowed, startLine, endLine, tokens };
    }
  }
  return null;
}
