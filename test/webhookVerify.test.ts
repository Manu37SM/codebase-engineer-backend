import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyRazorpayWebhookSignature } from "../src/billing/webhookVerify.js";

/**
 * Pure cryptographic logic — real HMAC-SHA256 test vectors, no mocking,
 * no network. Computes the expected signature the exact same way
 * Razorpay's own webhook sender does (per their published docs) and
 * verifies the function correctly accepts a genuine signature and
 * rejects every way a forged/tampered one could look.
 */
describe("verifyRazorpayWebhookSignature", () => {
  const secret = "whsec_test_secret_value";
  const rawBody = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { id: "pay_123" } }));

  function realSignature(body: Buffer, key: string): string {
    return crypto.createHmac("sha256", key).update(body).digest("hex");
  }

  it("accepts a genuine signature computed the same way Razorpay computes it", () => {
    const signature = realSignature(rawBody, secret);
    expect(verifyRazorpayWebhookSignature(rawBody, signature, secret)).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const signature = realSignature(rawBody, "wrong_secret");
    expect(verifyRazorpayWebhookSignature(rawBody, signature, secret)).toBe(false);
  });

  it("rejects when the body was tampered with after signing", () => {
    const signature = realSignature(rawBody, secret);
    const tamperedBody = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { id: "pay_999" } }));
    expect(verifyRazorpayWebhookSignature(tamperedBody, signature, secret)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyRazorpayWebhookSignature(rawBody, undefined, secret)).toBe(false);
    expect(verifyRazorpayWebhookSignature(rawBody, null, secret)).toBe(false);
  });

  it("rejects an empty-string signature", () => {
    expect(verifyRazorpayWebhookSignature(rawBody, "", secret)).toBe(false);
  });

  it("rejects a truncated (shorter) forged signature rather than throwing", () => {
    const signature = realSignature(rawBody, secret);
    expect(() => verifyRazorpayWebhookSignature(rawBody, signature.slice(0, 10), secret)).not.toThrow();
    expect(verifyRazorpayWebhookSignature(rawBody, signature.slice(0, 10), secret)).toBe(false);
  });

  it("rejects a same-length but wrong signature", () => {
    const signature = realSignature(rawBody, secret);
    const flipped = signature.slice(0, -1) + (signature.endsWith("a") ? "b" : "a");
    expect(verifyRazorpayWebhookSignature(rawBody, flipped, secret)).toBe(false);
  });

  it("accepts a string raw body identically to a Buffer raw body", () => {
    const bodyString = rawBody.toString("utf-8");
    const signature = realSignature(rawBody, secret);
    expect(verifyRazorpayWebhookSignature(bodyString, signature, secret)).toBe(true);
  });
});
