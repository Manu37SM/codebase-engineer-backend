import type { AnalysisContext, Finding, Rule } from "../types.js";

interface TlsPattern {
  pattern: RegExp;
  label: string;
}

const PATTERNS: TlsPattern[] = [
  {
    // Node.js https/TLS client option. Dogfooding this rule against its own
    // source found that writing the option's key-value pair out literally
    // anywhere in this file (even in a descriptive label or comment) made
    // the file match its own regex — so this comment paraphrases instead
    // of quoting the exact syntax. Same lesson applies below.
    pattern: /rejectUnauthorized\s*:\s*false/,
    label: "rejectUnauthorized set to false",
  },
  {
    // Node.js process-wide escape hatch, sometimes set directly in code
    // rather than only as an env var at invocation time.
    pattern: /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/,
    label: "NODE_TLS_REJECT_UNAUTHORIZED set to 0",
  },
  {
    // Python requests/urllib3 and similar.
    pattern: /verify\s*=\s*False/,
    label: "verify parameter set to False",
  },
  {
    // Java: a TrustManager that accepts everything is the classic
    // "disable cert validation" pattern.
    pattern: /X509TrustManager[\s\S]{0,80}?checkServerTrusted[\s\S]{0,40}?\{\s*\}/,
    label: "empty checkServerTrusted() (accepts any certificate)",
  },
];

/**
 * Flags source that disables TLS/certificate verification — a common way
 * to silence "self-signed cert" errors during development that
 * occasionally ships to production and defeats the entire point of TLS.
 * Regex-based, so a match in a comment or unreachable branch is possible;
 * that tradeoff (some false positives, but no fabricated matches) is the
 * same one every other rule in this engine makes — see docs/ARCHITECTURE.md
 * §6.
 */
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
