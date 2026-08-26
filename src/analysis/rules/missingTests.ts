import path from "node:path";
import { resolveImports, type ImportableFile } from "../../architecture/resolveImports.js";
import type { AnalysisContext, Finding, Rule } from "../types.js";

const MIN_LOC = 40;

const SKIP_BASENAMES = new Set(["index", "types", "constants", "config"]);
const TEST_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".java"];

export const missingTestsRule: Rule = {
  id: "missing-test-file",
  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    const testedByImport = collectFilesReferencedByTests(ctx.files);
    const testedByNamingConvention = collectBaseNamesWithCorrespondingTest(ctx.allPaths);

    for (const file of ctx.files) {
      if (file.isTest || file.isGenerated) continue;
      if (!file.language || file.loc === null || file.loc < MIN_LOC) continue;

      const ext = path.posix.extname(file.relativePath);
      const baseName = path.posix.basename(file.relativePath, ext);
      if (SKIP_BASENAMES.has(baseName.toLowerCase())) continue;

      if (testedByImport.has(file.relativePath)) continue;
      if (testedByNamingConvention.has(baseName)) continue;

      findings.push({
        ruleId: "missing-test-file",
        severity: "medium",
        category: "testing",
        filePath: file.relativePath,
        lineStart: null,
        lineEnd: null,
        evidence: `No test file imports this file, and none matching '${baseName}.test.*' / '${baseName}.spec.*' was found`,
        explanation:
          "This file has no apparent dedicated test coverage: no indexed test file imports it, and none matches the usual naming conventions.",
        recommendation: `Add or extend a test that exercises ${file.relativePath}, or confirm it's covered and document why it isn't imported directly.`,
      });
    }

    return findings;
  },
};

function collectFilesReferencedByTests(files: { relativePath: string; language: string | null; isTest: boolean; imports: string[] }[]): Set<string> {
  const importable: ImportableFile[] = files.map((f) => ({
    relativePath: f.relativePath,
    language: f.language,
    imports: f.imports,
  }));
  const { edges } = resolveImports(importable);

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    adjacency.set(edge.fromPath, [...(adjacency.get(edge.fromPath) ?? []), edge.toPath]);
  }

  const testFilePaths = files.filter((f) => f.isTest).map((f) => f.relativePath);
  const reached = new Set<string>();
  const queue = [...testFilePaths];

  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of adjacency.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(next);
    }
  }

  return reached;
}

const NAMING_CONVENTION_SUFFIXES = [
  ...TEST_EXTENSIONS.flatMap((ext) => [`.test${ext}`, `.spec${ext}`]),
  "Test.java",
  "Tests.java",
  "IT.java",
];

function collectBaseNamesWithCorrespondingTest(allPaths: Set<string>): Set<string> {
  const baseNames = new Set<string>();
  for (const candidatePath of allPaths) {
    const candidateBase = path.posix.basename(candidatePath);
    for (const suffix of NAMING_CONVENTION_SUFFIXES) {
      if (candidateBase.endsWith(suffix)) {
        baseNames.add(candidateBase.slice(0, -suffix.length));
      }
    }
  }
  return baseNames;
}
