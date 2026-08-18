import type { AnalysisContext, Finding, Rule } from "../types.js";

interface CorsPattern {
  pattern: RegExp;
  label: string;
}

const PATTERNS: CorsPattern[] = [
  {
    pattern: /Access-Control-Allow-Origin['"]?\s*[:,]\s*['"]\*['"]/,
    label: "Access-Control-Allow-Origin set to '*'",
  },
  {
    // Express `cors` middleware and equivalents in other frameworks pass an
    // options object with an `origin` field set to a wildcard or `true`.
    // The comment here is deliberately paraphrased rather than showing the
    // literal option syntax — dogfooding this rule against its own source
    // found that spelling the pattern out literally in a comment made this
    // file match its own regex.
    pattern: /origin\s*:\s*(['"]\*['"]|true)\s*[,}]/,
    label: "CORS origin set to allow any origin ('*' or true)",
  },
];

/**
 * Flags a wildcard/allow-any-origin CORS configuration found directly in
 * source. A pattern match in test fixtures or comments is possible (this is
 * regex-based, not a real config-schema evaluator — a documented
 * limitation, same class as the other analysis rules), so this is a
 * heuristic proxy for "worth a human looking at it", not a certainty.
 */
export const permissiveCorsRule: Rule = {
  id: "permissive-cors",
  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of ctx.files) {
      if (file.text === null || file.isGenerated || file.isTest) continue;

      const lines = file.text.split("\n");
      lines.forEach((line, idx) => {
        for (const rule of PATTERNS) {
          if (!rule.pattern.test(line)) continue;

          findings.push({
            ruleId: "permissive-cors",
            severity: "medium",
            category: "security",
            filePath: file.relativePath,
            lineStart: idx + 1,
            lineEnd: idx + 1,
            evidence: `${rule.label} at line ${idx + 1}`,
            explanation:
              "Allowing any origin via CORS means any website can make authenticated cross-origin requests to this service, which can expose data or actions intended only for your own frontend.",
            recommendation:
              "Restrict Access-Control-Allow-Origin to a specific allowlist of trusted origins instead of '*' or unconditionally true.",
          });
          break; // one finding per line is enough even if both patterns match
        }
      });
    }

    return findings;
  },
};
