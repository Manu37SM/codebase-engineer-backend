import { describe, it, expect, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { openDatabase, DB } from "../src/db/index.js";
import { buildApp } from "../src/app.js";

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe("AI providers API", () => {
  let tmpDbDir: string;
  let db: DB;
  let app: FastifyInstance;

  beforeEach(() => {
    tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-ai-api-test-"));
    db = openDatabase(path.join(tmpDbDir, "test.db"));
    app = buildApp({ db });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    fs.rmSync(tmpDbDir, { recursive: true, force: true });
  });

  it("rejects creating a provider with an unsupported kind", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Claude", kind: "anthropic-compatible" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not yet supported/);
  });

  it("rejects creating a provider without a name or kind", async () => {
    const res = await app.inject({ method: "POST", url: "/api/v1/ai/providers", payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it("creates, lists, and never returns the raw API key", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: {
        name: "My OpenAI",
        kind: "openai-compatible",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        apiKey: "sk-verysecretvalue",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json().provider;
    expect(created.hasApiKey).toBe(true);
    expect(created.apiKeyRef).toBe("sk-v...ue");
    expect(createRes.body).not.toContain("verysecret");

    const listRes = await app.inject({ method: "GET", url: "/api/v1/ai/providers" });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().providers).toHaveLength(1);
    expect(listRes.body).not.toContain("verysecret");
  });

  it("updates a provider (enable it, change the model) via PATCH", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Local", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3" },
    });
    const { id } = createRes.json().provider;

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/ai/providers/${id}`,
      payload: { enabled: true, model: "llama3.1" },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().provider.enabled).toBe(true);
    expect(patchRes.json().provider.model).toBe("llama3.1");
  });

  it("returns 404 patching an unknown provider", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/v1/ai/providers/00000000-0000-0000-0000-000000000000",
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a provider", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Local", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3" },
    });
    const { id } = createRes.json().provider;

    const deleteRes = await app.inject({ method: "DELETE", url: `/api/v1/ai/providers/${id}` });
    expect(deleteRes.statusCode).toBe(204);

    const listRes = await app.inject({ method: "GET", url: "/api/v1/ai/providers" });
    expect(listRes.json().providers).toHaveLength(0);
  });

  it("returns 404 deleting an unknown provider", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/v1/ai/providers/00000000-0000-0000-0000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });

  it("checks status against a real local server and reports reachable", async () => {
    const { url, close } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
    });
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/ai/providers",
        payload: { name: "Test", kind: "openai-compatible", baseUrl: url, model: "gpt-test" },
      });
      const { id } = createRes.json().provider;

      const statusRes = await app.inject({ method: "POST", url: `/api/v1/ai/providers/${id}/check-status` });
      expect(statusRes.statusCode).toBe(200);
      expect(statusRes.json().status).toBe("reachable");
    } finally {
      await close();
    }
  });

  it("checks status against an unreachable server and reports unreachable, not a 500", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers",
      payload: { name: "Dead", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1", model: "gpt-test" },
    });
    const { id } = createRes.json().provider;

    const statusRes = await app.inject({ method: "POST", url: `/api/v1/ai/providers/${id}/check-status` });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().status).toBe("unreachable");
  });

  it("returns 404 checking status for an unknown provider", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/providers/00000000-0000-0000-0000-000000000000/check-status",
    });
    expect(res.statusCode).toBe(404);
  });

  it("lists real models from the configured server", async () => {
    const { url, close } = await startServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "gpt-test", context_window: 128000 }] }));
    });
    try {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/ai/providers",
        payload: { name: "Test", kind: "openai-compatible", baseUrl: url, model: "gpt-test" },
      });
      const { id } = createRes.json().provider;

      const modelsRes = await app.inject({ method: "GET", url: `/api/v1/ai/providers/${id}/models` });
      expect(modelsRes.statusCode).toBe(200);
      expect(modelsRes.json().models).toEqual([{ id: "gpt-test", contextWindow: 128000 }]);
    } finally {
      await close();
    }
  });

  it("returns 404 listing models for an unknown provider", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/ai/providers/00000000-0000-0000-0000-000000000000/models",
    });
    expect(res.statusCode).toBe(404);
  });
});
