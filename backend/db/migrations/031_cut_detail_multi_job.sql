-- 031_cut_detail_multi_job.sql
--
-- A детали can belong to ANY number of cut jobs. Placement in a cut job is purely
-- informational and never exclusive: the same order detail may be added to many
-- jobs at once (re-cut, parallel jobs, etc.). This drops the partial UNIQUE
-- reservation guard introduced in 022 (uq_cut_job_item_active_detail) and replaces
-- it with a NON-unique lookup index on active items, so "which jobs is this detail
-- in" stays fast without enforcing exclusivity.
--
-- Reversible: see the down section.

DROP INDEX IF EXISTS uq_cut_job_item_active_detail;

CREATE INDEX IF NOT EXISTS idx_cut_job_item_active_order_detail
  ON cut_job_item (order_detail_id)
  WHERE is_active = true;

-- ── Down ─────────────────────────────────────────────────────────────────────
-- Reverting re-introduces exclusivity. It can FAIL if, by then, the same detail
-- is active in more than one job (the new model allows that). De-duplicate first
-- if a rollback is ever required.
--   DROP INDEX IF EXISTS idx_cut_job_item_active_order_detail;
--   CREATE UNIQUE INDEX uq_cut_job_item_active_detail
--     ON cut_job_item (order_detail_id) WHERE is_active = true;
