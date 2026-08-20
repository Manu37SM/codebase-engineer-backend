import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import {
  countUsers,
  createSession,
  createUser,
  deleteSessionByToken,
  getSessionByToken,
  getUserByEmail,
  getUserById,
} from "../db/userRepo.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { verifyTurnstile } from "../auth/turnstile.js";
import { SESSION_COOKIE_NAME } from "../auth/guard.js";
import { setSessionCookie } from "../auth/session.js";

interface RegisterAuthRoutesOptions {
  db: DB;
}

/**
 * Local account auth: register/login/logout/me (Task #80), with Turnstile
 * verification wired in (Task #81 — see `auth/turnstile.ts` for its
 * opt-in behavior). Google/GitHub OAuth (Tasks #82/#83) register their own
 * `/api/v1/auth/google/*` and `/api/v1/auth/github/*` routes separately —
 * kept in their own files since each provider's flow is independent and
 * neither depends on this one.
 *
 * These routes are always reachable — they must be, since a route
 * requiring auth to reach the routes that grant auth would be a deadlock.
 * `authGuard` (auth/guard.ts) is applied to every OTHER route, not these.
 */
export function registerAuthRoutes(app: FastifyInstance, { db }: RegisterAuthRoutesOptions): void {
  app.post("/api/v1/auth/register", async (request, reply) => {
    const body = request.body as
      | { email?: string; password?: string; displayName?: string; turnstileToken?: string }
      | undefined;
    const email = body?.email?.trim();
    const password = body?.password;

    if (!email || !email.includes("@")) {
      return reply.status(400).send({ error: "A valid email address is required." });
    }
    if (!password || password.length < 8) {
      return reply.status(400).send({ error: "Password must be at least 8 characters." });
    }

    const turnstile = await verifyTurnstile(body?.turnstileToken, request.ip);
    if (!turnstile.success) {
      return reply.status(400).send({ error: `Bot verification failed: ${turnstile.reason ?? "unknown reason"}` });
    }

    if (getUserByEmail(db, email)) {
      return reply.status(409).send({ error: "An account with this email already exists." });
    }

    const user = createUser(db, randomUUID(), {
      email,
      displayName: body?.displayName?.trim() || null,
      passwordHash: hashPassword(password),
    });

    const token = createSession(db, randomUUID(), user.id);
    setSessionCookie(request, reply, token);

    return reply.status(201).send({ user: publicUser(user) });
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string; turnstileToken?: string } | undefined;
    const email = body?.email?.trim();
    const password = body?.password;

    if (!email || !password) {
      return reply.status(400).send({ error: "Email and password are required." });
    }

    const turnstile = await verifyTurnstile(body?.turnstileToken, request.ip);
    if (!turnstile.success) {
      return reply.status(400).send({ error: `Bot verification failed: ${turnstile.reason ?? "unknown reason"}` });
    }

    const user = getUserByEmail(db, email);
    // Deliberately identical error message whether the email doesn't
    // exist or the password is wrong — distinguishing them lets an
    // attacker enumerate registered emails.
    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      return reply.status(401).send({ error: "Invalid email or password." });
    }

    const token = createSession(db, randomUUID(), user.id);
    setSessionCookie(request, reply, token);

    return reply.status(200).send({ user: publicUser(user) });
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (token) deleteSessionByToken(db, token);
    reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
    return reply.status(200).send({ ok: true });
  });

  /**
   * Reports the current session's user, AND whether the instance has any
   * accounts at all — the frontend uses `authRequired: false` to decide
   * whether to show a login wall at all (open/legacy mode, zero users) vs
   * `authRequired: true, user: null` (a real login screen is needed).
   */
  app.get("/api/v1/auth/me", async (request, reply) => {
    const authRequired = countUsers(db) > 0;
    const token = request.cookies?.[SESSION_COOKIE_NAME];
    if (!token) {
      return reply.status(200).send({ authRequired, user: null });
    }
    const session = getSessionByToken(db, token);
    if (!session) {
      return reply.status(200).send({ authRequired, user: null });
    }
    const user = getUserById(db, session.user_id);
    return reply.status(200).send({ authRequired, user: user ? publicUser(user) : null });
  });
}

/** Never returns `password_hash` to the client. */
function publicUser(user: { id: string; email: string; display_name: string | null; created_at: string }) {
  return { id: user.id, email: user.email, displayName: user.display_name, createdAt: user.created_at };
}
