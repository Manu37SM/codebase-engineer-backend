import { buildAnalysisContext } from "./context.js";
import { largeFileRule } from "./rules/largeFile.js";
import { largeFunctionRule } from "./rules/largeFunction.js";
import { todoFixmeRule } from "./rules/todoFixme.js";
import { missingTestsRule } from "./rules/missingTests.js";
import { secretSmellRule } from "./rules/secretSmell.js";
import { envFileCommittedRule } from "./rules/envFileCommitted.js";
import { permissiveCorsRule } from "./rules/permissiveCors.js";
import { disabledTlsVerificationRule } from "./rules/disabledTlsVerification.js";
import type { Finding } from "./types.js";

export type { Finding, Severity, FindingCategory } from "./types.js";

/** Every rule whose findings belong to the "security" category — used by the live GET /security view (backend/src/security/scan.ts) as well as the full pipeline below. */
export const SECURITY_RULES = [
  secretSmellRule,
  envFileCommittedRule,
  permissiveCorsRule,
  disabledTlsVerificationRule,
];

const RULES = [largeFileRule, largeFunctionRule, todoFixmeRule, missingTestsRule, ...SECURITY_RULES];

export interface AnalysisResult {
  findings: Finding[];
  startedAt: string;
  finishedAt: string;
}

/**
 * Runs the full deterministic rule pipeline against a project root. See
 * docs/ARCHITECTURE.md §6 — rules never fabricate evidence; a rule that
 * can't cite a concrete file/line/pattern match doesn't fire.
 */
export function runAnalysis(root: string): AnalysisResult {
  const startedAt = new Date().toISOString();
  const ctx = buildAnalysisContext(root);

  const findings = RULES.flatMap((rule) => rule.run(ctx));

  return { findings, startedAt, finishedAt: new Date().toISOString() };
}
