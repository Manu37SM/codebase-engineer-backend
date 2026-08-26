import path from "node:path";
import type { AnalysisContext, Finding, Rule } from "../types.js";

const SAFE_ENV_SUFFIXES = ["example", "sample", "template", "defaults", "dist"];

export const envFileCommittedRule: Rule = {
  id: "env-file-committed",
  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of ctx.files) {
      const baseName = path.posix.basename(file.relativePath);
      if (!isEnvFile(baseName)) continue;

      findings.push({
        ruleId: "env-file-committed",
        severity: "high",
        category: "security",
        filePath: file.relativePath,
        lineStart: null,
        lineEnd: null,
        evidence: `'${file.relativePath}' matches a .env-style filename and was not excluded by .gitignore`,
        explanation:
          "Files named .env conventionally hold real secrets (API keys, database credentials). If this file is actually tracked in version control, those secrets are exposed to anyone with repo access.",
        recommendation:
          "Add this file to .gitignore, remove it from version control history if it was ever committed, and rotate any credentials it contained.",
      });
    }

    return findings;
  },
};

function isEnvFile(baseName: string): boolean {
  if (baseName === ".env") return true;
  const match = baseName.match(/^\.env\.(.+)$/);
  if (!match) return false;
  const suffix = match[1].toLowerCase();
  return !SAFE_ENV_SUFFIXES.some((safe) => suffix === safe || suffix.startsWith(`${safe}.`));
}
