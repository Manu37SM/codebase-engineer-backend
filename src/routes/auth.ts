import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { DB } from "../db/index.js";
import {
  countUsers,
  createSession,
  createUser,
  deleteSessionByToken,
  getOauthIdentityForUser,
  getSessionByToken,
  getUserByEmail,
  getUserById,
} from "../db/userRepo.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { verifyTurnstile } from "../auth/turnstile.js";
import { SESSION_COOKIE_NAME } from "../auth/guard.js";
import { setSessionCookie } from "../auth/session.js";
import { getGitHubOAuthConfig, getGoogleOAuthConfig } from "../auth/oauthConfig.js";
import { checkRateLimit, resetRateLimit } from "../auth/rateLimit.js";

const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const REGISTER_MAX_ATTEMPTS = 10;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

interface RegisterAuthRoutesOptions {
  db: DB;
}

export function registerAuthRoutes(app: FastifyInstance, { db }: RegisterAuthRoutesOptions): void {
  app.post("/api/v1/auth/register", async (request, reply) => {
    const registerLimit = checkRateLimit(`register:${request.ip}`, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MS);
    if (!registerLimit.allowed) {
      reply.header("Retry-After", String(registerLimit.retryAfterSeconds));
      return reply.status(429).send({ error: "Too many registration attempts. Please try again later." });
    }

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
    const loginKey = `login:${request.ip}`;
    const loginLimit = checkRateLimit(loginKey, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS);
    if (!loginLimit.allowed) {
      reply.header("Retry-After", String(loginLimit.retryAfterSeconds));
      return reply.status(429).send({ error: "Too many login attempts. Please try again later." });
    }

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

    if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
      return reply.status(401).send({ error: "Invalid email or password." });
    }

    resetRateLimit(loginKey);

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
    if (!user) {
      return reply.status(200).send({ authRequired, user: null });
    }

    const githubConnected = Boolean(getOauthIdentityForUser(db, user.id, "github")?.access_token_enc);

    const driveConnected = Boolean(getOauthIdentityForUser(db, user.id, "google")?.access_token_enc);
    return reply.status(200).send({ authRequired, user: { ...publicUser(user), githubConnected, driveConnected } });
  });

  app.get("/api/v1/auth/providers", async () => {
    return {
      google: getGoogleOAuthConfig() !== null,
      github: getGitHubOAuthConfig() !== null,
      turnstile: Boolean(process.env.TURNSTILE_SECRET_KEY?.trim()),
    };
  });
}

function publicUser(user: { id: string; email: string; display_name: string | null; created_at: string }) {
  return { id: user.id, email: user.email, displayName: user.display_name, createdAt: user.created_at };
}
