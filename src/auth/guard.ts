import type { FastifyReply, FastifyRequest } from "fastify";
import type { DB } from "../db/index.js";
import { countUsers, getSessionByToken, getUserById, type UserRecord } from "../db/userRepo.js";

export const SESSION_COOKIE_NAME = "ce_session";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `authGuard` when a request is authenticated; undefined in open (no-users-yet) mode or on an anonymous request to a route that doesn't require auth. */
    user?: UserRecord;
  }
}

/**
 * The single choke point deciding whether a request may proceed
 * (Task #91's route wiring; the guard function itself lives here as part
 * of the auth foundation, Task #80).
 *
 * Self-hosted/local-first design (per the user's explicit instruction):
 * with zero registered accounts, the instance is in "open" mode and this
 * guard is a no-op — every route works exactly as it always has, so
 * nothing breaks for anyone who never sets up an account. The moment a
 * first account is registered, the instance switches to requiring a valid
 * session for every route this guard is attached to. There is
 * deliberately no way to "turn auth off" again once a user exists short
 * of deleting every row from the `user` table — the same one-directional,
 * no-silent-downgrade shape as this project's other opt-in gates
 * (billing's `checkAiOperationAllowed`).
 */
// Routes that must stay reachable regardless of auth state: the auth
// routes themselves (register/login/OAuth — guarding these would be a
// deadlock), the health check (used by uptime monitoring/deploy scripts,
// never sensitive), and everything that isn't `/api/v1/*` at all (static
// frontend assets + the SPA fallback — guarding those would mean an
// unauthenticated browser tab can't even load the JS bundle containing
// the login page).
const PUBLIC_PATH_PREFIXES = ["/api/v1/auth/", "/api/v1/health"];

function isPublicPath(url: string): boolean {
  if (!url.startsWith("/api/v1/")) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function authGuard(db: DB) {
  return function guard(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) {
    if (isPublicPath(request.raw.url ?? request.url)) {
      done();
      return;
    }

    if (countUsers(db) === 0) {
      done();
      return;
    }

    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (!token) {
      reply.status(401).send({ error: "Authentication required." });
      return;
    }

    const session = getSessionByToken(db, token);
    if (!session) {
      reply.status(401).send({ error: "Session expired or invalid — please log in again." });
      return;
    }

    const user = getUserById(db, session.user_id);
    if (!user) {
      // Session outlived its user (e.g. manually deleted from the DB) — treat as unauthenticated rather than crashing.
      reply.status(401).send({ error: "Authentication required." });
      return;
    }

    request.user = user;
    done();
  };
}
