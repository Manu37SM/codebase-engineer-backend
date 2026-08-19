import path from "node:path";
import { resolveImports, type ImportableFile } from "../../architecture/resolveImports.js";
import type { AnalysisContext, Finding, Rule } from "../types.js";

const MIN_LOC = 40;
/** Basenames excluded as usually not independently unit-tested (barrels, types, pure config). */
const SKIP_BASENAMES = new Set(["index", "types", "constants", "config"]);
const TEST_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".java"];

/**
 * Flags source files with no apparent test coverage. "Apparent" is
 * evidence-based in two ways, combined with OR:
 *
 * 1. Usage-based (primary signal): some test file's imports resolve
 *    (via the same import graph the Architecture explorer uses) to this
 *    file. This handles the extremely common real-world pattern of one
 *    test file exercising several source files by topic
 *    (`discovery.test.ts` covering `git.ts`, `languages.ts`, etc.) — a
 *    naming-convention-only check produces massive false positives on any
 *    codebase organized this way, which was caught by dogfooding this rule
 *    against this project's own `backend/src` before shipping it.
 * 2. Naming-convention (fallback): a `<name>.test.*`/`<name>.spec.*` file,
 *    or Java `<Name>Test.java` etc.
 *
 * Still a heuristic proxy, not real coverage instrumentation — documented
 * as such.
 */
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

/**
 * Returns every file transitively reachable from some test file via the
 * import graph — not just files a test imports directly. A test file very
 * commonly imports one orchestrator (e.g. `discoverRepository`) that itself
 * pulls in several collaborator modules (`git.ts`, `languages.ts`, ...);
 * those collaborators are exercised too, even though no test file imports
 * them by name. A direct-imports-only check still produced widespread false
 * positives on this project's own `backend/src` — this transitive closure
 * is what fixed it.
 */
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

/** Fixed suffixes `hasCorrespondingTest` used to reconstruct per-candidate (`${baseName}${suffix}`) and compare against every path in the repo — O(files × allPaths). Precomputing the reverse direction once (which *source* base name would this suffix, if stripped, correspond to?) turns the whole naming-convention check into a single O(allPaths) pass plus O(files) O(1) lookups. */
const NAMING_CONVENTION_SUFFIXES = [
  ...TEST_EXTENSIONS.flatMap((ext) => [`.test${ext}`, `.spec${ext}`]),
  "Test.java",
  "Tests.java",
  "IT.java",
];

/**
 * Returns the set of source-file base names that have a corresponding test
 * file present anywhere in the repo by naming convention (e.g. `foo.ts` is
 * "covered" if `foo.test.ts`, `foo.spec.ts`, etc. exists anywhere). Computed
 * once per analysis run, in one pass over every path — the O(N²) alternative
 * (re-scanning all paths per candidate source file, which this replaced) was
 * measured to dominate `missing-test-file`'s runtime on a ~3,700-file corpus
 * (~1.4s of the rule's ~1.4-1.7s total). See `docs/PERFORMANCE.md`.
 */
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
