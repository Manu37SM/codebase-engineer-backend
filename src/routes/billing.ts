import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import { loadBillingConfig } from "../billing/config.js";
import { createDodoClient, DodoError } from "../billing/dodoClient.js";
import { verifyDodoWebhookSignature } from "../billing/webhookVerify.js";
import {
  getOrCreateSubscription,
  activateSubscription,
  deactivateSubscription,
  recordWebhookEventIfNew,
} from "../billing/subscriptionRepo.js";
import { checkAiOperationAllowed } from "../billing/usageLimiter.js";
import { TIER_LIMITS } from "../billing/types.js";

interface RegisterBillingRoutesOptions {
  db: DB;
}

/**
 * Optional monetization architecture (docs/MONETIZATION.md,
 * docs/ROADMAP.md Phase 26), now backed by Dodo Payments rather than
 * Razorpay — see `billing/config.ts`'s doc comment for why. Every route
 * here degrades to an honest "billing not configured" response when
 * `DODO_*` env vars aren't set (the default, out-of-the-box state) —
 * never a 500, never a silently-fabricated "unlimited" or "no
 * subscription" shape that looks like a real answer but isn't.
 *
 * Unlike the original Razorpay integration (a hand-rolled one-time-order
 * + fixed 30-day period, explicitly scoped that way because real
 * Razorpay Subscriptions was a materially larger integration), this uses
 * Dodo's native Subscription product type: `subscription.active` /
 * `subscription.renewed` activate/extend the period using Dodo's own
 * `next_billing_date` when the webhook payload includes it (falling back
 * to a `PRO_PERIOD_DAYS` computed date only if it doesn't), and
 * `subscription.cancelled` deactivates immediately. `PRO_PERIOD_DAYS`
 * therefore only matters as a fallback, not the primary period source.
 */
const PRO_PERIOD_DAYS = 30;

interface DodoWebhookEnvelope {
  type?: string;
  data?: {
    payload_type?: string;
    subscription_id?: string;
    payment_id?: string;
    next_billing_date?: string;
    customer?: { email?: string };
  };
}

export function registerBillingRoutes(app: FastifyInstance, { db }: RegisterBillingRoutesOptions) {
  app.get("/api/v1/billing/status", async () => {
    const billingConfig = loadBillingConfig();
    if (!billingConfig) {
      return { configured: false, tier: "free", limit: null, used: 0, subscription: null };
    }

    const subscription = getOrCreateSubscription(db);
    const usage = checkAiOperationAllowed(db);
    return {
      configured: true,
      tier: subscription.tier,
      limit: TIER_LIMITS[subscription.tier].monthlyAiOperations,
      used: usage.used,
      subscription: {
        status: subscription.status,
        currentPeriodEnd: subscription.current_period_end,
      },
    };
  });

  app.post("/api/v1/billing/checkout", async (request, reply) => {
    const billingConfig = loadBillingConfig();
    if (!billingConfig) {
      return reply.status(400).send({
        error:
          "Billing is not configured on this instance. Set DODO_PAYMENTS_API_KEY, DODO_PAYMENTS_WEBHOOK_KEY, and DODO_PRODUCT_ID to enable it.",
      });
    }

    const client = createDodoClient({
      apiKey: billingConfig.apiKey,
      baseUrl: billingConfig.apiBaseUrl,
    });

    // returnUrl may be a relative path (the default, "/settings") — Dodo's
    // API needs an absolute URL, so resolve it against this same request's
    // own origin rather than requiring an operator to hardcode the full
    // public URL as a separate env var.
    const origin = `${request.protocol}://${request.headers.host}`;
    const returnUrl = billingConfig.returnUrl.startsWith("http")
      ? billingConfig.returnUrl
      : new URL(billingConfig.returnUrl, origin).toString();

    try {
      const session = await client.createCheckoutSession({
        productId: billingConfig.productId,
        returnUrl,
      });
      return reply.status(200).send({
        sessionId: session.sessionId,
        checkoutUrl: session.checkoutUrl,
      });
    } catch (err) {
      if (err instanceof DodoError) {
        const status = err.kind === "auth_error" ? 502 : err.kind === "rate_limited" ? 429 : 502;
        return reply.status(status).send({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * Dodo Payments webhook receiver. Registered inside its own
   * encapsulated plugin context so only this one route gets a
   * raw-buffer content-type parser override — every other route in the
   * app keeps Fastify's normal JSON body parsing untouched. The raw
   * bytes are required because `verifyDodoWebhookSignature` must check
   * the signature against the exact bytes Dodo signed, before any JSON
   * parsing/reserialization could alter them.
   */
  app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body)
    );

    webhookScope.post("/api/v1/billing/webhook", async (request, reply) => {
      const billingConfig = loadBillingConfig();
      if (!billingConfig) {
        return reply.status(400).send({ error: "Billing is not configured on this instance." });
      }

      const rawBody = request.body as Buffer;
      const webhookId = request.headers["webhook-id"] as string | undefined;
      const webhookTimestamp = request.headers["webhook-timestamp"] as string | undefined;
      const webhookSignature = request.headers["webhook-signature"] as string | undefined;

      if (
        !verifyDodoWebhookSignature(
          rawBody,
          { id: webhookId, timestamp: webhookTimestamp, signature: webhookSignature },
          billingConfig.webhookKey
        )
      ) {
        return reply.status(400).send({ error: "Invalid webhook signature." });
      }

      let event: DodoWebhookEnvelope;
      try {
        event = JSON.parse(rawBody.toString("utf-8"));
      } catch {
        return reply.status(400).send({ error: "Webhook body was not valid JSON." });
      }

      const dodoEventId = webhookId ?? randomUUID();
      const isNew = recordWebhookEventIfNew(db, randomUUID(), dodoEventId, event.type ?? "unknown", rawBody.toString("utf-8"));

      // A redelivery of an already-processed event is still a valid,
      // successfully-handled webhook from Dodo's perspective — ack with
      // 200 rather than reprocessing (and never re-activating/re-
      // deactivating from a stale event), so Dodo stops retrying it.
      if (!isNew) {
        return reply.status(200).send({ received: true, duplicate: true });
      }

      if (event.type === "subscription.active" || event.type === "subscription.renewed") {
        const subscriptionId = event.data?.subscription_id ?? "unknown";
        const periodEnd =
          event.data?.next_billing_date ?? new Date(Date.now() + PRO_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
        activateSubscription(db, {
          tier: "pro",
          dodoSubscriptionId: subscriptionId,
          dodoPaymentId: event.data?.payment_id ?? null,
          currentPeriodEnd: periodEnd,
        });
      } else if (event.type === "subscription.cancelled" || event.type === "subscription.failed") {
        deactivateSubscription(db);
      }

      return reply.status(200).send({ received: true, duplicate: false });
    });
  });
}
