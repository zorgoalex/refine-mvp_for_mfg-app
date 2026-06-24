-- 037_cut_param_profile_seed_key.sql
--
-- Immutable system key for canonical "ready" vacuum cut profiles. Until now
-- cut_param_profiles were identified only by their mutable `name`, making it
-- impossible to reliably reference them across renames or locale changes.
-- This adds a nullable `seed_key TEXT` column — an opaque, immutable string
-- token assigned only to system-seeded ("ready") profiles so they remain
-- canonical and reference-stable regardless of any `name` edits.
--
-- INVARIANT: User profiles created via the admin UI always get seed_key = NULL
-- (unconstrained, no uniqueness constraint applies to NULLs). A ready profile's
-- seed_key is preserved across admin edits because the admin UPDATE statements
-- only SET name / params / is_default / is_active / version — seed_key is
-- intentionally excluded from every admin-facing UPDATE; this is a documented
-- guard ensuring seed_key is strictly immutable after initial INSERT.
--
-- PARTIAL UNIQUE: only non-NULL seed_key values are globally unique. This lets
-- any number of user profiles coexist with seed_key = NULL while each system
-- seed key appears at most once.
--
-- Additive, reversible.

ALTER TABLE cut_param_profiles
  ADD COLUMN IF NOT EXISTS seed_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cut_param_profiles_seed_key
  ON cut_param_profiles(seed_key)
  WHERE seed_key IS NOT NULL;

-- ── Down ─────────────────────────────────────────────────────────────────────
--   DROP INDEX IF EXISTS uq_cut_param_profiles_seed_key;
--   ALTER TABLE cut_param_profiles DROP COLUMN IF EXISTS seed_key;
