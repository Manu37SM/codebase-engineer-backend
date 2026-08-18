export interface SecretPattern {
  pattern: RegExp;
  label: string;
  severity: "critical" | "high";
  /** Index of the capture group holding the sensitive value, for redaction. Undefined = whole match. */
  secretGroup?: number;
}

/**
 * Shared secret-pattern definitions — the single source of truth for both
 * the `hardcoded-secret` analysis rule (which reports *where* a likely
 * secret is) and the AI context-sanitization layer (which *redacts*
 * secrets from content before it's counted toward a token budget or sent
 * anywhere — docs/SECURITY.md §4). Keeping one list means the two can't
 * drift apart — a pattern the scanner would flag as a finding is exactly
 * the pattern the AI context layer strips.
 */
export const SECRET_PATTERNS: SecretPattern[] = [
  {
    pattern: /-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----/,
    label: "private key block",
    severity: "critical",
  },
  {
    pattern: /AKIA[0-9A-Z]{16}/,
    label: "AWS access key ID",
    severity: "critical",
  },
  {
    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*["']([A-Za-z0-9\-_/+=]{12,})["']/i,
    label: "hardcoded credential-like value",
    severity: "high",
    secretGroup: 2,
  },
];

/** Redacts a single sensitive value, never returning it in full. */
export function redactValue(value: string): string {
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)} (redacted, ${value.length} chars)`;
}

export interface RedactionResult {
  text: string;
  redactionCount: number;
}

/**
 * Scans `text` for every `SECRET_PATTERNS` match and replaces the sensitive
 * portion in place with a redaction marker, returning the sanitized text.
 * Used by the AI context-selection layer (Phase 13) so that file content
 * is never counted toward a token budget or included in a `ContextBundle`
 * with a live secret still in it.
 */
export function redactSecretsInText(text: string): RedactionResult {
  let result = text;
  let redactionCount = 0;

  for (const rule of SECRET_PATTERNS) {
    const flags = rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const globalPattern = new RegExp(rule.pattern.source, flags);
    result = result.replace(globalPattern, (...args) => {
      redactionCount++;
      const match = args[0] as string;
      if (rule.secretGroup === undefined) {
        return `[REDACTED:${rule.label}]`;
      }
      const secretValue = args[rule.secretGroup] as string;
      return match.replace(secretValue, `[REDACTED:${rule.label}]`);
    });
  }

  return { text: result, redactionCount };
}
