-- 112_cut_job_rotation_allowed.sql
--
-- Per-job "rotation allowed" toggle. Default TRUE preserves current behaviour:
-- calculate may rotate details when the active profile/grain rules allow it.
-- When FALSE, calculate sends rotation='forbid' for every detail in this job.
--
-- Additive, reversible. NOT NULL DEFAULT true backfills existing jobs safely.

ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS rotation_allowed BOOLEAN NOT NULL DEFAULT true;

-- ── Down ─────────────────────────────────────────────────────────────────────
--   ALTER TABLE cut_job DROP COLUMN IF EXISTS rotation_allowed;
