import { buildAnalysisContext } from "../analysis/context.js";
import { SECURITY_RULES } from "../analysis/index.js";
import type { Finding } from "../analysis/types.js";

export interface SecurityScanResult {
  findings: Finding[];
  scannedAt: string;
}

/**
 * A fresh, unpersisted security-only view — same rule set as the
 * "security" category findings produced by the full deterministic analysis
 * pipeline (Phase 6/7), but computed live on every call rather than read
 * back from a previous `POST /analysis` run. Mirrors the Architecture
 * explorer (Phase 5) and Git analysis (Phase 8) pattern: this data changes
 * whenever the repository's files change, so a cached/persisted view could
 * go stale between scans. `GET /projects/:id/findings?category=security`
 * remains the way to see security findings alongside a specific historical
 * analysis run; this endpoint is for "what does the repo look like right
 * now."
 */
export function scanSecurity(root: string): SecurityScanResult {
  const ctx = buildAnalysisContext(root);
  const findings = SECURITY_RULES.flatMap((rule) => rule.run(ctx));
  return { findings, scannedAt: new Date().toISOString() };
}
