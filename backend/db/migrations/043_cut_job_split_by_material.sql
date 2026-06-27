-- 043_cut_job_split_by_material.sql
--
-- Per-job "split by material" toggle. By default a cut job is split by material
-- type — details of different materials are cut in separate groups (on separate
-- sheets), because different materials physically cannot share a sheet. When
-- split_by_material is FALSE the operator deliberately puts ALL the job's details
-- into ONE group (cut together on the per-job override sheet, or the first
-- material's sheet when no override is set).
--
-- INVARIANT: split_by_material = true (default) is the safe behaviour for every
-- existing job — materials never merge. The per-job sheet override
-- (cut_job.sheet_material_type_id) then only fills details that have NO sheet
-- (no_sheet_spec); it no longer collapses different materials onto one sheet.
-- The flag is applied LIVE at calculate time, never written into cut_job.params.
--
-- Additive, reversible. NOT NULL DEFAULT true so existing rows backfill cleanly.

ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS split_by_material BOOLEAN NOT NULL DEFAULT true;

-- ── Down ─────────────────────────────────────────────────────────────────────
--   ALTER TABLE cut_job DROP COLUMN IF EXISTS split_by_material;
