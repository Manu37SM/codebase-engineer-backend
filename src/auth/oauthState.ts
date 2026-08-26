import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

const STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60; 

export function stateCookieName(provider: "google" | "github"): string {
  return `ce_oauth_state_${provider}`;
}

export function beginOAuthState(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: "google" | "github"
): string {
  const state = randomBytes(24).toString("hex");
  reply.setCookie(stateCookieName(provider), state, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",

    secure: request.protocol === "https",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
  return state;
}

export function verifyAndClearOAuthState(
  request: FastifyRequest,
  reply: FastifyReply,
  provider: "google" | "github",
  providedState: string | undefined
): boolean {
  const cookieName = stateCookieName(provider);
  const expected = request.cookies?.[cookieName];
  reply.clearCookie(cookieName, { path: "/" });
  return Boolean(expected) && Boolean(providedState) && expected === providedState;
}
