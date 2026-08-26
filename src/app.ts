import os from "node:os";
import Fastify, { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import type { DB } from "./db/index.js";
import { registerProjectsRoutes } from "./routes/projects.js";
import { registerAiProviderRoutes } from "./routes/aiProviders.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerGoogleOAuthRoutes } from "./routes/oauthGoogle.js";
import { registerGitHubOAuthRoutes } from "./routes/oauthGithub.js";
import { registerGitHubRepoRoutes } from "./routes/githubRepos.js";
import { registerGoogleDriveRoutes } from "./routes/googleDrive.js";
import { authGuard } from "./auth/guard.js";
import { registerSecurityHeaders } from "./security/headers.js";

export interface BuildAppOptions {
  db: DB;

  staticDir?: string | null;

  trustProxy?: boolean;

  dataDir?: string;
}

export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  app.register(fastifyCookie);

  registerSecurityHeaders(app);

  app.addHook("preHandler", authGuard(opts.db));

  registerAuthRoutes(app, { db: opts.db });
  registerGoogleOAuthRoutes(app, { db: opts.db });
  registerGitHubOAuthRoutes(app, { db: opts.db });

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

  registerProjectsRoutes(app, { db: opts.db, dataDir: opts.dataDir ?? os.tmpdir() });
  registerGitHubRepoRoutes(app, { db: opts.db, dataDir: opts.dataDir ?? os.tmpdir() });
  registerGoogleDriveRoutes(app, { db: opts.db, dataDir: opts.dataDir ?? os.tmpdir() });
  registerAiProviderRoutes(app, { db: opts.db });
  registerBillingRoutes(app, { db: opts.db });

  if (opts.staticDir) {

    app.register(fastifyStatic, { root: opts.staticDir });

    app.setNotFoundHandler((request, reply) => {
      const url = request.raw.url ?? "";
      const isApiRequest = url.startsWith("/api/");
      const isPageLoad = request.method === "GET" || request.method === "HEAD";
      if (isApiRequest || !isPageLoad) {
        reply.code(404).send({ error: "Not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  return app;
}
