import path from "node:path";
import type { AnalysisContext, Finding, Rule } from "../types.js";

/**
 * Filenames that are conventionally *templates*, not real secrets — safe to
 * commit and common in real repos (`.env.example`, `.env.sample`, etc).
 */
const SAFE_ENV_SUFFIXES = ["example", "sample", "template", "defaults", "dist"];

/**
 * Flags a real `.env`-style file present in the indexed (i.e. not
 * `.gitignore`d — see fileWalker) file set. A `.env` file reaching the
 * walker at all means it wasn't excluded by the repo's own `.gitignore`,
 * which is the actual real-world signal for "this would be committed" —
 * we don't need to shell out to `git check-ignore` to know that.
 *
 * Deliberately does not read or quote file contents — the mere presence of
 * a non-template `.env` file is the finding; env files routinely contain
 * real secrets and must never be echoed into evidence text.
 */
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
