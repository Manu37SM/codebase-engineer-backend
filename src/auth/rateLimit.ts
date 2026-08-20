/**
 * A minimal in-memory rate limiter for the auth endpoints (login,
 * register) — this project has no rate limiting on either today, which
 * leaves local-account login open to unlimited password-guessing and
 * registration open to unlimited account creation. Deliberately NOT a
 * new dependency (no `@fastify/rate-limit`, no Redis): this app is
 * self-hosted and runs as a single process per the user's explicit
 * local-first architecture, so an in-memory fixed-window counter is
 * enough — it resets on restart, which is an acceptable tradeoff for a
 * single-instance deployment (matches this project's existing
 * "no extra dependency unless there's no reasonable built-in
 * alternative" convention, see auth/password.ts's own note).
 *
 * Fixed window rather than sliding/token-bucket: simpler, and "at most
 * N attempts, then a hard wait until the window rolls over" is a
 * perfectly reasonable brute-force deterrent for this use case — it
 * doesn't need to be precise, just costly enough to make guessing
 * impractical.
 */

interface WindowState {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, WindowState>();

// Periodically drop stale buckets so this Map can't grow unbounded over
// a long-running process's lifetime — only entries whose window has
// already fully elapsed are removed, so this never affects an
// in-progress rate-limit decision.
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweepMs = 0;

function sweep(nowMs: number, windowMs: number): void {
  if (nowMs - lastSweepMs < SWEEP_INTERVAL_MS) return;
  lastSweepMs = nowMs;
  for (const [key, state] of buckets) {
    if (nowMs - state.windowStartMs > windowMs) buckets.delete(key);
  }
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the caller may retry — only set when `allowed` is false. */
  retryAfterSeconds?: number;
}

/**
 * Checks and (on the allowed path) increments a fixed-window counter for
 * `key` (typically `${routeName}:${ip}`). Callers decide the key shape —
 * e.g. login is keyed by IP alone (not IP+email) so an attacker can't
 * dodge the limit by cycling through candidate emails from one IP.
 */
export function checkRateLimit(key: string, maxAttempts: number, windowMs: number): RateLimitResult {
  const nowMs = Date.now();
  sweep(nowMs, windowMs);

  const existing = buckets.get(key);
  if (!existing || nowMs - existing.windowStartMs > windowMs) {
    buckets.set(key, { count: 1, windowStartMs: nowMs });
    return { allowed: true };
  }

  if (existing.count >= maxAttempts) {
    const retryAfterSeconds = Math.ceil((existing.windowStartMs + windowMs - nowMs) / 1000);
    return { allowed: false, retryAfterSeconds: Math.max(retryAfterSeconds, 1) };
  }

  existing.count += 1;
  return { allowed: true };
}

/** Clears a key's counter early — used to reset the login limiter on a successful login so a legitimate user who mistyped a few times isn't then throttled. */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

/** Test-only: clears every bucket so tests don't leak state into each other via the module-level Map. */
export function __resetAllRateLimitsForTests(): void {
  buckets.clear();
  lastSweepMs = 0;
}
