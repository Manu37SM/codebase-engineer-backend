import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { openDatabase, DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";
import { makeTempRepo, writeFile, cleanupRepo } from "./fixtures.js";

const DODO_ENV_KEYS = [
  "DODO_PAYMENTS_API_KEY",
  "DODO_PAYMENTS_WEBHOOK_KEY",
  "DODO_PRODUCT_ID",
  "DODO_PAYMENTS_ENVIRONMENT",
  "DODO_API_BASE_URL",
  "DODO_RETURN_URL",
] as const;

const TEST_WEBHOOK_SECRET_B64 = Buffer.from("test_webhook_secret_32_bytes_ok").toString("base64");
const TEST_WEBHOOK_KEY = `whsec_${TEST_WEBHOOK_SECRET_B64}`;

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function signDodoWebhook(id: string, timestamp: string, payload: string): string {
  const secretBuf = Buffer.from(TEST_WEBHOOK_SECRET_B64, "base64");
  const signedContent = `${id}.${timestamp}.${payload}`;
  const sig = crypto.createHmac("sha256", secretBuf).update(signedContent).digest("base64");
  return `v1,${sig}`;
}

describe("billing API", () => {
  let tmpDbDir: string;
  let db: DB;
  let app: FastifyInstance;
  let repoRoot: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(DODO_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of DODO_ENV_KEYS) delete process.env[k];

    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-billing-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db });
    repoRoot = makeTempRepo();
  });

  afterEach(async () => {
    for (const k of DODO_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await app.close();
    db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    cleanupRepo(repoRoot);
  });

  it("reports not configured when no DODO_* env vars are set (the default)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/billing/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ configured: false, tier: "free", limit: null, used: 0, subscription: null });
  });

  it("refuses checkout when billing is not configured", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/billing/checkout" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not configured/);
  });

  it("reports a real free-tier status once billing is configured", async () => {
    process.env.DODO_PAYMENTS_API_KEY = "dodo_test_key";
    process.env.DODO_PAYMENTS_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
    process.env.DODO_PRODUCT_ID = "prod_test_pro";

    const res = await app.inject({ method: "GET", url: "/api/v1/billing/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.tier).toBe("free");
    expect(body.limit).toBe(50);
    expect(body.used).toBe(0);
    expect(body.subscription.status).toBe("active");
  });

  it("creates a real checkout session against a real Dodo-Payments-shaped local server", async () => {
    const { url, close } = await startServer((req, res) => {
      expect(req.url).toBe("/checkouts");
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", () => {
        const parsed = JSON.parse(bodyStr);
        expect(parsed.product_cart).toEqual([{ product_id: "prod_test_pro", quantity: 1 }]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            session_id: "cks_realTest1",
            checkout_url: "https://test.dodopayments.com/checkout/cks_realTest1",
          })
        );
      });
    });

    try {
      process.env.DODO_PAYMENTS_API_KEY = "dodo_test_key";
      process.env.DODO_PAYMENTS_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
      process.env.DODO_PRODUCT_ID = "prod_test_pro";
      process.env.DODO_API_BASE_URL = url;

      const res = await app.inject({ method: "POST", url: "/api/v1/billing/checkout" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sessionId).toBe("cks_realTest1");
      expect(body.checkoutUrl).toBe("https://test.dodopayments.com/checkout/cks_realTest1");
    } finally {
      await close();
    }
  });

  it("falls back to the real Dodo API base URL when DODO_API_BASE_URL is an empty string, not just when it's unset (regression: deploy/docker-compose.yml's ${VAR:-} passthrough)", async () => {
    // deploy/docker-compose.yml always passes these through as
    // `DODO_API_BASE_URL=${DODO_API_BASE_URL:-}`, so on a real deployment
    // where the operator only sets the three required DODO_* vars, this
    // process sees `DODO_API_BASE_URL=""` — the literal empty string, not
    // an unset var. `loadBillingConfig()` used to fall back via `??`,
    // which only catches `null`/`undefined`, so `apiBaseUrl` silently
    // became `""` and every checkout call failed with Node's fetch
    // rejecting a relative URL ("Failed to parse URL from /checkouts")
    // instead of ever reaching Dodo. This reproduces that exact shape
    // directly against the pure config loader — no real network call.
    process.env.DODO_PAYMENTS_API_KEY = "dodo_test_key";
    process.env.DODO_PAYMENTS_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
    process.env.DODO_PRODUCT_ID = "prod_test_pro";
    process.env.DODO_PAYMENTS_ENVIRONMENT = "live_mode";
    process.env.DODO_API_BASE_URL = "";
    process.env.DODO_RETURN_URL = "";

    const { loadBillingConfig } = await import("../src/billing/config.js");
    const config = loadBillingConfig();
    expect(config).not.toBeNull();
    expect(config!.apiBaseUrl).toBe("https://live.dodopayments.com");
    expect(config!.returnUrl).toBe("/settings");
  });

  it("rejects a webhook with an invalid signature", async () => {
    process.env.DODO_PAYMENTS_API_KEY = "dodo_test_key";
    process.env.DODO_PAYMENTS_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
    process.env.DODO_PRODUCT_ID = "prod_test_pro";

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: {
        "webhook-id": "msg_bad",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": "v1,not-a-real-signature",
        "content-type": "application/json",
      },
      payload: JSON.stringify({ type: "subscription.active" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("activates a pro subscription from a real, correctly-signed webhook", async () => {
    process.env.DODO_PAYMENTS_API_KEY = "dodo_test_key";
    process.env.DODO_PAYMENTS_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
    process.env.DODO_PRODUCT_ID = "prod_test_pro";

    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify({
      type: "subscription.active",
      data: { subscription_id: "sub_real123", payment_id: "pay_real123", next_billing_date: "2099-01-01T00:00:00.000Z" },
    });
    const signature = signDodoWebhook("evt_real_1", timestamp, payload);

    const webhookRes = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: {
        "webhook-id": "evt_real_1",
        "webhook-timestamp": timestamp,
        "webhook-signature": signature,
        "content-type": "application/json",
      },
      payload,
    });
    expect(webhookRes.statusCode).toBe(200);
    expect(webhookRes.json()).toEqual({ received: true, duplicate: false });

    const statusRes = await app.inject({ method: "GET", url: "/api/v1/billing/status" });
    const status = statusRes.json();
    expect(status.tier).toBe("pro");
    expect(status.limit).toBeNull();
    expect(status.subscription.currentPeriodEnd).toBe("2099-01-01T00:00:00.000Z");
  });

  it("deactivates a pro subscription on a subscription.cancelled webhook", async () => {
    process.env.DODO_PAYMENTS_API_KEY = "dodo_test_key";
    process.env.DODO_PAYMENTS_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
    process.env.DODO_PRODUCT_ID = "prod_test_pro";

    const activateTimestamp = String(Math.floor(Date.now() / 1000));
    const activatePayload = JSON.stringify({
      type: "subscription.active",
      data: { subscription_id: "sub_cancel_me", next_billing_date: "2099-01-01T00:00:00.000Z" },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: {
        "webhook-id": "evt_activate_1",
        "webhook-timestamp": activateTimestamp,
        "webhook-signature": signDodoWebhook("evt_activate_1", activateTimestamp, activatePayload),
        "content-type": "application/json",
      },
      payload: activatePayload,
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/billing/status" })).json().tier).toBe("pro");

    const cancelTimestamp = String(Math.floor(Date.now() / 1000));
    const cancelPayload = JSON.stringify({
      type: "subscription.cancelled",
      data: { subscription_id: "sub_cancel_me" },
    });
    const cancelRes = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: {
        "webhook-id": "evt_cancel_1",
        "webhook-timestamp": cancelTimestamp,
        "webhook-signature": signDodoWebhook("evt_cancel_1", cancelTimestamp, cancelPayload),
        "content-type": "application/json",
      },
      payload: cancelPayload,
    });
    expect(cancelRes.statusCode).toBe(200);

    const statusRes = await app.inject({ method: "GET", url: "/api/v1/billing/status" });
    expect(statusRes.json().tier).toBe("free");
  });

  it("treats a redelivered webhook event id as a no-op, not a re-activation", async () => {
    process.env.DODO_PAYMENTS_API_KEY = "dodo_test_key";
    process.env.DODO_PAYMENTS_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
    process.env.DODO_PRODUCT_ID = "prod_test_pro";

    const timestamp = String(Math.floor(Date.now() / 1000));
    const payload = JSON.stringify({
      type: "subscription.active",
      data: { subscription_id: "sub_dup", next_billing_date: "2099-01-01T00:00:00.000Z" },
    });
    const headers = {
      "webhook-id": "evt_dup_1",
      "webhook-timestamp": timestamp,
      "webhook-signature": signDodoWebhook("evt_dup_1", timestamp, payload),
      "content-type": "application/json",
    };

    const first = await app.inject({ method: "POST", url: "/api/v1/billing/webhook", headers, payload });
    expect(first.json()).toEqual({ received: true, duplicate: false });

    const redelivered = await app.inject({ method: "POST", url: "/api/v1/billing/webhook", headers, payload });
    expect(redelivered.statusCode).toBe(200);
    expect(redelivered.json()).toEqual({ received: true, duplicate: true });
  });

  it("blocks a real AI-Mode action with 402 once the free tier's monthly limit is reached", async () => {
    writeFile(repoRoot, "package.json", JSON.stringify({ name: "fixture" }));
    writeFile(repoRoot, "src/config.ts", `const apiKey = "sk_live_ABCDEFGHIJKLMNOPQRSTUV";\nexport const x = 1;\n`);

    const { url, close } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "gpt-test",
          choices: [{ message: { content: "explanation" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        })
      );
    });

    try {
      process.env.DODO_PAYMENTS_API_KEY = "dodo_test_key";
      process.env.DODO_PAYMENTS_WEBHOOK_KEY = TEST_WEBHOOK_KEY;
      process.env.DODO_PRODUCT_ID = "prod_test_pro";

      const providerRes = await app.inject({
        method: "POST",
        url: "/api/v1/ai/providers",
        payload: { name: "Local Test Provider", kind: "openai-compatible", baseUrl: url, model: "gpt-test" },
      });
      const { provider } = providerRes.json();
      await app.inject({ method: "PATCH", url: `/api/v1/ai/providers/${provider.id}`, payload: { enabled: true } });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        payload: { name: "billing-limit-fixture", rootPath: repoRoot },
      });
      const { project } = createRes.json();
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/discover` });
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/index` });
      await app.inject({ method: "POST", url: `/api/v1/projects/${project.id}/analysis` });

      const findingsRes = await app.inject({ method: "GET", url: `/api/v1/projects/${project.id}/findings` });
      const finding = findingsRes.json().findings[0];
      expect(finding).toBeTruthy();

      // Real 50 successful AI operations against the real /explain route,
      // reaching the free tier's real limit through real usage, not a
      // fabricated count.
      let lastRes;
      for (let i = 0; i < 50; i++) {
        lastRes = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${project.id}/findings/${finding.id}/explain`,
        });
        expect(lastRes.statusCode).toBe(200);
      }

      const blockedRes = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${project.id}/findings/${finding.id}/explain`,
      });
      expect(blockedRes.statusCode).toBe(402);
      expect(blockedRes.json().error).toMatch(/limit reached/);
    } finally {
      await close();
    }
  });
});
