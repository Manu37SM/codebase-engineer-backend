import fs from "node:fs";
import path from "node:path";
import { parsePackageJsonDependencies, findDuplicateVersions } from "./npm.js";
import { parsePomDependencies } from "./maven.js";
import type { DependencyAnalysisResult } from "./types.js";

export type {
  DependencyAnalysisResult,
  DependencyInfo,
  DependencyType,
  DuplicateVersionGroup,
} from "./types.js";

/**
 * Computed live off the project's manifest/lockfile each call — same
 * pattern as Architecture (Phase 5) and Git analysis (Phase 8), not
 * persisted. Matches the ecosystems this product actually supports
 * elsewhere (Maven, npm-family): Gradle is detected for reporting purposes
 * (`discovery/buildSystem.ts`) but its dependency graph isn't parsed here,
 * same "not yet supported" stance as the Phase 9 test runner.
 */
export function analyzeDependencies(root: string): DependencyAnalysisResult {
  const analyzedAt = new Date().toISOString();

  if (fs.existsSync(path.join(root, "pom.xml"))) {
    const direct = parsePomDependencies(root);
    return {
      ecosystem: "maven",
      direct,
      totalDirect: direct.length,
      duplicates: [],
      duplicatesSource: null,
      duplicatesNote:
        "Duplicate-version detection isn't available for Maven — it requires resolving the full dependency tree (e.g. via `mvn dependency:tree`), which this product doesn't invoke.",
      analyzedAt,
    };
  }

  if (fs.existsSync(path.join(root, "package.json"))) {
    const direct = parsePackageJsonDependencies(root);
    const { duplicates, source, note } = findDuplicateVersions(root);
    return {
      ecosystem: "npm",
      direct,
      totalDirect: direct.length,
      duplicates,
      duplicatesSource: source,
      duplicatesNote: note,
      analyzedAt,
    };
  }

  return {
    ecosystem: null,
    direct: [],
    totalDirect: 0,
    duplicates: [],
    duplicatesSource: null,
    duplicatesNote: "No supported manifest found (pom.xml or package.json).",
    analyzedAt,
  };
}
