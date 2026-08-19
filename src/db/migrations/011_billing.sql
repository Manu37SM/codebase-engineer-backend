-- Migration 011: optional monetization architecture (Phase 26)
--
-- Purely additive — two new tables, nothing existing touched. Per
-- docs/MONETIZATION.md's isolation principle, billing state lives in its
-- own tables here, never folded into `project`, `ai_request`, or any
-- other core table: the usage-accounting tables Phase 12/14 already
-- shipped stay billing-agnostic factual logs; this module only *reads*
-- them (see backend/src/billing/usageLimiter.ts) to enforce a limit, it
-- never needs them restructured.
--
-- This app is local-first and single-instance (docs/PRD.md §7: no multi-
-- tenant/team features), so `subscription` is a single-row table
-- representing this instance's own plan — not one row per project, not
-- one row per end-user. `getOrCreateSubscription()` in subscriptionRepo.ts
-- creates the one default (tier='free') row on first read if it doesn't
-- exist yet, rather than requiring a migration-time seed row (keeps this
-- migration a pure schema change, no data assumptions).
CREATE TABLE IF NOT EXISTS subscription (
  id TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'free',
  status TEXT NOT NULL DEFAULT 'active',
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  current_period_end TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Records every Razorpay webhook event this instance has processed, keyed
-- by Razorpay's own event id — Razorpay (like most payment providers) can
-- and does redeliver the same webhook more than once, so a real handler
-- must be idempotent. Also doubles as a real, inspectable audit trail of
-- what billing events actually happened, rather than only ever showing
-- the current derived state.
CREATE TABLE IF NOT EXISTS billing_webhook_event (
  id TEXT PRIMARY KEY,
  razorpay_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
