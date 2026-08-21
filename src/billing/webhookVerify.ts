import crypto from "node:crypto";

/**
 * Verifies a Dodo Payments webhook's `webhook-signature` header per the
 * Standard Webhooks specification Dodo implements
 * (https://github.com/standard-webhooks/standard-webhooks —
 * https://docs.dodopayments.com/developer-resources/webhooks): the
 * signed content is `${webhook-id}.${webhook-timestamp}.${rawBody}`,
 * HMAC-SHA256'd with the webhook secret (base64-encoded, `whsec_`-
 * prefixed, from the Dodo dashboard — never the API key, a separate
 * credential), base64-encoded. The header can carry multiple
 * space-separated `v{n},<base64sig>` entries (key rotation support) —
 * any one matching is a valid signature.
 *
 * This is pure, deterministic cryptographic logic with no network
 * dependency, so it's fully real-tested against real HMAC test vectors
 * in `backend/test/webhookVerify.test.ts` without needing a live Dodo
 * account or a webhook actually firing.
 *
 * Takes the raw body as a `Buffer`/`string`, not a parsed object —
 * signature verification must happen against the exact bytes Dodo
 * signed, before any JSON parsing that could normalize whitespace/key
 * order and silently invalidate a legitimate signature (or worse, let a
 * forged body with different-but-equivalent-after-parsing content slip
 * through). See `routes/billing.ts`'s webhook route for how the raw body
 * is captured ahead of Fastify's normal JSON body parser.
 *
 * Uses `crypto.timingSafeEqual` rather than `===` — a webhook signature
 * check is exactly the kind of secret-comparison operation where a
 * timing side-channel is a real, documented attack class, not
 * theoretical.
 */
export interface DodoWebhookHeaders {
  id: string | undefined | null;
  timestamp: string | undefined | null;
  signature: string | undefined | null;
}

/** Reject a timestamp further than this from "now" in either direction — bounds replay-attack exposure from a captured, still-validly-signed old payload. Matches the Standard Webhooks spec's recommended tolerance. */
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export function verifyDodoWebhookSignature(
  rawBody: Buffer | string,
  headers: DodoWebhookHeaders,
  webhookKey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;

  const timestampSeconds = Number(headers.timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(nowSeconds - timestampSeconds) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const secretB64 = webhookKey.startsWith("whsec_") ? webhookKey.slice("whsec_".length) : webhookKey;
  let secretBuf: Buffer;
  try {
    secretBuf = Buffer.from(secretB64, "base64");
  } catch {
    return false;
  }
  if (secretBuf.length === 0) return false;

  const payload = typeof rawBody === "string" ? rawBody : rawBody.toString("utf-8");
  const signedContent = `${headers.id}.${headers.timestamp}.${payload}`;
  const expected = crypto.createHmac("sha256", secretBuf).update(signedContent).digest("base64");
  const expectedBuf = Buffer.from(expected, "utf-8");

  // Header format: space-delimited "v1,<base64sig>" entries (possibly
  // more than one during key rotation) — any single matching entry is
  // sufficient.
  const candidates = headers.signature
    .split(" ")
    .map((entry) => entry.split(",")[1])
    .filter((sig): sig is string => Boolean(sig));

  return candidates.some((candidate) => {
    const candidateBuf = Buffer.from(candidate, "utf-8");
    // timingSafeEqual throws on length mismatch rather than returning
    // false — a forged/truncated signature is the common case that
    // would hit this, so it's handled explicitly.
    if (candidateBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, candidateBuf);
  });
}
