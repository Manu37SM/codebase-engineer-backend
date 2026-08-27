export interface SecretPattern {
  pattern: RegExp;
  label: string;
  severity: "critical" | "high";

  secretGroup?: number;
}

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

    pattern: /aws_?secret_?access_?key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/i,
    label: "AWS secret access key",
    severity: "critical",
    secretGroup: 1,
  },
  {

    pattern: /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/,
    label: "JWT",
    severity: "high",
  },
  {

    pattern: /(api[_-]?key|secret|password|token)\s*[:=]\s*["']([A-Za-z0-9\-_/+=]{12,})["']/i,
    label: "hardcoded credential-like value",
    severity: "high",
    secretGroup: 2,
  },
  {

    pattern: /(api[_-]?key|secret|password|token|access[_-]?key)\s*=\s*([A-Za-z0-9\-_/+.]{16,})(?=\s|$)/im,
    label: "hardcoded credential-like value (unquoted)",
    severity: "high",
    secretGroup: 2,
  },
];

export function redactValue(value: string): string {
  if (value.length <= 6) return "*".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-2)} (redacted, ${value.length} chars)`;
}

export interface RedactionResult {
  text: string;
  redactionCount: number;
}

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
