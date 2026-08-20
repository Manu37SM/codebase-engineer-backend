/**
 * Cloudflare Turnstile server-side verification (Task #81). Opt-in like
 * every other credential-gated feature in this codebase: with
 * `TURNSTILE_SECRET_KEY` unset (the default), `verifyTurnstile()` always
 * reports success without making a network call — registration/login work
 * exactly as they would with no bot-protection configured at all, rather
 * than being silently blocked by a check nobody asked for. Once the
 * server operator sets a real secret key (see `.env.example` /
 * `docs/AUTH.md`), a missing/invalid/expired token on `/auth/register` or
 * `/auth/login` is rejected with a 400 before any password hashing or DB
 * write happens.
 */

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  success: boolean;
  reason?: string;
}

export async function verifyTurnstile(token: string | undefined, remoteIp?: string): Promise<TurnstileResult> {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey || secretKey.trim().length === 0) {
    return { success: true }; // Not configured — no-op, per the opt-in design above.
  }

  if (!token) {
    return { success: false, reason: "Missing Turnstile token." };
  }

  try {
    const body = new URLSearchParams({ secret: secretKey, response: token });
    if (remoteIp) body.set("remoteip", remoteIp);

    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const data = (await res.json()) as { success: boolean; ["error-codes"]?: string[] };
    if (!data.success) {
      return { success: false, reason: (data["error-codes"] ?? []).join(", ") || "Turnstile verification failed." };
    }
    return { success: true };
  } catch (err) {
    // Network/DNS failure talking to Cloudflare — fail closed (reject the
    // request) rather than silently letting a bot-check bypass through,
    // since this only ever runs once an operator has explicitly opted in
    // by setting a secret key.
    return { success: false, reason: `Could not reach Turnstile verification service: ${(err as Error).message}` };
  }
}
