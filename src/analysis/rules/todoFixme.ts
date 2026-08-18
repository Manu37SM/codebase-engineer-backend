import type { AnalysisContext, Finding, Rule } from "../types.js";

const MIN_COUNT = 3;
const MAX_LINES_IN_EVIDENCE = 5;

const MARKER_PATTERN = /\b(TODO|FIXME|XXX)\b/;

/**
 * Flags files with a notable concentration of TODO/FIXME/XXX markers.
 * Evidence lists the actual matching line numbers (capped) so the finding
 * can be verified by opening the file, not just trusted on the count alone.
 */
export const todoFixmeRule: Rule = {
  id: "todo-fixme-density",
  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    for (const file of ctx.files) {
      if (file.text === null || file.isGenerated) continue;
      const lines = file.text.split("\n");
      const matchedLines: number[] = [];
      lines.forEach((line, idx) => {
        if (MARKER_PATTERN.test(line)) matchedLines.push(idx + 1);
      });

      if (matchedLines.length < MIN_COUNT) continue;

      const shown = matchedLines.slice(0, MAX_LINES_IN_EVIDENCE);
      const suffix = matchedLines.length > shown.length ? `, +${matchedLines.length - shown.length} more` : "";

      findings.push({
        ruleId: "todo-fixme-density",
        severity: "low",
        category: "maintainability",
        filePath: file.relativePath,
        lineStart: matchedLines[0],
        lineEnd: matchedLines[matchedLines.length - 1],
        evidence: `${matchedLines.length} TODO/FIXME/XXX markers at lines ${shown.join(", ")}${suffix}`,
        explanation:
          "A high concentration of TODO/FIXME markers often indicates known-incomplete or known-fragile code.",
        recommendation:
          "Triage these markers: convert real work items into tracked issues, and resolve or remove stale ones.",
      });
    }
    return findings;
  },
};
