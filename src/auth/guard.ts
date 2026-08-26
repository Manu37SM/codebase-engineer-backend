import type { FastifyReply, FastifyRequest } from "fastify";
import type { DB } from "../db/index.js";
import { countUsers, getSessionByToken, getUserById, type UserRecord } from "../db/userRepo.js";

export const SESSION_COOKIE_NAME = "ce_session";

declare module "fastify" {
  interface FastifyRequest {

    user?: UserRecord;
  }
}

const PUBLIC_PATH_PREFIXES = ["/api/v1/auth/", "/api/v1/health"];

function isPublicPath(url: string): boolean {
  if (!url.startsWith("/api/v1/")) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function resolveCurrentUserId(request: FastifyRequest, db: DB): string | undefined {
  const token = request.cookies?.[SESSION_COOKIE_NAME];
  if (!token) return undefined;
  const session = getSessionByToken(db, token);
  if (!session) return undefined;
  const user = getUserById(db, session.user_id);
  return user?.id;
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

      reply.status(401).send({ error: "Authentication required." });
      return;
    }

    request.user = user;
    done();
  };
}
