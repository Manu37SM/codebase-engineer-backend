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
});
