import type { AnalysisContext, Finding, Rule } from "../types.js";

/** Case-insensitive, any of the common extensions/no-extension README conventions. */
const README_PATTERN = /^readme(\.md|\.rst|\.txt|\.adoc)?$/i;

/**
 * Flags a project with no top-level README at all. Deliberately root-only
 * (no path separator) — a README nested inside a subpackage doesn't help
 * someone landing on the repo for the first time, which is what this rule
 * cares about. Fires at most once per project (there's nothing to point at
 * per-file, unlike most other rules), citing the conventional expected path
 * as `filePath` so the Findings UI still has something concrete to show.
 */
export const missingReadmeRule: Rule = {
  id: "missing-readme",
  run(ctx: AnalysisContext): Finding[] {
    const hasReadme = [...ctx.allPaths].some((p) => !p.includes("/") && README_PATTERN.test(p));
    if (hasReadme) return [];

    return [
      {
        ruleId: "missing-readme",
        severity: "low",
        category: "documentation",
        filePath: "README.md",
        lineStart: null,
        lineEnd: null,
        evidence: "No README.md (or README/.rst/.txt/.adoc variant) exists at the project root.",
        explanation:
          "Without a top-level README, anyone new to this repository — a teammate, a contributor, or your future self — has no starting point for what the project does, how to run it, or where to look next.",
        recommendation:
          "Add a README.md at the project root covering at minimum: what the project does, how to install/run it, and how to run its tests.",
      },
    ];
  },
};
