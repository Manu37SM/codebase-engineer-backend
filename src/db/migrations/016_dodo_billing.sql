

ALTER TABLE subscription RENAME COLUMN razorpay_order_id TO dodo_subscription_id;
ALTER TABLE subscription RENAME COLUMN razorpay_payment_id TO dodo_payment_id;
ALTER TABLE billing_webhook_event RENAME COLUMN razorpay_event_id TO dodo_event_id;
