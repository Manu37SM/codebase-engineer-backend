import { describe, it, expect } from "vitest";
import { redactSecretsInText, redactValue } from "../src/security/secretPatterns.js";

describe("redactValue", () => {
  it("masks a short value entirely", () => {
    expect(redactValue("abc")).toBe("***");
  });

  it("shows first 4 / last 2 characters with a char count for longer values", () => {
    expect(redactValue("sk-1234567890abcd")).toBe("sk-1…cd (redacted, 17 chars)");
  });
});

describe("redactSecretsInText", () => {
  it("redacts a hardcoded credential-like value in place, preserving surrounding text", () => {
    const source = 'const config = { apiKey: "sk-supersecretvalue1234" };\nconsole.log("done");';
    const { text, redactionCount } = redactSecretsInText(source);
    expect(redactionCount).toBe(1);
    expect(text).not.toContain("supersecretvalue1234");
    expect(text).toContain("[REDACTED:hardcoded credential-like value]");
    expect(text).toContain('const config = { apiKey: "[REDACTED:hardcoded credential-like value]" };');
    expect(text).toContain('console.log("done");');
  });

  it("redacts a private key block and an AWS access key ID", () => {
    const source = "-----BEGIN RSA PRIVATE KEY-----\nMIIB...\nkey id AKIAABCDEFGHIJKLMNOP here";
    const { text, redactionCount } = redactSecretsInText(source);
    expect(redactionCount).toBe(2);
    expect(text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(text).toContain("[REDACTED:private key block]");
    expect(text).toContain("[REDACTED:AWS access key ID]");
  });

  it("redacts multiple occurrences of the same pattern across a file", () => {
    const source = 'password="abcdefghijkl"\ntoken="zyxwvutsrqponm"';
    const { text, redactionCount } = redactSecretsInText(source);
    expect(redactionCount).toBe(2);
    expect(text).not.toContain("abcdefghijkl");
    expect(text).not.toContain("zyxwvutsrqponm");
  });

  it("leaves ordinary content untouched and reports zero redactions", () => {
    const source = "export function add(a: number, b: number) {\n  return a + b;\n}\n";
    const { text, redactionCount } = redactSecretsInText(source);
    expect(redactionCount).toBe(0);
    expect(text).toBe(source);
  });

  it("redacts a labeled AWS secret access key", () => {
    const source = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"';
    const { text, redactionCount } = redactSecretsInText(source);
    expect(redactionCount).toBe(1);
    expect(text).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(text).toContain("[REDACTED:AWS secret access key]");
  });

  it("redacts a JWT wherever it appears, unlabeled", () => {
    const source =
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ";
    const { text, redactionCount } = redactSecretsInText(source);
    expect(redactionCount).toBe(1);
    expect(text).not.toContain("dQw4w9WgXcQ");
    expect(text).toContain("[REDACTED:JWT]");
  });

  it("redacts an unquoted .env-style credential line", () => {
    const source = "PASSWORD=hunter2ProdDbPass\nAPI_KEY=sk-abc123def456ghi789";
    const { text, redactionCount } = redactSecretsInText(source);
    expect(redactionCount).toBe(2);
    expect(text).not.toContain("hunter2ProdDbPass");
    expect(text).not.toContain("sk-abc123def456ghi789");
    expect(text).toContain("[REDACTED:hardcoded credential-like value (unquoted)]");
  });

  it("does not flag a short, non-secret-looking unquoted config value", () => {
    const source = "TOKEN_TTL_SECONDS=3600\nPASSWORD_MIN_LENGTH=8";
    const { text, redactionCount } = redactSecretsInText(source);
    expect(redactionCount).toBe(0);
    expect(text).toBe(source);
  });
});
