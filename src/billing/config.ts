export interface BillingConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  /** Overridable so a self-hoster isn't stuck with this file's illustrative default. */
  proPricePaise: number;
  proPriceCurrency: string;
  /** Overridable for tests — real Razorpay API base URL otherwise. */
  apiBaseUrl: string;
}

const DEFAULT_PRO_PRICE_PAISE = 999900; // ₹9,999.00 — illustrative default, override via RAZORPAY_PRO_PRICE_PAISE.
const DEFAULT_API_BASE_URL = "https://api.razorpay.com/v1";

/**
 * Billing is entirely env-var configured (unlike AI providers, which are
 * DB-configured per `provider_configuration` — see docs/ARCHITECTURE.md
 * §3) because this is operator/instance-level infrastructure config, the
 * same category as `PORT`/`HOST`/`CODEBASE_ENGINEER_DATA_DIR` in
 * `config.ts`, not something end-user-editable through the app's own UI.
 * A real Razorpay account's key id/secret are also exactly the kind of
 * credential that shouldn't have a "paste it into a web form" path when
 * an env var already covers it.
 *
 * Returns `null` when any of the three required Razorpay credentials are
 * missing — the billing module and every route in `routes/billing.ts`
 * treat `null` as "billing not configured", which is the default,
 * unlimited-by-definition state (`usageLimiter.ts`'s
 * `checkAiOperationAllowed()` always returns `allowed: true` in that
 * case). This is deliberate, not a gap: Phase 26 must not turn AI Mode
 * from "works today with just a provider key" into "now also requires a
 * Razorpay account", which would violate docs/PRD.md §3's "AI is
 * optional" principle at a level above what this phase is scoped to
 * change.
 */
export function loadBillingConfig(): BillingConfig | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!keyId || !keySecret || !webhookSecret) {
    return null;
  }

  const proPricePaise = process.env.RAZORPAY_PRO_PRICE_PAISE
    ? Number(process.env.RAZORPAY_PRO_PRICE_PAISE)
    : DEFAULT_PRO_PRICE_PAISE;

  return {
    keyId,
    keySecret,
    webhookSecret,
    proPricePaise,
    proPriceCurrency: process.env.RAZORPAY_PRO_PRICE_CURRENCY ?? "INR",
    apiBaseUrl: process.env.RAZORPAY_API_BASE_URL ?? DEFAULT_API_BASE_URL,
  };
}
