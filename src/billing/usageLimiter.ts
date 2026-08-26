import type { DB } from "../db/index.js";
import { loadBillingConfig } from "./config.js";
import { expireSubscriptionIfPastPeriod } from "./subscriptionRepo.js";
import { TIER_LIMITS } from "./types.js";

export interface UsageCheckResult {
  allowed: boolean;
  tier: "free" | "pro";
  used: number;
  limit: number | null;

  reason: string | null;
}

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

export function getMonthlyAiOperationCount(db: DB, nowIso: string): number {
  const monthPrefix = nowIso.slice(0, 7); 
  const row = db
    .prepare(`SELECT COUNT(*) as count FROM ai_request WHERE substr(created_at, 1, 7) = ?`)
    .get(monthPrefix) as { count: number };
  return row.count;
}
