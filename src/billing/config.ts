export interface BillingConfig {
  apiKey: string;
  webhookKey: string;
  productId: string;
  environment: "test_mode" | "live_mode";

  apiBaseUrl: string;

  returnUrl: string;
}

const TEST_API_BASE_URL = "https://test.dodopayments.com";
const LIVE_API_BASE_URL = "https://live.dodopayments.com";

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
      (process.env.DODO_API_BASE_URL || undefined) ??
      (environment === "live_mode" ? LIVE_API_BASE_URL : TEST_API_BASE_URL),
    returnUrl: (process.env.DODO_RETURN_URL || undefined) ?? "/settings",
  };
}
