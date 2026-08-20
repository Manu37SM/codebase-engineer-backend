import type { FastifyInstance } from "fastify";

/**
 * Baseline security response headers — this app had none at all: no CSP,
 * no X-Frame-Options/X-Content-Type-Options, no HSTS. Added as a plain
 * `onSend` hook rather than a new dependency (`@fastify/helmet`), matching
 * this project's existing "no extra dependency unless there's no
 * reasonable built-in alternative" convention (see auth/password.ts).
 *
 * The policy is intentionally strict by default because this app has no
 * legitimate reason to be framed by another site, load third-party
 * scripts, or send cross-origin fetches from the browser — its own
 * frontend and API are always same-origin (see docs/DEPLOYMENT.md: no
 * CORS headers are set anywhere in this codebase for the same reason).
 * If an operator later wires in the Cloudflare Turnstile widget
 * end-to-end (currently backend-only plumbing — see auth/turnstile.ts)
 * or the Razorpay Checkout script, `script-src`/`frame-src` below will
 * need extending to those specific origins; this is called out inline.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    reply.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        // Extend with 'https://challenges.cloudflare.com' if Turnstile's
        // widget script is ever loaded client-side, and with
        // 'https://checkout.razorpay.com' if the Razorpay Checkout
        // script is added to index.html.
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'", // React/Tailwind utility classes don't need this, but some component libraries set inline style attributes — inline style ATTRIBUTES aren't blocked by CSP either way; this only covers <style> tags, kept for safety.
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
      ].join("; ")
    );

    // HSTS only makes sense — and is only safe to send — once traffic is
    // actually reaching this app over HTTPS. Sending it unconditionally
    // would tell a browser to force HTTPS for this host even in the
    // default local-http self-hosting case, breaking access. Mirrors the
    // same protocol-aware pattern the session cookie's `secure` flag
    // already uses (auth/session.ts) — including working correctly
    // behind a reverse proxy with `TRUST_PROXY=1` set, since
    // `request.protocol` then reflects `X-Forwarded-Proto`.
    if (request.protocol === "https") {
      reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }
  });
}
