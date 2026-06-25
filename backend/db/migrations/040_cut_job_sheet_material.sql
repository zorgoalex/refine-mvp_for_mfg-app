-- 040_cut_job_sheet_material.sql
--
-- Per-job sheet-variant selection. A cut job normally resolves each detail's
-- sheet from order_details.sheet_material_type_id (Variant B). This adds a
-- nullable per-job override: when set, calculate cuts EVERY detail of the job on
-- the chosen sheet (overriding the detail's own spec and covering no_sheet_spec
-- details too).
--
-- INVARIANT: sheet_material_type_id = NULL means "use each detail's own sheet"
-- (current behavior, backward-compatible for all legacy jobs). A chosen
-- (non-NULL) sheet is applied LIVE at calculate time; calculate NEVER writes it
-- into cut_job.params (the params single-NULL invariant is untouched).
--
-- ON DELETE SET NULL: deactivating/removing a sheet type must never orphan a
-- job; NULL falls back to per-detail resolution (stale-safe). Additive, reversible.

ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS sheet_material_type_id BIGINT;

ALTER TABLE cut_job
  ADD CONSTRAINT fk_cut_job_sheet_material_type
    FOREIGN KEY (sheet_material_type_id)
    REFERENCES sheet_material_types(sheet_material_type_id)
    ON UPDATE CASCADE ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cut_job_sheet_material_type_id
  ON cut_job(sheet_material_type_id);

-- ── Down ─────────────────────────────────────────────────────────────────────
--   ALTER TABLE cut_job DROP CONSTRAINT IF EXISTS fk_cut_job_sheet_material_type;
--   DROP INDEX IF EXISTS idx_cut_job_sheet_material_type_id;
--   ALTER TABLE cut_job DROP COLUMN IF EXISTS sheet_material_type_id;
