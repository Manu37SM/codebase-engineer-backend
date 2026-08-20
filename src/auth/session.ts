import type { FastifyReply, FastifyRequest } from "fastify";
import { SESSION_COOKIE_NAME } from "./guard.js";

/**
 * Shared by every login path (local email/password in routes/auth.ts, plus
 * Google/GitHub OAuth in routes/oauthGoogle.ts and routes/oauthGithub.ts —
 * Task #82/#83) so the session cookie is set identically regardless of how
 * the user authenticated. Moved out of routes/auth.ts into its own module
 * once OAuth needed to call it too, rather than duplicating the cookie
 * options in three places.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days, matches userRepo.ts's SESSION_TTL_MS.

export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    // `secure` follows the REQUEST's actual protocol rather than being
    // hardcoded either way, so this works correctly in both of this app's
    // documented deployment shapes (docs/DEPLOYMENT.md) without any config
    // beyond what that doc already asks for:
    //  - Local dev / default self-hosting over plain http://localhost or a
    //    LAN IP: `request.protocol` is "http", so `secure` is off — the
    //    cookie still gets set and login still works. Forcing `secure: true`
    //    unconditionally would silently break login for this default,
    //    documented case.
    //  - "Going live" behind a real reverse proxy that terminates TLS
    //    (docs/DEPLOYMENT.md's "Going live behind a reverse proxy"
    //    section): with `TRUST_PROXY=1` set, Fastify's `trustProxy` option
    //    makes `request.protocol` reflect the proxy's `X-Forwarded-Proto:
    //    https` header even though this Node process itself only ever
    //    speaks plain HTTP — so the cookie correctly becomes `secure` in
    //    that case, without this app needing to terminate TLS itself.
    // Either way, httpOnly + sameSite=lax already apply regardless of
    // `secure` — this is defense-in-depth on top of those, not a
    // substitute for them.
    secure: request.protocol === "https",
    maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
  });
}
