import type { DB } from "../db/index.js";
import { loadBillingConfig } from "./config.js";
import { expireSubscriptionIfPastPeriod } from "./subscriptionRepo.js";
import { TIER_LIMITS } from "./types.js";

export interface UsageCheckResult {
  allowed: boolean;
  tier: "free" | "pro";
  used: number;
  limit: number | null;
  /** Human-readable, honest — same convention every other AI-Mode 400/402 message in this product follows. `null` when allowed or billing isn't configured. */
  reason: string | null;
}

/**
 * The single enforcement point Phase 26 adds ahead of every AI-Mode
 * action, per docs/AI_MODE.md §7 ("Configurable limits ... enforced by
 * checking accumulated usage before issuing a new request"). Reads the
 * existing, billing-agnostic `ai_request` table (Phase 12/14) — it is
 * never modified by this module, only read, exactly matching
 * docs/MONETIZATION.md §3's isolation principle ("A future billing
 * module reads from it to enforce limits; it does not need to be
 * rewritten to add billing").
 *
 * When billing isn't configured (`loadBillingConfig()` returns `null` —
 * the default, out-of-the-box state), this always returns
 * `allowed: true` — identical behavior to every phase before this one.
 * Billing only ever starts enforcing a limit once an operator has
 * deliberately set all three `RAZORPAY_*` env vars, per
 * docs/PRD.md §3's "AI is optional" principle.
 */
export function checkAiOperationAllowed(db: DB): UsageCheckResult {
  const billingConfig = loadBillingConfig();
  if (!billingConfig) {
    return { allowed: true, tier: "free", used: 0, limit: null, reason: null };
  }

  const nowIso = new Date().toISOString();
  const subscription = expireSubscriptionIfPastPeriod(db, nowIso);
  const limits = TIER_LIMITS[subscription.tier];

  if (limits.monthlyAiOperations === null) {
    return { allowed: true, tier: subscription.tier, used: 0, limit: null, reason: null };
  }

  const used = getMonthlyAiOperationCount(db, nowIso);
  const allowed = used < limits.monthlyAiOperations;

  return {
    allowed,
    tier: subscription.tier,
    used,
    limit: limits.monthlyAiOperations,
    reason: allowed
      ? null
      : `Monthly AI operation limit reached (${used}/${limits.monthlyAiOperations} on the ${subscription.tier} tier). Upgrade to Pro for unlimited AI operations, or wait until next month.`,
  };
}

/** Counts every `ai_request` row created in the same calendar month (UTC) as `nowIso` — a simple, honest, non-rolling-window definition of "this month", matching how a monthly subscription period is generally understood. Not scoped by project: this instance's usage is instance-wide, consistent with `subscription` being a single-row, instance-level table. */
export function getMonthlyAiOperationCount(db: DB, nowIso: string): number {
  const monthPrefix = nowIso.slice(0, 7); // "YYYY-MM"
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM ai_request WHERE substr(created_at, 1, 7) = ?`)
    .get(monthPrefix) as { count: number };
  return row.count;
}
