/**
 * Real HTTP client for Razorpay's Orders API
 * (https://razorpay.com/docs/api/orders/), following the same shape as
 * `ai/provider/adapters/openaiCompatible.ts`: a real `fetch`-based call,
 * an injectable base URL so tests exercise the real request/response
 * handling against a real local HTTP double instead of live Razorpay
 * (this project has no live Razorpay account/credentials — see
 * `backend/test/razorpayClient.test.ts` for what was actually verified:
 * the real request shape — HTTP Basic Auth of `key_id:key_secret`, the
 * real JSON body Razorpay's Orders API documents — and real error
 * classification, not the live vendor round-trip), and errors classified
 * the same way (auth/rate-limit/unreachable) so callers don't need a
 * separate error-handling shape per external API this product talks to.
 */
export class RazorpayError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth_error" | "rate_limited" | "unreachable"
  ) {
    super(message);
    this.name = "RazorpayError";
  }
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt: string | null;
}

export interface RazorpayClientConfig {
  keyId: string;
  keySecret: string;
  baseUrl: string;
  timeoutMs?: number;
}

export interface CreateOrderInput {
  amountPaise: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

export function createRazorpayClient(config: RazorpayClientConfig) {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const timeoutMs = config.timeoutMs ?? 15_000;
  const authHeader = "Basic " + Buffer.from(`${config.keyId}:${config.keySecret}`).toString("base64");

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
        throw new RazorpayError(`Request to ${path} timed out after ${timeoutMs}ms`, "unreachable");
      }
      throw new RazorpayError(
        `Could not reach ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        "unreachable"
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Creates a real Razorpay order — the first step of Razorpay's
     * documented checkout flow (create an order server-side, hand its id
     * to the frontend's Checkout widget, Razorpay calls back via webhook
     * once payment completes). Never charges anything itself; an order
     * with no completed payment against it just expires unused.
     */
    async createOrder(input: CreateOrderInput): Promise<RazorpayOrder> {
      const res = await doFetch("/orders", {
        method: "POST",
        body: JSON.stringify({
          amount: input.amountPaise,
          currency: input.currency,
          receipt: input.receipt,
          notes: input.notes ?? {},
        }),
      });
      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        if (res.status === 401 || res.status === 403) {
          throw new RazorpayError(`Razorpay authentication failed (HTTP ${res.status})`, "auth_error");
        }
        if (res.status === 429) {
          throw new RazorpayError(`Razorpay rate limited the request (HTTP ${res.status})`, "rate_limited");
        }
        throw new RazorpayError(
          `Razorpay order creation returned HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`,
          "unreachable"
        );
      }
      const body = (await res.json()) as {
        id?: string;
        amount?: number;
        currency?: string;
        status?: string;
        receipt?: string | null;
      };
      if (!body.id) {
        throw new RazorpayError("Razorpay order creation response did not include an id", "unreachable");
      }
      return {
        id: body.id,
        amount: body.amount ?? input.amountPaise,
        currency: body.currency ?? input.currency,
        status: body.status ?? "created",
        receipt: body.receipt ?? input.receipt,
      };
    },
  };
}
