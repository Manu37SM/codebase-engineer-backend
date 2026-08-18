import Fastify, { FastifyInstance } from "fastify";
import type { DB } from "./db/index.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerAiProviderRoutes } from "./routes/aiProviders.js";

export interface BuildAppOptions {
  db: DB;
}

/**
 * Builds (but does not start) the Fastify app. Kept separate from server.ts
 * so tests can build an app instance against an in-memory/temp database
 * without binding a port.
 */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/api/v1/health", async () => {
    const migrationCount = opts.db
      .prepare("SELECT COUNT(*) as count FROM schema_migrations")
      .get() as { count: number };

    return {
      status: "ok",
      service: "codebase-engineer-backend",
      migrationsApplied: migrationCount.count,
      timestamp: new Date().toISOString(),
    };
  });

  registerProjectsRoutes(app, { db: opts.db });
  registerAiProviderRoutes(app, { db: opts.db });

  return app;
}
