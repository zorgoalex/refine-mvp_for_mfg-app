-- 038_seed_vacuum_cut_profiles.sql
--
-- Inserts 3 canonical "vacuum table" cut profiles keyed by the immutable
-- `seed_key` column added by migration 037.
--
-- STRATEGY: INSERT-ONLY by seed_key. Each INSERT uses a WHERE NOT EXISTS guard
-- scoped to seed_key so the migration is fully idempotent: re-running it (e.g.
-- during a go-live DB restore) is a safe no-op for any already-seeded row.
--
-- NAME COLLISION → LOUD ABORT (intentional): the unique constraint
-- `uq_cut_param_profiles_name` from migration 023 is NOT bypassed. If a
-- pre-existing user-created profile already holds one of the seed names, the
-- INSERT will fail on that constraint and the migration ABORTS loudly so a human
-- can rename or remove the conflicting row. The seed NEVER silently claims or
-- clobbers a user-owned profile. (On erp_test the 3 ad-hoc vacuum rows are
-- removed in the Task 6 pre-apply step; on a clean production restore no vacuum
-- profiles exist, so there is no collision.)
--
-- PARAMS: shop default core (DEFAULT_FREECUT_PARAMS from cut-config.ts) +
-- layout_mode: 'vacuum_table' (NOT 'guillotine') + vacuum.direction per row.
-- Core: kerf_mm:2, spacing_mm:1, trim_mm:{left:10,right:10,top:10,bottom:10},
--       objective:'min_waste', time_limit_ms:1200, restarts:5,
--       retry_strategy:'disabled'.
--
-- Reversibility: every row inserted here is keyed by seed_key; the rollback
-- section deletes ONLY those 3 seed_key rows and leaves all user profiles
-- untouched. Because this migration is INSERT-ONLY (no pre-existing rows are
-- claimed), the rollback causes no collateral damage.

INSERT INTO cut_param_profiles (name, params, seed_key, is_default, is_active)
SELECT
  'Вакуумный стол (авто)',
  '{"kerf_mm":2,"spacing_mm":1,"trim_mm":{"left":10,"right":10,"top":10,"bottom":10},"objective":"min_waste","time_limit_ms":1200,"restarts":5,"layout_mode":"vacuum_table","retry_strategy":"disabled","vacuum":{"direction":"optimal"}}'::jsonb,
  'vacuum_optimal',
  false,
  true
WHERE NOT EXISTS (SELECT 1 FROM cut_param_profiles WHERE seed_key = 'vacuum_optimal');

INSERT INTO cut_param_profiles (name, params, seed_key, is_default, is_active)
SELECT
  'Вакуумный стол (вдоль)',
  '{"kerf_mm":2,"spacing_mm":1,"trim_mm":{"left":10,"right":10,"top":10,"bottom":10},"objective":"min_waste","time_limit_ms":1200,"restarts":5,"layout_mode":"vacuum_table","retry_strategy":"disabled","vacuum":{"direction":"width"}}'::jsonb,
  'vacuum_width',
  false,
  true
WHERE NOT EXISTS (SELECT 1 FROM cut_param_profiles WHERE seed_key = 'vacuum_width');

INSERT INTO cut_param_profiles (name, params, seed_key, is_default, is_active)
SELECT
  'Вакуумный стол (поперёк)',
  '{"kerf_mm":2,"spacing_mm":1,"trim_mm":{"left":10,"right":10,"top":10,"bottom":10},"objective":"min_waste","time_limit_ms":1200,"restarts":5,"layout_mode":"vacuum_table","retry_strategy":"disabled","vacuum":{"direction":"height"}}'::jsonb,
  'vacuum_height',
  false,
  true
WHERE NOT EXISTS (SELECT 1 FROM cut_param_profiles WHERE seed_key = 'vacuum_height');

-- ── Down ─────────────────────────────────────────────────────────────────────
--   DELETE FROM cut_param_profiles WHERE seed_key IN ('vacuum_optimal','vacuum_width','vacuum_height');
