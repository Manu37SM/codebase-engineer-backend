import type { AnalysisContext, Finding, Rule } from "../types.js";

interface TlsPattern {
  pattern: RegExp;
  label: string;
}

const PATTERNS: TlsPattern[] = [
  {

    pattern: /rejectUnauthorized\s*:\s*false/,
    label: "rejectUnauthorized set to false",
  },
  {

    pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/,
    label: "NODE_TLS_REJECT_UNAUTHORIZED set to 0",
  },
  {

    pattern: /verify\s*=\s*False/,
    label: "verify parameter set to False",
  },
  {

    pattern: /X509TrustManager[\s\S]{0,80}?checkServerTrusted[\s\S]{0,40}?\{\s*\}/,
    label: "empty checkServerTrusted() (accepts any certificate)",
  },
];

export const disabledTlsVerificationRule: Rule = {
  id: "disabled-tls-verification",
  run(ctx: AnalysisContext): Finding[] {
    const findings: Finding[] = [];

    for (const file of ctx.files) {
      if (file.text === null || file.isGenerated || file.isTest) continue;

      for (const rule of PATTERNS) {
        const match = rule.pattern.exec(file.text);
        if (!match) continue;

        const lineStart = file.text.slice(0, match.index).split("\n").length;
        findings.push({
          ruleId: "disabled-tls-verification",
          severity: "high",
          category: "security",
          filePath: file.relativePath,
          lineStart,
          lineEnd: lineStart,
          evidence: `${rule.label} at line ${lineStart}`,
          explanation:
            "Disabling TLS/certificate verification means the application can't detect a man-in-the-middle attack — connections that look encrypted may be intercepted without any error.",
          recommendation:
            "Remove the verification bypass. If it's needed for a local development or test environment, gate it behind an explicit environment check rather than leaving it unconditional.",
        });
      }
    }

    return findings;
  },
};
