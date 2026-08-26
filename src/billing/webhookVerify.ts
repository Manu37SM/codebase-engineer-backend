import crypto from "node:crypto";

export interface DodoWebhookHeaders {
  id: string | undefined | null;
  timestamp: string | undefined | null;
  signature: string | undefined | null;
}

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

  const candidates = headers.signature
    .split(" ")
    .map((entry) => entry.split(",")[1])
    .filter((sig): sig is string => Boolean(sig));

  return candidates.some((candidate) => {
    const candidateBuf = Buffer.from(candidate, "utf-8");

    if (candidateBuf.length !== expectedBuf.length) return false;
    return crypto.timingSafeEqual(expectedBuf, candidateBuf);
  });
}
