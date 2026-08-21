import type { DB } from "../db/index.js";
import type { SubscriptionRecord, Tier } from "./types.js";

const SINGLETON_ID = "instance";

/**
 * This app is single-instance (docs/PRD.md §7: no multi-tenant/team
 * features), so there is exactly one subscription row, always at a fixed
 * id — never one per project, never one per end-user. `getOrCreate`
 * inserts the default (`tier: 'free'`) row on first call rather than the
 * migration seeding it, keeping migration 011 a pure schema change with
 * no data assumptions (consistent with every other migration in this
 * project).
 */
export function getOrCreateSubscription(db: DB): SubscriptionRecord {
  const existing = db
    .prepare("SELECT * FROM subscription WHERE id = ?")
    .get(SINGLETON_ID) as SubscriptionRecord | undefined;
  if (existing) return existing;

  db.prepare(
    `INSERT INTO subscription (id, tier, status) VALUES (?, 'free', 'active')`
  ).run(SINGLETON_ID);

  return db.prepare("SELECT * FROM subscription WHERE id = ?").get(SINGLETON_ID) as SubscriptionRecord;
}

export interface ActivateSubscriptionInput {
  tier: Tier;
  dodoSubscriptionId: string;
  dodoPaymentId: string | null;
  /** ISO timestamp — from Dodo's `next_billing_date` when the webhook payload includes one, otherwise a 30-day fallback computed in routes/billing.ts. */
  currentPeriodEnd: string;
}

export function activateSubscription(db: DB, input: ActivateSubscriptionInput): SubscriptionRecord {
  getOrCreateSubscription(db); // ensures the singleton row exists first
  db.prepare(
    `UPDATE subscription
     SET tier = ?, status = 'active', dodo_subscription_id = ?, dodo_payment_id = ?,
         current_period_end = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(input.tier, input.dodoSubscriptionId, input.dodoPaymentId, input.currentPeriodEnd, SINGLETON_ID);
  return db.prepare("SELECT * FROM subscription WHERE id = ?").get(SINGLETON_ID) as SubscriptionRecord;
}

/** Called on a `subscription.cancelled` webhook — downgrades to `free` immediately rather than waiting for `current_period_end`, matching Dodo's own subscription-cancelled state rather than this app inventing a separate "cancels at period end" grace state it would then have to track. */
export function deactivateSubscription(db: DB): SubscriptionRecord {
  getOrCreateSubscription(db);
  db.prepare(
    `UPDATE subscription SET tier = 'free', status = 'inactive', updated_at = datetime('now') WHERE id = ?`
  ).run(SINGLETON_ID);
  return db.prepare("SELECT * FROM subscription WHERE id = ?").get(SINGLETON_ID) as SubscriptionRecord;
}

/** Downgrades back to `free` once a paid period lapses without a renewal webhook ever arriving — a safety net (`usageLimiter.ts` calls this on every check), not the primary way a subscription ends; `subscription.cancelled` handling above is. Not called by any timer/cron (this app has none). */
export function expireSubscriptionIfPastPeriod(db: DB, now: string): SubscriptionRecord {
  const sub = getOrCreateSubscription(db);
  if (sub.tier === "pro" && sub.current_period_end && sub.current_period_end < now) {
    db.prepare(
      `UPDATE subscription SET tier = 'free', status = 'inactive', updated_at = datetime('now') WHERE id = ?`
    ).run(SINGLETON_ID);
    return db.prepare("SELECT * FROM subscription WHERE id = ?").get(SINGLETON_ID) as SubscriptionRecord;
  }
  return sub;
}

/** Idempotent webhook-event recording — returns `true` if this is the first time this Dodo event id (the `webhook-id` header) has been seen, `false` if it's a redelivery (Dodo, like most payment providers, redelivers on a non-2xx response or timeout, so a real handler must tolerate seeing the same event id more than once). */
export function recordWebhookEventIfNew(
  db: DB,
  id: string,
  dodoEventId: string,
  eventType: string,
  payload: string
): boolean {
  const existing = db
    .prepare("SELECT id FROM billing_webhook_event WHERE dodo_event_id = ?")
    .get(dodoEventId);
  if (existing) return false;

  db.prepare(
    `INSERT INTO billing_webhook_event (id, dodo_event_id, event_type, payload) VALUES (?, ?, ?, ?)`
  ).run(id, dodoEventId, eventType, payload);
  return true;
}
