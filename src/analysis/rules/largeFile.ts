import type { AnalysisContext, Finding, Rule } from "../types.js";

const HIGH_THRESHOLD = 800;
const MEDIUM_THRESHOLD = 400;

export const largeFileRule: Rule = {
  id: "large-file",
  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    for (const file of ctx.files) {
      if (!file.language || file.isGenerated || file.loc === null) continue;
      if (file.loc < MEDIUM_THRESHOLD) continue;

      const severity = file.loc >= HIGH_THRESHOLD ? "high" : "medium";
      findings.push({
        ruleId: "large-file",
        severity,
        category: "maintainability",
        filePath: file.relativePath,
        lineStart: 1,
        lineEnd: file.loc,
        evidence: `${file.loc} lines (threshold: ${MEDIUM_THRESHOLD})`,
        explanation:
          "Large files are harder to navigate, review, and reason about, and tend to accumulate unrelated responsibilities over time.",
        recommendation:
          "Consider splitting this file into smaller, more focused modules along its natural seams.",
      });
    }
    return findings;
  },
};
