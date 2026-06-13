-- 017_audit_log_related_user_dimension.sql
-- Additive only. Adds a normalized related_user_id audit dimension so org-data
-- head-assignment audit rows are query/report-ready by affected user, alongside
-- the existing related_order/client/payment/production_event/deadline columns.
ALTER TABLE audit_log
  ADD COLUMN IF NOT EXISTS related_user_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_audit_log_related_user_created_at
  ON audit_log(related_user_id, created_at DESC);
