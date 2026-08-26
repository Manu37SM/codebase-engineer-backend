import fs from "node:fs";
import { resolveWithinRoot } from "../../security/paths.js";
import { redactSecretsInText } from "../../security/secretPatterns.js";
import { resolveImports, type ImportableFile } from "../../architecture/resolveImports.js";
import { getUncommittedDiffForFile } from "../../git/fileDiff.js";
import { detectGit } from "../../discovery/git.js";
import { estimateTokens as defaultEstimateTokens } from "../tokenEstimate.js";
import type { ContextBundle, ContextItem, ExcludedItem, FileForSelection, FindingTarget } from "./types.js";

const MANIFEST_FILES = ["package.json", "pom.xml"];

const WINDOW_SIZES = [200, 80, 30, 10];

interface Candidate {

  path: string;
  reason: string;

  getContent: () => string | null;

  isPrimary?: boolean;
}

export interface SelectContextOptions {
  root: string;
  finding: FindingTarget;
  files: FileForSelection[];
  budgetTokens: number;
  estimateTokensFn?: (text: string) => number;

  includeContent?: boolean;
}

export function selectContextForFinding(options: SelectContextOptions): ContextBundle {
  const { root, finding, files, budgetTokens } = options;
  const estimateTokensFn = options.estimateTokensFn ?? defaultEstimateTokens;
  const includeContent = options.includeContent ?? false;

  const primaryFile = files.find((f) => f.relativePath === finding.filePath);
  const candidates: Candidate[] = [];

  const importable: ImportableFile[] = files.map((f) => ({
    relativePath: f.relativePath,
    language: f.language,
    imports: f.imports,
  }));
  const { edges } = resolveImports(importable);

  const importedPaths = edges.filter((e) => e.fromPath === finding.filePath).map((e) => e.toPath);
  const callerPaths = edges.filter((e) => e.toPath === finding.filePath).map((e) => e.fromPath);

  // Dedupes across ALL of the pushes below, not just within one list —
  // without this, a circular import (the finding's file and another file
  // importing each other) lands in both `importedPaths` and
  // `callerPaths`/`nonTestCallerPaths`, and would otherwise be added as
  // two separate candidates: double-counted against the token budget and,
  // with `includeContent: true`, sent to the AI provider twice. First
  // push for a given path wins; later duplicates are silently skipped.
  const seenCandidatePaths = new Set<string>();
  function pushCandidateOnce(candidate: Candidate): void {
    if (seenCandidatePaths.has(candidate.path)) return;
    seenCandidatePaths.add(candidate.path);
    candidates.push(candidate);
  }

  for (const importedPath of dedupe(importedPaths)) {
    pushCandidateOnce({
      path: importedPath,
      reason: `Imported by ${finding.filePath}, the file where the finding was reported.`,
      getContent: () => readAndRedact(root, importedPath),
    });
  }

  const nonTestCallerPaths = callerPaths.filter((p) => !files.find((f) => f.relativePath === p)?.isTest);
  for (const callerPath of dedupe(nonTestCallerPaths)) {
    pushCandidateOnce({
      path: callerPath,
      reason: `Imports ${finding.filePath} — a known caller of the affected file.`,
      getContent: () => readAndRedact(root, callerPath),
    });
  }

  const callerTestPaths = callerPaths.filter((p) => files.find((f) => f.relativePath === p)?.isTest);
  if (callerTestPaths.length > 0) {
    for (const testPath of dedupe(callerTestPaths)) {
      pushCandidateOnce({
        path: testPath,
        reason: `Test file that imports ${finding.filePath}.`,
        getContent: () => readAndRedact(root, testPath),
      });
    }
  } else {
    const conventionTestPath = findTestByNamingConvention(finding.filePath, files);
    if (conventionTestPath) {
      pushCandidateOnce({
        path: conventionTestPath,
        reason: `Test file matching ${finding.filePath}'s naming convention (no importing test file found).`,
        getContent: () => readAndRedact(root, conventionTestPath),
      });
    }
  }

  for (const manifestName of MANIFEST_FILES) {
    if (files.some((f) => f.relativePath === manifestName)) {
      pushCandidateOnce({
        path: manifestName,
        reason: "Project's main dependency manifest, for build/framework context.",
        getContent: () => readAndRedact(root, manifestName),
      });
      break; 
    }
  }

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
