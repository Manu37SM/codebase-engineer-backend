import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRazorpayClient, RazorpayError } from "../src/billing/razorpayClient.js";

/**
 * Same pattern as `aiProviderAdapter.test.ts`: a real local HTTP server
 * speaking Razorpay's documented Orders API shape, not a mocked `fetch`.
 * This project has no live Razorpay account/credentials to test against,
 * and shouldn't call a real payment API from a test suite anyway — a
 * local double that implements the real wire protocol (Basic Auth of
 * `key_id:key_secret`, the real JSON request/response shape) is the
 * closest honest equivalent.
 */
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

describe("createRazorpayClient — against a real local server", () => {
  it("creates a real order with correct Basic Auth and request body", async () => {
    const { url, close } = await startServer((req, res) => {
      expect(req.url).toBe("/orders");
      expect(req.method).toBe("POST");
      const expectedAuth = "Basic " + Buffer.from("rzp_test_key:rzp_test_secret").toString("base64");
      expect(req.headers.authorization).toBe(expectedAuth);

      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        expect(parsed.amount).toBe(999900);
        expect(parsed.currency).toBe("INR");
        expect(parsed.receipt).toBe("test-receipt-1");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "order_realTestId123",
            amount: 999900,
            currency: "INR",
            status: "created",
            receipt: "test-receipt-1",
          })
        );
      });
    });

    try {
      const client = createRazorpayClient({ keyId: "rzp_test_key", keySecret: "rzp_test_secret", baseUrl: url });
      const order = await client.createOrder({ amountPaise: 999900, currency: "INR", receipt: "test-receipt-1" });
      expect(order).toEqual({
        id: "order_realTestId123",
        amount: 999900,
        currency: "INR",
        status: "created",
        receipt: "test-receipt-1",
      });
    } finally {
      await close();
    }
  });

  it("classifies a 401 response as auth_error", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { description: "Invalid key" } }));
    });
    try {
      const client = createRazorpayClient({ keyId: "bad", keySecret: "bad", baseUrl: url });
      await expect(client.createOrder({ amountPaise: 100, currency: "INR", receipt: "r1" })).rejects.toMatchObject({
        kind: "auth_error",
      });
    } finally {
      await close();
    }
  });

  it("classifies a 429 response as rate_limited", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { description: "Too many requests" } }));
    });
    try {
      const client = createRazorpayClient({ keyId: "k", keySecret: "s", baseUrl: url });
      await expect(client.createOrder({ amountPaise: 100, currency: "INR", receipt: "r1" })).rejects.toMatchObject({
        kind: "rate_limited",
      });
    } finally {
      await close();
    }
  });

  it("throws RazorpayError with kind unreachable when the server is unreachable", async () => {
    const client = createRazorpayClient({ keyId: "k", keySecret: "s", baseUrl: "http://127.0.0.1:1" });
    await expect(client.createOrder({ amountPaise: 100, currency: "INR", receipt: "r1" })).rejects.toBeInstanceOf(
      RazorpayError
    );
  });

  it("throws unreachable when the order response is missing an id", async () => {
    const { url, close } = await startServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ amount: 100 }));
    });
    try {
      const client = createRazorpayClient({ keyId: "k", keySecret: "s", baseUrl: url });
      await expect(client.createOrder({ amountPaise: 100, currency: "INR", receipt: "r1" })).rejects.toMatchObject({
        kind: "unreachable",
      });
    } finally {
      await close();
    }
  });
});
