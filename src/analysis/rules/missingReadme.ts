import type { AnalysisContext, Finding, Rule } from "../types.js";

const README_PATTERN = /^readme(\.md|\.rst|\.txt|\.adoc)?$/i;

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
