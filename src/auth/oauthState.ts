import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * CSRF protection for the OAuth authorization-code flow (Task #82/#83):
 * a random `state` value is generated on `/start`, stashed in a short-lived
 * httpOnly cookie, and echoed back by the provider on `/callback` as a
 * query param — the callback handler rejects the request unless the two
 * match, closing the standard "attacker tricks a victim into completing
 * *their* OAuth flow, silently linking the attacker's provider account to
 * the victim's session" CSRF hole. One cookie name per provider so a user
 * can't have a Google flow in progress clobber a simultaneous GitHub one.
 */

const STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes — plenty for a real login, short enough to limit replay.

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
    // Derived from the request's actual protocol, same reasoning as the
    // session cookie in routes/auth.ts's setSessionCookie — off for plain
    // http (default/local dev), on automatically once TRUST_PROXY + a
    // TLS-terminating reverse proxy are in place.
    secure: request.protocol === "https",
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
  return state;
}

/** Verifies the callback's `state` query param against the cookie set by `beginOAuthState`, then clears the cookie either way (single use). */
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
