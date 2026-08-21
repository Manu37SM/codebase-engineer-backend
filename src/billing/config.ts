export interface BillingConfig {
  apiKey: string;
  webhookKey: string;
  productId: string;
  environment: "test_mode" | "live_mode";
  /** Overridable for tests — real Dodo Payments API base URL otherwise. */
  apiBaseUrl: string;
  /** Where Dodo's hosted checkout redirects the browser after payment succeeds/fails. */
  returnUrl: string;
}

const TEST_API_BASE_URL = "https://test.dodopayments.com";
const LIVE_API_BASE_URL = "https://live.dodopayments.com";

/**
 * Billing is entirely env-var configured (unlike AI providers, which are
 * DB-configured per `provider_configuration` — see docs/ARCHITECTURE.md
 * §3) because this is operator/instance-level infrastructure config, the
 * same category as `PORT`/`HOST`/`CODEBASE_ENGINEER_DATA_DIR` in
 * `config.ts`, not something end-user-editable through the app's own UI.
 * A real Dodo Payments API key is also exactly the kind of credential
 * that shouldn't have a "paste it into a web form" path when an env var
 * already covers it.
 *
 * Provider note: this module originally targeted Razorpay. Razorpay's
 * merchant onboarding rejected this product's live account application
 * because self-hosted software gets auto-classified under their
 * restricted "hosting" business category — a policy block, not something
 * fixable by re-describing the business in the signup form (confirmed by
 * a second rejection with identical wording after resubmission). Dodo
 * Payments is a merchant-of-record platform aimed at AI/SaaS products
 * that explicitly supports individual sellers without incorporation and
 * has no equivalent hosting exclusion, so billing was re-pointed at it.
 * No live Dodo account/transaction has gone through this code yet — it's
 * built against Dodo's public API/webhook docs
 * (https://docs.dodopayments.com), same honesty caveat the original
 * Razorpay client carried before it (see git history) about not having
 * live credentials in this development sandbox.
 *
 * Returns `null` when any of the three required Dodo credentials are
 * missing — the billing module and every route in `routes/billing.ts`
 * treat `null` as "billing not configured", which is the default,
 * unlimited-by-definition state (`usageLimiter.ts`'s
 * `checkAiOperationAllowed()` always returns `allowed: true` in that
 * case). This is deliberate, not a gap: billing must not turn AI Mode
 * from "works today with just a provider key" into "now also requires a
 * Dodo Payments account", which would violate docs/PRD.md §3's "AI is
 * optional" principle.
 */
export function loadBillingConfig(): BillingConfig | null {
  const apiKey = process.env.DODO_PAYMENTS_API_KEY;
  const webhookKey = process.env.DODO_PAYMENTS_WEBHOOK_KEY;
  const productId = process.env.DODO_PRODUCT_ID;

  if (!apiKey || !webhookKey || !productId) {
    return null;
  }

  const environment: "test_mode" | "live_mode" =
    process.env.DODO_PAYMENTS_ENVIRONMENT === "live_mode" ? "live_mode" : "test_mode";

  return {
    apiKey,
    webhookKey,
    productId,
    environment,
    apiBaseUrl:
      process.env.DODO_API_BASE_URL ?? (environment === "live_mode" ? LIVE_API_BASE_URL : TEST_API_BASE_URL),
    returnUrl: process.env.DODO_RETURN_URL ?? "/settings",
  };
}
