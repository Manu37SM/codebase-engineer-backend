import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import {
  createProviderConfig,
  deleteProviderConfig,
  getProviderConfigById,
  listProviderConfigs,
  toPublic,
  updateProviderConfig,
} from "../db/aiProviderRepo.js";
import { createProvider, SUPPORTED_PROVIDER_KINDS } from "../ai/provider/registry.js";

interface RegisterAiProviderRoutesOptions {
  db: DB;
}

export function registerAiProviderRoutes(app: FastifyInstance, { db }: RegisterAiProviderRoutesOptions) {
  app.post("/api/v1/ai/providers", async (request, reply) => {
    const body = request.body as
      | { name?: string; kind?: string; baseUrl?: string; model?: string; apiKey?: string }
      | undefined;

    if (!body?.name || !body?.kind) {
      return reply.status(400).send({ error: "name and kind are required" });
    }
    if (!SUPPORTED_PROVIDER_KINDS.includes(body.kind as (typeof SUPPORTED_PROVIDER_KINDS)[number])) {
      return reply.status(400).send({
        error: `Provider kind "${body.kind}" is not yet supported — only ${SUPPORTED_PROVIDER_KINDS.join(", ")} ${SUPPORTED_PROVIDER_KINDS.length === 1 ? "is" : "are"} implemented.`,
      });
    }

    const record = createProviderConfig(db, randomUUID(), {
      name: body.name,
      kind: body.kind,
      baseUrl: body.baseUrl ?? null,
      model: body.model ?? null,
      apiKey: body.apiKey ?? null,
    });
    return reply.status(201).send({ provider: toPublic(record) });
  });

  app.get("/api/v1/ai/providers", async () => {
    return { providers: listProviderConfigs(db).map(toPublic) };
  });

  app.patch("/api/v1/ai/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as
      | { name?: string; baseUrl?: string | null; model?: string | null; apiKey?: string | null; enabled?: boolean }
      | undefined;

    const updated = updateProviderConfig(db, id, {
      name: body?.name,
      baseUrl: body?.baseUrl,
      model: body?.model,
      apiKey: body?.apiKey,
      enabled: body?.enabled,
    });
    if (!updated) return reply.status(404).send({ error: "Provider not found" });
    return reply.status(200).send({ provider: toPublic(updated) });
  });

  app.delete("/api/v1/ai/providers/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = deleteProviderConfig(db, id);
    if (!deleted) return reply.status(404).send({ error: "Provider not found" });
    return reply.status(204).send();
  });

  app.post("/api/v1/ai/providers/:id/check-status", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = getProviderConfigById(db, id);
    if (!record) return reply.status(404).send({ error: "Provider not found" });

    let provider;
    try {
      provider = createProvider({
        kind: record.kind,
        baseUrl: record.base_url,
        model: record.model,
        apiKey: record.api_key,
      });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    const status = await provider.checkStatus();
    return reply.status(200).send(status);
  });

  app.get("/api/v1/ai/providers/:id/models", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = getProviderConfigById(db, id);
    if (!record) return reply.status(404).send({ error: "Provider not found" });

    let provider;
    try {
      provider = createProvider({
        kind: record.kind,
        baseUrl: record.base_url,
        model: record.model,
        apiKey: record.api_key,
      });
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message });
    }

    try {
      const models = await provider.listModels();
      return reply.status(200).send({ models });
    } catch (err) {
      return reply.status(502).send({ error: (err as Error).message });
    }
  });
}
