import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import { loadBillingConfig } from "../billing/config.js";
import { createRazorpayClient, RazorpayError } from "../billing/razorpayClient.js";
import { verifyRazorpayWebhookSignature } from "../billing/webhookVerify.js";
import { getOrCreateSubscription, activateSubscription, recordWebhookEventIfNew } from "../billing/subscriptionRepo.js";
import { checkAiOperationAllowed } from "../billing/usageLimiter.js";
import { TIER_LIMITS } from "../billing/types.js";

interface RegisterBillingRoutesOptions {
  db: DB;
}

/**
 * Phase 26 optional monetization architecture (docs/MONETIZATION.md,
 * docs/ROADMAP.md Phase 26). Every route here degrades to an honest
 * "billing not configured" response when `RAZORPAY_*` env vars aren't
 * set (the default, out-of-the-box state) — never a 500, never a
 * silently-fabricated "unlimited" or "no subscription" shape that looks
 * like a real answer but isn't. See `billing/config.ts`'s
 * `loadBillingConfig()` doc comment for why this is env-var, not
 * DB-configured.
 *
 * Deliberately NOT a real recurring-subscription integration: Razorpay
 * Subscriptions (recurring mandates) is a materially larger integration
 * (mandate creation, a different webhook event set, retry/dunning
 * handling) than this phase's "optional monetization architecture" scope
 * calls for. What's implemented instead is a real one-time-order +
 * webhook-verified-payment flow that activates a Pro period for a fixed
 * duration (`PRO_PERIOD_DAYS` below) — a real, working payment
 * verification path, honestly scoped as non-recurring rather than
 * pretending to auto-renew. Extending to Razorpay Subscriptions is a
 * natural next step if this is ever used for real, not attempted here
 * speculatively.
 */
const PRO_PERIOD_DAYS = 30;

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
        error: "Billing is not configured on this instance. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, and RAZORPAY_WEBHOOK_SECRET to enable it.",
      });
    }

    const client = createRazorpayClient({
      keyId: billingConfig.keyId,
      keySecret: billingConfig.keySecret,
      baseUrl: billingConfig.apiBaseUrl,
    });

    try {
      const order = await client.createOrder({
        amountPaise: billingConfig.proPricePaise,
        currency: billingConfig.proPriceCurrency,
        receipt: `pro-upgrade-${randomUUID()}`,
      });
      return reply.status(200).send({
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: billingConfig.keyId, // safe to return — the publishable key id, not the secret; Razorpay's own Checkout widget needs it client-side
      });
    } catch (err) {
      if (err instanceof RazorpayError) {
        const status = err.kind === "auth_error" ? 502 : err.kind === "rate_limited" ? 429 : 502;
        return reply.status(status).send({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * Razorpay webhook receiver. Registered inside its own encapsulated
   * plugin context so only this one route gets a raw-buffer content-type
   * parser override — every other route in the app keeps Fastify's
   * normal JSON body parsing untouched. The raw bytes are required
   * because `verifyRazorpayWebhookSignature` must check the signature
   * against the exact bytes Razorpay signed, before any JSON
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
      const signature = request.headers["x-razorpay-signature"] as string | undefined;

      if (!verifyRazorpayWebhookSignature(rawBody, signature, billingConfig.webhookSecret)) {
        return reply.status(400).send({ error: "Invalid webhook signature." });
      }

      let event: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string } } } };
      try {
        event = JSON.parse(rawBody.toString("utf-8"));
      } catch {
        return reply.status(400).send({ error: "Webhook body was not valid JSON." });
      }

      const razorpayEventId = (request.headers["x-razorpay-event-id"] as string | undefined) ?? randomUUID();
      const isNew = recordWebhookEventIfNew(db, randomUUID(), razorpayEventId, event.event ?? "unknown", rawBody.toString("utf-8"));

      // A redelivery of an already-processed event is still a valid,
      // successfully-handled webhook from Razorpay's perspective — ack
      // with 200 rather than reprocessing (and never re-activating a
      // period from a stale event), so Razorpay stops retrying it.
      if (!isNew) {
        return reply.status(200).send({ received: true, duplicate: true });
      }

      if (event.event === "payment.captured" || event.event === "order.paid") {
        const paymentId = event.payload?.payment?.entity?.id ?? "unknown";
        const orderId = event.payload?.payment?.entity?.order_id ?? "unknown";
        const periodEnd = new Date(Date.now() + PRO_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
        activateSubscription(db, {
          tier: "pro",
          razorpayOrderId: orderId,
          razorpayPaymentId: paymentId,
          currentPeriodEnd: periodEnd,
        });
      }

      return reply.status(200).send({ received: true, duplicate: false });
    });
  });
}
