

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileResult {
  success: boolean;
  reason?: string;
}

export async function verifyTurnstile(token: string | undefined, remoteIp?: string): Promise<TurnstileResult> {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;
  if (!secretKey || secretKey.trim().length === 0) {
    return { success: true }; 
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

    return { success: false, reason: `Could not reach Turnstile verification service: ${(err as Error).message}` };
  }
}
