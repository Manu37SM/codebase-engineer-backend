import crypto from "node:crypto";

/**
 * Verifies a Razorpay webhook's `X-Razorpay-Signature` header per
 * Razorpay's documented webhook security model
 * (https://razorpay.com/docs/webhooks/validate-test/): the signature is
 * an HMAC-SHA256 of the *raw, exact* request body bytes, keyed with the
 * webhook secret configured in the Razorpay dashboard (never the API key
 * secret — a separate credential). This is pure, deterministic
 * cryptographic logic with no network dependency, so it's fully real-
 * tested against real HMAC test vectors in
 * `backend/test/webhookVerify.test.ts` without needing a live Razorpay
 * account or a webhook actually firing.
 *
 * Takes the raw body as a `Buffer`/`string`, not a parsed object —
 * signature verification must happen against the exact bytes Razorpay
 * signed, before any JSON parsing that could normalize whitespace/key
 * order and silently invalidate a legitimate signature (or worse, let a
 * forged body with different-but-equivalent-after-parsing content slip
 * through). See `routes/billing.ts`'s webhook route for how the raw body
 * is captured ahead of Fastify's normal JSON body parser.
 *
 * Uses `crypto.timingSafeEqual` rather than `===` — a webhook signature
 * check is exactly the kind of secret-comparison operation where a
 * timing side-channel (an attacker measuring how long string comparison
 * takes to find a mismatching byte) is a real, documented attack class,
 * not theoretical.
 */
export function verifyRazorpayWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined | null,
  webhookSecret: string
): boolean {
  if (!signatureHeader) return false;

  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected, "utf-8");
  const actualBuf = Buffer.from(signatureHeader, "utf-8");

  // timingSafeEqual throws on length mismatch rather than returning
  // false — a forged/truncated signature header is the common case that
  // would hit this, so it's handled explicitly rather than left to
  // propagate as an unrelated-looking exception.
  if (expectedBuf.length !== actualBuf.length) return false;

  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}
