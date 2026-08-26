import { buildAnalysisContext } from "../analysis/context.js";
import { SECURITY_RULES } from "../analysis/index.js";
import type { Finding } from "../analysis/types.js";

export interface SecurityScanResult {
  findings: Finding[];
  scannedAt: string;
}

export function scanSecurity(root: string): SecurityScanResult {
  const ctx = buildAnalysisContext(root);
  const findings = SECURITY_RULES.flatMap((rule) => rule.run(ctx));
  return { findings, scannedAt: new Date().toISOString() };
}
