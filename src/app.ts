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
  /**
   * Phase 24 packaging: when set to a real directory containing a built
   * frontend (`index.html` + assets), the backend also serves it — a
   * single process on a single port instead of a separate frontend dev
   * server. `undefined`/`null` (the default, and what every pre-Phase-24
   * test still passes) leaves the app exactly as API-only as it's always
   * been; this is purely additive.
   */
  staticDir?: string | null;
  /**
   * Passed straight through to Fastify's own `trustProxy` option — see
   * `AppConfig.trustProxy` in config.ts for the full rationale. Defaults to
   * `false`, same as Fastify's own default: a bare, directly-reached
   * process should never trust `X-Forwarded-*` headers a client could send
   * itself. Every existing test that doesn't pass this continues to run
   * exactly as before (trustProxy off), so this is purely additive.
   */
  trustProxy?: boolean;
  /**
   * Where imported (git-URL/zip-URL) project clones are stored (Task #85)
   * — a subdirectory of this is used per import. Defaults to the OS temp
   * directory when not provided, which is fine for tests but not for a
   * real deployment (server.ts always passes the real configured data
   * dir, so imported clones survive a restart the same as everything
   * else in `CODEBASE_ENGINEER_DATA_DIR`).
   */
  dataDir?: string;
}

/**
 * Builds (but does not start) the Fastify app. Kept separate from server.ts
 * so tests can build an app instance against an in-memory/temp database
 * without binding a port.
 */
export function buildApp(opts: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: opts.trustProxy ?? false });
  app.register(fastifyCookie);

  // Baseline security headers (CSP, X-Frame-Options, HSTS, etc.) on every
  // response, including error responses — see security/headers.ts for the
  // full rationale. Registered before auth/routes so it's never skipped.
  registerSecurityHeaders(app);

  // Single choke point for auth (Task #91) — see `authGuard`'s own doc
  // comment for exactly which paths it leaves alone and why. Registered
  // before any route so it runs on every request; `isPublicPath` inside
  // it is what keeps this from being a deadlock or from blocking static
  // asset delivery.
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
    // @fastify/static handles path-traversal safety internally for every
    // request under `root` — the same principle docs/SECURITY.md §2
    // requires of this product's own project-file access, just enforced
    // by a well-audited upstream plugin rather than reimplemented here.
    app.register(fastifyStatic, { root: opts.staticDir });

    // SPA fallback: a client-side route like `/findings` has no matching
    // static file or API route, so without this it would 404 on a direct
    // load/refresh. Only applies to GET/HEAD requests for paths that
    // aren't `/api/*` — an unmatched API route must still 404 as JSON
    // (never silently served the frontend's index.html, which would turn
    // a real "route doesn't exist" bug into a confusing blank page
    // instead of a clear error), and a non-GET request to an unknown path
    // has no business getting HTML back either.
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
