import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, DB } from "../src/db/index.js";
import {
  getOrCreateSubscription,
  activateSubscription,
  expireSubscriptionIfPastPeriod,
  recordWebhookEventIfNew,
} from "../src/billing/subscriptionRepo.js";

describe("subscriptionRepo", () => {
  let tmpDir: string;
  let db: DB;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-subscription-test-"));
    db = openDatabase(path.join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a single default free/active row on first read", () => {
    const sub = getOrCreateSubscription(db);
    expect(sub.tier).toBe("free");
    expect(sub.status).toBe("active");

    // Calling it again returns the same row, not a second one.
    const again = getOrCreateSubscription(db);
    expect(again.id).toBe(sub.id);
    const count = db.prepare("SELECT COUNT(*) as c FROM subscription").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("activates a pro subscription with real order/payment ids and a period end", () => {
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const sub = activateSubscription(db, {
      tier: "pro",
      razorpayOrderId: "order_abc",
      razorpayPaymentId: "pay_xyz",
      currentPeriodEnd: periodEnd,
    });
    expect(sub.tier).toBe("pro");
    expect(sub.status).toBe("active");
    expect(sub.razorpay_order_id).toBe("order_abc");
    expect(sub.razorpay_payment_id).toBe("pay_xyz");
    expect(sub.current_period_end).toBe(periodEnd);
  });

  it("expires a pro subscription back to free once current_period_end has passed", () => {
    const pastPeriodEnd = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    activateSubscription(db, {
      tier: "pro",
      razorpayOrderId: "order_abc",
      razorpayPaymentId: "pay_xyz",
      currentPeriodEnd: pastPeriodEnd,
    });

    const expired = expireSubscriptionIfPastPeriod(db, new Date().toISOString());
    expect(expired.tier).toBe("free");
    expect(expired.status).toBe("inactive");
  });

  it("does not expire a pro subscription whose period hasn't ended yet", () => {
    const futurePeriodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    activateSubscription(db, {
      tier: "pro",
      razorpayOrderId: "order_abc",
      razorpayPaymentId: "pay_xyz",
      currentPeriodEnd: futurePeriodEnd,
    });

    const stillActive = expireSubscriptionIfPastPeriod(db, new Date().toISOString());
    expect(stillActive.tier).toBe("pro");
    expect(stillActive.status).toBe("active");
  });

  it("records a webhook event once and reports redeliveries as not-new", () => {
    const firstTime = recordWebhookEventIfNew(db, randomUUID(), "evt_123", "payment.captured", "{}");
    expect(firstTime).toBe(true);

    const redelivery = recordWebhookEventIfNew(db, randomUUID(), "evt_123", "payment.captured", "{}");
    expect(redelivery).toBe(false);

    const count = db.prepare("SELECT COUNT(*) as c FROM billing_webhook_event").get() as { c: number };
    expect(count.c).toBe(1);
  });
});
