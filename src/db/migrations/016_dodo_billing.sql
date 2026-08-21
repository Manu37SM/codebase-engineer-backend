-- Migration 016: switch billing provider columns from Razorpay to Dodo
-- Payments.
--
-- Razorpay's merchant onboarding rejected this product's live account
-- application because self-hosted software is auto-classified under
-- their restricted "hosting" business category — a policy block, not
-- something fixable by re-describing the business (confirmed by a
-- second identical rejection after resubmission). Dodo Payments is a
-- merchant-of-record platform aimed at AI/SaaS products with no
-- equivalent exclusion, so billing was re-pointed at it.
--
-- Plain renames rather than adding parallel unused columns: the Razorpay
-- integration never had a live account/credentials in this project, so
-- no real transaction data exists in these columns to preserve under
-- their old names.
ALTER TABLE subscription RENAME COLUMN razorpay_order_id TO dodo_subscription_id;
ALTER TABLE subscription RENAME COLUMN razorpay_payment_id TO dodo_payment_id;
ALTER TABLE billing_webhook_event RENAME COLUMN razorpay_event_id TO dodo_event_id;
