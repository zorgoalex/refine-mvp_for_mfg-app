-- 032_cut_job_failure_reason.sql
--
-- A failed cut calculation currently leaves cut_job.status = 'failed' with NO
-- human-readable explanation persisted: the only trace is an audit_log
-- (cut_job.calculate_failed) metadata row. The operator sees a bare red
-- "Ошибка" tag and cannot tell WHY the layout could not be computed.
--
-- This adds two nullable columns so the failure is durable and query-friendly:
--   failure_code   — stable machine code (e.g. FREECUT_CONSTRAINT_ERROR), for
--                    filtering/analytics and a single source of truth for the
--                    UI message mapping.
--   failure_reason — the human-readable Russian sentence shown to the operator.
--
-- Both are cleared at the start of every (re)calculation and set together when a
-- calculation fails. They are purely informational; no constraint, no view
-- change, no impact on existing reads when left NULL.
--
-- Reversible: see the down section.

ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS failure_code TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- ── Down ─────────────────────────────────────────────────────────────────────
--   ALTER TABLE cut_job
--     DROP COLUMN IF EXISTS failure_reason,
--     DROP COLUMN IF EXISTS failure_code;
