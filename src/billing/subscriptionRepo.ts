import type { DB } from "../db/index.js";
import type { SubscriptionRecord, Tier } from "./types.js";

const SINGLETON_ID = "instance";

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

  currentPeriodEnd: string;
}

export function activateSubscription(db: DB, input: ActivateSubscriptionInput): SubscriptionRecord {
  getOrCreateSubscription(db); 
  db.prepare(
    `UPDATE subscription
     SET tier = ?, status = 'active', dodo_subscription_id = ?, dodo_payment_id = ?,
         current_period_end = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(input.tier, input.dodoSubscriptionId, input.dodoPaymentId, input.currentPeriodEnd, SINGLETON_ID);
  return db.prepare("SELECT * FROM subscription WHERE id = ?").get(SINGLETON_ID) as SubscriptionRecord;
}

export function deactivateSubscription(db: DB): SubscriptionRecord {
  getOrCreateSubscription(db);
  db.prepare(
    `UPDATE subscription SET tier = 'free', status = 'inactive', updated_at = datetime('now') WHERE id = ?`
  ).run(SINGLETON_ID);
  return db.prepare("SELECT * FROM subscription WHERE id = ?").get(SINGLETON_ID) as SubscriptionRecord;
}

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
