-- 042_cut_job_combine_films.sql
--
-- Per-job "combine different films" toggle. By default calculate groups a job's
-- details by (resolved sheet material, film) — different films of the same
-- material land on separate sheets. When combine_films is TRUE, calculate groups
-- by sheet material ONLY (films of the same material nest on shared sheets),
-- reducing sheet count. Different materials are NEVER combined.
--
-- INVARIANT: combine_films = false (default) preserves the current per-(material,
-- film) fan-out for every legacy job (backward-compatible). The flag is applied
-- LIVE at calculate time; it is never written into cut_job.params.
--
-- Additive, reversible. NOT NULL DEFAULT false so existing rows backfill cleanly.

ALTER TABLE cut_job
  ADD COLUMN IF NOT EXISTS combine_films BOOLEAN NOT NULL DEFAULT false;

-- ── Down ─────────────────────────────────────────────────────────────────────
--   ALTER TABLE cut_job DROP COLUMN IF EXISTS combine_films;
