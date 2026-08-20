import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, resetRateLimit, __resetAllRateLimitsForTests } from "../src/auth/rateLimit.js";

describe("auth/rateLimit (Task: pre-launch checklist — brute-force protection)", () => {
  beforeEach(() => {
    __resetAllRateLimitsForTests();
  });

  it("allows up to the configured max attempts within the window", () => {
    const key = "test:allow";
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key, 5, 60_000).allowed).toBe(true);
    }
  });

  it("blocks the attempt after the max is reached, with a positive retryAfterSeconds", () => {
    const key = "test:block";
    for (let i = 0; i < 3; i++) {
      checkRateLimit(key, 3, 60_000);
    }
    const result = checkRateLimit(key, 3, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks separate keys independently — one caller's usage never affects another's", () => {
    const a = "test:caller-a";
    const b = "test:caller-b";
    for (let i = 0; i < 3; i++) checkRateLimit(a, 3, 60_000);

    expect(checkRateLimit(a, 3, 60_000).allowed).toBe(false);
    expect(checkRateLimit(b, 3, 60_000).allowed).toBe(true);
  });

  it("resetRateLimit clears a key's counter so it starts fresh", () => {
    const key = "test:reset";
    for (let i = 0; i < 3; i++) checkRateLimit(key, 3, 60_000);
    expect(checkRateLimit(key, 3, 60_000).allowed).toBe(false);

    resetRateLimit(key);
    expect(checkRateLimit(key, 3, 60_000).allowed).toBe(true);
  });

  it("a fresh window (simulated by a tiny windowMs and a real wait) allows attempts again", async () => {
    const key = "test:window-rolls-over";
    checkRateLimit(key, 1, 50); // windowMs = 50ms, real wall-clock wait below
    expect(checkRateLimit(key, 1, 50).allowed).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(checkRateLimit(key, 1, 50).allowed).toBe(true);
  });
});
