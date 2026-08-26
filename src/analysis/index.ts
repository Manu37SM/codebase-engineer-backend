import { buildAnalysisContext } from "./context.js";
import { largeFileRule } from "./rules/largeFile.js";
import { largeFunctionRule } from "./rules/largeFunction.js";
import { todoFixmeRule } from "./rules/todoFixme.js";
import { missingTestsRule } from "./rules/missingTests.js";
import { secretSmellRule } from "./rules/secretSmell.js";
import { envFileCommittedRule } from "./rules/envFileCommitted.js";
import { permissiveCorsRule } from "./rules/permissiveCors.js";
import { disabledTlsVerificationRule } from "./rules/disabledTlsVerification.js";
import { missingReadmeRule } from "./rules/missingReadme.js";
import { unpinnedDependencyRule } from "./rules/unpinnedDependency.js";
import type { Finding } from "./types.js";

export type { Finding, Severity, FindingCategory } from "./types.js";

export const SECURITY_RULES = [
  secretSmellRule,
  envFileCommittedRule,
  permissiveCorsRule,
  disabledTlsVerificationRule,
];

const RULES = [
  largeFileRule,
  largeFunctionRule,
  todoFixmeRule,
  missingTestsRule,
  ...SECURITY_RULES,

  missingReadmeRule,
  unpinnedDependencyRule,
];

export interface AnalysisResult {
  findings: Finding[];
  startedAt: string;
  finishedAt: string;
}

export function runAnalysis(root: string): AnalysisResult {
  const startedAt = new Date().toISOString();
  const ctx = buildAnalysisContext(root);

  const findings = RULES.flatMap((rule) => rule.run(ctx));

  return { findings, startedAt, finishedAt: new Date().toISOString() };
}
