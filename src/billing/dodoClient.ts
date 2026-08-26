
export class DodoError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth_error" | "rate_limited" | "unreachable"
  ) {
    super(message);
    this.name = "DodoError";
  }
}

export interface DodoCheckoutSession {
  sessionId: string;
  checkoutUrl: string;
}

export interface DodoClientConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs?: number;
}

export interface CreateCheckoutInput {
  productId: string;
  returnUrl: string;
  customerEmail?: string;
}

export function createDodoClient(config: DodoClientConfig) {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 15_000;
  const authHeader = `Bearer ${config.apiKey}`;

  async function doFetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { "Content-Type": "application/json", Authorization: authHeader },
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new DodoError(`Request to ${path} timed out after ${timeoutMs}ms`, "unreachable");
      }
      throw new DodoError(
        `Could not reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        "unreachable"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {

    async createCheckoutSession(input: CreateCheckoutInput): Promise<DodoCheckoutSession> {
      const res = await doFetch("/checkouts", {
        method: "POST",
        body: JSON.stringify({
          product_cart: [{ product_id: input.productId, quantity: 1 }],
          return_url: input.returnUrl,
          ...(input.customerEmail ? { customer: { email: input.customerEmail } } : {}),
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          throw new DodoError(`Dodo Payments authentication failed (HTTP ${res.status})`, "auth_error");
        }
        if (res.status === 429) {
          throw new DodoError(`Dodo Payments rate limited the request (HTTP ${res.status})`, "rate_limited");
        }
        throw new DodoError(
          `Dodo Payments checkout session creation returned HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`,
          "unreachable"
        );
      }
      const body = (await res.json()) as { session_id?: string; checkout_url?: string };
      if (!body.session_id || !body.checkout_url) {
        throw new DodoError(
          "Dodo Payments checkout session response did not include a session_id/checkout_url",
          "unreachable"
        );
      }
      return { sessionId: body.session_id, checkoutUrl: body.checkout_url };
    },
  };
}
