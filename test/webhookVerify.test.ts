import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyDodoWebhookSignature } from "../src/billing/webhookVerify.js";

/**
 * Pure cryptographic logic — real HMAC-SHA256 test vectors, no mocking,
 * no network. Computes the expected signature the exact same way the
 * Standard Webhooks spec (which Dodo Payments implements) documents:
 * base64-decode the `whsec_`-prefixed secret, HMAC-SHA256 the
 * `${id}.${timestamp}.${payload}` signed content, base64-encode the
 * result, and format the header as `v1,<sig>`.
 */
describe("verifyDodoWebhookSignature", () => {
  const secretB64 = Buffer.from("test_secret_value_32_bytes_long").toString("base64");
  const secret = `whsec_${secretB64}`;
  const rawBody = Buffer.from(JSON.stringify({ type: "subscription.active", data: { subscription_id: "sub_123" } }));
  const id = "msg_test123";
  const nowSeconds = 1_700_000_000;
  const timestamp = String(nowSeconds);

  function realSignature(webhookId: string, ts: string, body: Buffer, key: string): string {
    const secretBuf = Buffer.from(key.replace(/^whsec_/, ""), "base64");
    const signedContent = `${webhookId}.${ts}.${body.toString("utf-8")}`;
    return crypto.createHmac("sha256", secretBuf).update(signedContent).digest("base64");
  }

  function headerFor(sig: string): string {
    return `v1,${sig}`;
  }

  it("accepts a genuine signature computed the same way Dodo (Standard Webhooks) computes it", () => {
    const sig = realSignature(id, timestamp, rawBody, secret);
    expect(
      verifyDodoWebhookSignature(rawBody, { id, timestamp, signature: headerFor(sig) }, secret, nowSeconds)
    ).toBe(true);
  });

  it("rejects a signature computed with the wrong secret", () => {
    const wrongSecret = `whsec_${Buffer.from("a_completely_different_secret!!").toString("base64")}`;
    const sig = realSignature(id, timestamp, rawBody, wrongSecret);
    expect(
      verifyDodoWebhookSignature(rawBody, { id, timestamp, signature: headerFor(sig) }, secret, nowSeconds)
    ).toBe(false);
  });

  it("rejects when the body was tampered with after signing", () => {
    const sig = realSignature(id, timestamp, rawBody, secret);
    const tamperedBody = Buffer.from(JSON.stringify({ type: "subscription.active", data: { subscription_id: "sub_999" } }));
    expect(
      verifyDodoWebhookSignature(tamperedBody, { id, timestamp, signature: headerFor(sig) }, secret, nowSeconds)
    ).toBe(false);
  });

  it("rejects when the webhook id was tampered with after signing", () => {
    const sig = realSignature(id, timestamp, rawBody, secret);
    expect(
      verifyDodoWebhookSignature(rawBody, { id: "msg_different", timestamp, signature: headerFor(sig) }, secret, nowSeconds)
    ).toBe(false);
  });

  it("rejects missing headers", () => {
    const sig = realSignature(id, timestamp, rawBody, secret);
    expect(verifyDodoWebhookSignature(rawBody, { id: undefined, timestamp, signature: headerFor(sig) }, secret, nowSeconds)).toBe(false);
    expect(verifyDodoWebhookSignature(rawBody, { id, timestamp: undefined, signature: headerFor(sig) }, secret, nowSeconds)).toBe(false);
    expect(verifyDodoWebhookSignature(rawBody, { id, timestamp, signature: undefined }, secret, nowSeconds)).toBe(false);
    expect(verifyDodoWebhookSignature(rawBody, { id, timestamp, signature: null }, secret, nowSeconds)).toBe(false);
  });

  it("rejects a truncated (shorter) forged signature rather than throwing", () => {
    const sig = realSignature(id, timestamp, rawBody, secret);
    const truncated = headerFor(sig.slice(0, 10));
    expect(() => verifyDodoWebhookSignature(rawBody, { id, timestamp, signature: truncated }, secret, nowSeconds)).not.toThrow();
    expect(verifyDodoWebhookSignature(rawBody, { id, timestamp, signature: truncated }, secret, nowSeconds)).toBe(false);
  });

  it("rejects a same-length but wrong signature", () => {
    const sig = realSignature(id, timestamp, rawBody, secret);
    const flipped = sig.slice(0, -1) + (sig.endsWith("a") ? "b" : "a");
    expect(verifyDodoWebhookSignature(rawBody, { id, timestamp, signature: headerFor(flipped) }, secret, nowSeconds)).toBe(false);
  });

  it("rejects a timestamp far outside the tolerance window (replay protection)", () => {
    const sig = realSignature(id, timestamp, rawBody, secret);
    const staleNow = nowSeconds + 3600; // 1 hour later, well past the 5-minute tolerance
    expect(verifyDodoWebhookSignature(rawBody, { id, timestamp, signature: headerFor(sig) }, secret, staleNow)).toBe(false);
  });

  it("accepts a string raw body identically to a Buffer raw body", () => {
    const bodyString = rawBody.toString("utf-8");
    const sig = realSignature(id, timestamp, rawBody, secret);
    expect(
      verifyDodoWebhookSignature(bodyString, { id, timestamp, signature: headerFor(sig) }, secret, nowSeconds)
    ).toBe(true);
  });

  it("accepts a signature found among multiple space-separated entries (key rotation)", () => {
    const sig = realSignature(id, timestamp, rawBody, secret);
    const header = `v1,not_the_real_signature v1,${sig} v1,also_not_real`;
    expect(verifyDodoWebhookSignature(rawBody, { id, timestamp, signature: header }, secret, nowSeconds)).toBe(true);
  });
});
