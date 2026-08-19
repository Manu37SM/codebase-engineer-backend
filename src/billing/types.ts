/**
 * Phase 26 monetization architecture. Per docs/MONETIZATION.md §3's
 * isolation principle, everything in `backend/src/billing/` is its own
 * self-contained module — no file under `analysis/`, `ai/`, `git/`, or
 * `patch/` imports anything from here, and this module never gains a
 * runtime dependency the other direction either beyond reading the
 * already-existing, billing-agnostic `ai_request` accounting table (see
 * `usageLimiter.ts`). Free Mode and AI Mode (with a user's own provider
 * key) both continue to work identically whether billing is configured
 * or not — see `config.ts`'s `loadBillingConfig()` for how "not
 * configured" is detected and treated as "unlimited, exactly like before
 * this phase existed."
 */

export type Tier = "free" | "pro";

export interface TierLimits {
  tier: Tier;
  /** Max AI-Mode operations (explain/root-cause/fix-plan/generate-patch/
   * generate-test/diagnose/self-review calls) per calendar month.
   * `null` = unlimited. */
  monthlyAiOperations: number | null;
}

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { tier: "free", monthlyAiOperations: 50 },
  pro: { tier: "pro", monthlyAiOperations: null },
};

export interface SubscriptionRecord {
  id: string;
  tier: Tier;
  status: "active" | "inactive";
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}
