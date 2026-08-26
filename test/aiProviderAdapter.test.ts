import { describe, it, expect } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createOpenAICompatibleProvider } from "../src/ai/provider/adapters/openaiCompatible.js";
import { AIProviderError } from "../src/ai/provider/types.js";

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

describe("createOpenAICompatibleProvider — against a real local server", () => {
  it("lists models parsed from a real /models response", async () => {
    const { url, close } = await startServer((req, res) => {
      expect(req.url).toBe("/models");
      expect(req.headers.authorization).toBe("Bearer test-key");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-test", context_window: 8192 }] }));
    });
    try {
      const provider = createOpenAICompatibleProvider({ baseUrl: url, apiKey: "test-key", model: "gpt-test" });
      const models = await provider.listModels();
      expect(models).toEqual([{ id: "gpt-test", contextWindow: 8192 }]);
    } finally {
      await close();
    }
  });

  it("completes a real chat request and parses usage/finish_reason", async () => {
    const { url, close } = await startServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        expect(parsed.model).toBe("gpt-test");
        expect(parsed.messages).toEqual([{ role: "user", content: "hello" }]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "gpt-test",
            choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          })
        );
      });
    });
    try {
      const provider = createOpenAICompatibleProvider({ baseUrl: url, model: "gpt-test" });
      const result = await provider.complete({ messages: [{ role: "user", content: "hello" }] });
      expect(result).toEqual({
        content: "hi there",
        model: "gpt-test",
        finishReason: "stop",
        usage: { promptTokens: 3, completionTokens: 2 },
      });
    } finally {
      await close();
    }
  });

  it("classifies a real 401 response as auth_error", async () => {
    const { url, close } = await startServer((req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid api key" }));
    });
    try {
      const provider = createOpenAICompatibleProvider({ baseUrl: url, model: "gpt-test" });
      await expect(provider.listModels()).rejects.toMatchObject({ kind: "auth_error" });
    } finally {
      await close();
    }
  });

  it("classifies a real 429 response as rate_limited", async () => {
    const { url, close } = await startServer((req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "slow down" }));
    });
    try {
      const provider = createOpenAICompatibleProvider({ baseUrl: url, model: "gpt-test" });
      await expect(provider.listModels()).rejects.toMatchObject({ kind: "rate_limited" });
    } finally {
      await close();
    }
  });

  it("classifies a genuinely unreachable server as unreachable", async () => {

    const provider = createOpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:1", model: "gpt-test", timeoutMs: 2000 });
    await expect(provider.listModels()).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("checkStatus reports reachable for a healthy server and auth_error for a bad key", async () => {
    const { url, close } = await startServer((req, res) => {
      if (req.headers.authorization === "Bearer good-key") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
      } else {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
      }
    });
    try {
      const good = createOpenAICompatibleProvider({ baseUrl: url, apiKey: "good-key", model: "gpt-test" });
      expect((await good.checkStatus()).status).toBe("reachable");

      const bad = createOpenAICompatibleProvider({ baseUrl: url, apiKey: "wrong-key", model: "gpt-test" });
      expect((await bad.checkStatus()).status).toBe("auth_error");
    } finally {
      await close();
    }
  });

  it("estimateTokens is a deterministic, documented approximation", () => {
    const provider = createOpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:1", model: "gpt-test" });
    expect(provider.estimateTokens("")).toBe(0);
    expect(provider.estimateTokens("a".repeat(40))).toBe(10);
  });

  it("throws AIProviderError, not a generic error, on malformed responses", async () => {
    const { url, close } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ notData: [] }));
    });
    try {
      const provider = createOpenAICompatibleProvider({ baseUrl: url, model: "gpt-test" });
      await expect(provider.listModels()).rejects.toBeInstanceOf(AIProviderError);
    } finally {
      await close();
    }
  });
});
