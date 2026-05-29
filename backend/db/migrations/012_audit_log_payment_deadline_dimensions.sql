-- 012_audit_log_payment_deadline_dimensions.sql
-- Additive only. Adds normalized audit dimensions so payment and deadline
-- command audit rows are query/report-ready alongside the existing
-- related_order_id / related_client_id / related_production_event_id columns
-- introduced by 004_production_actions_audit_outbox.sql.

ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS related_payment_id BIGINT,
  ADD COLUMN IF NOT EXISTS related_deadline_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_audit_log_related_payment_created_at
  ON audit_log(related_payment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_related_deadline_created_at
  ON audit_log(related_deadline_id, created_at DESC);
