import { SECRET_PATTERNS, redactValue } from "../../security/secretPatterns.js";
import type { AnalysisContext, Finding, Rule } from "../types.js";

/**
 * Deterministic, pattern-based secret smell detection — per docs/SECURITY.md
 * §4, a detected secret is never stored, logged, or displayed in full.
 * Evidence always shows a redacted form. This is a first-pass heuristic
 * scanner; a more thorough dependency/config security pass is Phase 10.
 * Pattern definitions live in `security/secretPatterns.ts`, shared with the
 * Phase 13 AI context-sanitization layer so the two can't drift apart.
 */
export const secretSmellRule: Rule = {
  id: "hardcoded-secret",
  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of ctx.files) {
      if (file.text === null || file.isGenerated || file.isTest) continue;

      const lines = file.text.split("\n");
      lines.forEach((line, idx) => {
        for (const rule of SECRET_PATTERNS) {
          const match = rule.pattern.exec(line);
          if (!match) continue;

          const secretValue = rule.secretGroup !== undefined ? match[rule.secretGroup] : match[0];
          findings.push({
            ruleId: "hardcoded-secret",
            severity: rule.severity,
            category: "security",
            filePath: file.relativePath,
            lineStart: idx + 1,
            lineEnd: idx + 1,
            evidence: `Possible ${rule.label} at line ${idx + 1}: ${redactValue(secretValue)}`,
            explanation:
              "Hardcoded credentials in source code are a common way secrets end up leaked via version control or logs.",
            recommendation:
              "Move this value to an environment variable or secret manager, and rotate it if it has ever been committed.",
          });
        }
      });
    }

    return findings;
  },
};
