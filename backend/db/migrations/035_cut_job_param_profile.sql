-- 035_cut_job_param_profile.sql
--
-- Per-job cut profile selection. Until now a cut job always used the runtime
-- default param profile (snapshotted into cut_job.params at creation). This adds
-- a nullable reference to the chosen cut_param_profiles row so an operator can
-- pick a profile per job.
--
-- INVARIANT (one meaning everywhere): param_profile_id = NULL means "use the
-- frozen create-time cut_job.params snapshot". A chosen (non-NULL) profile is
-- resolved LIVE at calculate time; calculate NEVER writes back to cut_job.params.
-- So cut_job.params always stays the create-time default snapshot, and NULL is
-- unambiguous whether the job never had a profile or its profile was later
-- deleted (FK ON DELETE SET NULL → NULL → frozen snapshot). This preserves the
-- exact current behavior for legacy/unset jobs (stale-safe).
--
-- ON DELETE SET NULL: deactivating/removing a profile must never orphan a job.
-- NULL is a single business state — "no explicit profile" — and calculate treats
-- it identically whether the job never had a profile (legacy/unset) or its chosen
-- profile was later deleted: it falls back to the job's create-time params
-- snapshot (cut_job.params), which is the runtime default captured at creation.
-- We deliberately do NOT distinguish "deleted profile" from "never set": both are
-- "use the frozen default snapshot", preserving stale-safety for legacy jobs.
-- Additive, reversible.

ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS param_profile_id BIGINT;

ALTER TABLE cut_job
  ADD CONSTRAINT fk_cut_job_param_profile
    FOREIGN KEY (param_profile_id)
    REFERENCES cut_param_profiles(cut_param_profile_id)
    ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cut_job_param_profile_id
  ON cut_job(param_profile_id);

-- ── Down ─────────────────────────────────────────────────────────────────────
--   ALTER TABLE cut_job DROP CONSTRAINT IF EXISTS fk_cut_job_param_profile;
--   DROP INDEX IF EXISTS idx_cut_job_param_profile_id;
--   ALTER TABLE cut_job DROP COLUMN IF EXISTS param_profile_id;
