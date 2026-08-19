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

const RAZORPAY_ENV_KEYS = [
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "RAZORPAY_WEBHOOK_SECRET",
  "RAZORPAY_API_BASE_URL",
] as const;

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

describe("billing API", () => {
  let tmpDbDir: string;
  let db: DB;
  let app: FastifyInstance;
  let repoRoot: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(RAZORPAY_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of RAZORPAY_ENV_KEYS) delete process.env[k];

    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-billing-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db });
    repoRoot = makeTempRepo();
  });

  afterEach(async () => {
    for (const k of RAZORPAY_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    await app.close();
    db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
    cleanupRepo(repoRoot);
  });

  it("reports not configured when no RAZORPAY_* env vars are set (the default)", async () => {
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
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";

    const res = await app.inject({ method: "GET", url: "/api/v1/billing/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.configured).toBe(true);
    expect(body.tier).toBe("free");
    expect(body.limit).toBe(50);
    expect(body.used).toBe(0);
    expect(body.subscription.status).toBe("active");
  });

  it("creates a real checkout order against a real Razorpay-shaped local server", async () => {
    const { url, close } = await startServer((req, res) => {
      expect(req.url).toBe("/orders");
      let bodyStr = "";
      req.on("data", (c) => (bodyStr += c));
      req.on("end", () => {
        const parsed = JSON.parse(bodyStr);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "order_realTest1",
            amount: parsed.amount,
            currency: parsed.currency,
            status: "created",
            receipt: parsed.receipt,
          })
        );
      });
    });

    try {
      process.env.RAZORPAY_KEY_ID = "rzp_test_key";
      process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
      process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
      process.env.RAZORPAY_API_BASE_URL = url;

      const res = await app.inject({ method: "POST", url: "/api/v1/billing/checkout" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.orderId).toBe("order_realTest1");
      expect(body.keyId).toBe("rzp_test_key");
      expect(body.currency).toBe("INR");
    } finally {
      await close();
    }
  });

  it("rejects a webhook with an invalid signature", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: { "x-razorpay-signature": "not-a-real-signature", "content-type": "application/json" },
      payload: JSON.stringify({ event: "payment.captured" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("activates a pro subscription from a real, correctly-signed webhook", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";

    const payload = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_real123", order_id: "order_real123" } } },
    });
    const signature = crypto.createHmac("sha256", "whsec_test").update(payload).digest("hex");

    const webhookRes = await app.inject({
      method: "POST",
      url: "/api/v1/billing/webhook",
      headers: { "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_real_1", "content-type": "application/json" },
      payload,
    });
    expect(webhookRes.statusCode).toBe(200);
    expect(webhookRes.json()).toEqual({ received: true, duplicate: false });

    const statusRes = await app.inject({ method: "GET", url: "/api/v1/billing/status" });
    const status = statusRes.json();
    expect(status.tier).toBe("pro");
    expect(status.limit).toBeNull();
  });

  it("treats a redelivered webhook event id as a no-op, not a re-activation", async () => {
    process.env.RAZORPAY_KEY_ID = "rzp_test_key";
    process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";

    const payload = JSON.stringify({
      event: "payment.captured",
      payload: { payment: { entity: { id: "pay_dup", order_id: "order_dup" } } },
    });
    const signature = crypto.createHmac("sha256", "whsec_test").update(payload).digest("hex");
    const headers = { "x-razorpay-signature": signature, "x-razorpay-event-id": "evt_dup_1", "content-type": "application/json" };

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
      process.env.RAZORPAY_KEY_ID = "rzp_test_key";
      process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
      process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";

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
