import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase, DB } from "../src/db/index.js";
import { createProject } from "../src/db/projectRepo.js";
import { replaceProjectFindings } from "../src/db/findingRepo.js";
import { checkAiOperationAllowed, getMonthlyAiOperationCount } from "../src/billing/usageLimiter.js";
import { activateSubscription } from "../src/billing/subscriptionRepo.js";

const RAZORPAY_ENV_KEYS = ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET"] as const;

function setBillingConfigured() {
  process.env.RAZORPAY_KEY_ID = "rzp_test_key";
  process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";
  process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
}

describe("usageLimiter", () => {
  let tmpDir: string;
  let db: DB;
  let projectId: string;
  let findingId: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(RAZORPAY_ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of RAZORPAY_ENV_KEYS) delete process.env[k];

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ce-usage-limiter-test-"));
    db = openDatabase(path.join(tmpDir, "test.db"));
    projectId = randomUUID();
    createProject(db, projectId, "test-project", tmpDir);

    findingId = randomUUID();
    replaceProjectFindings(
      db,
      projectId,
      [
        {
          ruleId: "large-file",
          severity: "medium",
          category: "maintainability",
          filePath: "src/big.ts",
          lineStart: null,
          lineEnd: null,
          evidence: "test",
          explanation: "test",
          recommendation: "test",
        },
      ],
      () => findingId
    );
  });

  afterEach(() => {
    for (const k of RAZORPAY_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertAiRequest(createdAt: string) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO ai_request (id, project_id, finding_id, provider, model, operation_type, status, created_at)
       VALUES (?, ?, ?, 'test-provider', 'test-model', 'explain', 'succeeded', ?)`
    ).run(id, projectId, findingId, createdAt);
  }

  it("always allows when billing is not configured (no RAZORPAY_* env vars set)", () => {
    for (let i = 0; i < 100; i++) insertAiRequest(new Date().toISOString());
    const result = checkAiOperationAllowed(db);
    expect(result.allowed).toBe(true);
    expect(result.limit).toBeNull();
  });

  it("counts only ai_request rows from the current calendar month", () => {
    const now = new Date();
    const thisMonth = now.toISOString();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString();

    insertAiRequest(thisMonth);
    insertAiRequest(thisMonth);
    insertAiRequest(lastMonth);

    const count = getMonthlyAiOperationCount(db, now.toISOString());
    expect(count).toBe(2);
  });

  it("blocks once the free tier's monthly limit is reached, with billing configured", () => {
    setBillingConfigured();
    const now = new Date().toISOString();
    for (let i = 0; i < 50; i++) insertAiRequest(now);

    const result = checkAiOperationAllowed(db);
    expect(result.allowed).toBe(false);
    expect(result.tier).toBe("free");
    expect(result.used).toBe(50);
    expect(result.limit).toBe(50);
    expect(result.reason).toContain("limit reached");
  });

  it("allows requests under the free tier's monthly limit", () => {
    setBillingConfigured();
    const now = new Date().toISOString();
    for (let i = 0; i < 49; i++) insertAiRequest(now);

    const result = checkAiOperationAllowed(db);
    expect(result.allowed).toBe(true);
    expect(result.used).toBe(49);
    expect(result.limit).toBe(50);
  });

  it("is unlimited on the pro tier even well past the free tier's cap", () => {
    setBillingConfigured();
    const now = new Date().toISOString();
    activateSubscription(db, {
      tier: "pro",
      razorpayOrderId: "order_x",
      razorpayPaymentId: "pay_x",
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    for (let i = 0; i < 200; i++) insertAiRequest(now);

    const result = checkAiOperationAllowed(db);
    expect(result.allowed).toBe(true);
    expect(result.tier).toBe("pro");
    expect(result.limit).toBeNull();
  });

  it("downgrades an expired pro subscription back to free's limit automatically", () => {
    setBillingConfigured();
    const now = new Date().toISOString();
    activateSubscription(db, {
      tier: "pro",
      razorpayOrderId: "order_x",
      razorpayPaymentId: "pay_x",
      currentPeriodEnd: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), // already expired
    });
    for (let i = 0; i < 50; i++) insertAiRequest(now);

    const result = checkAiOperationAllowed(db);
    expect(result.tier).toBe("free");
    expect(result.allowed).toBe(false); // expired back to free, and 50 >= free's limit of 50
  });
});
