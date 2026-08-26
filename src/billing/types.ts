

export type Tier = "free" | "pro";

export interface TierLimits {
  tier: Tier;

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
  dodo_subscription_id: string | null;
  dodo_payment_id: string | null;
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}
