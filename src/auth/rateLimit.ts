

interface WindowState {
  count: number;
  windowStartMs: number;
}

const buckets = new Map<string, WindowState>();

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

  retryAfterSeconds?: number;
}

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

export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

export function __resetAllRateLimitsForTests(): void {
  buckets.clear();
  lastSweepMs = 0;
}
