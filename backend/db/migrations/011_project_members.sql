-- Project foundation P4.
--
-- Temporal project members. The tstzrange bounds are [valid_from, valid_to),
-- so adjacent [valid_from, valid_to) intervals allow adjacent memberships without overlap.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'btree_gist'
  ) THEN
    RAISE EXCEPTION 'btree_gist extension is not available; project_members exclusion constraints require it';
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS public.project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.project_projects(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE RESTRICT,
  role TEXT NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  ended_by INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
  end_reason TEXT,
  CONSTRAINT chk_project_members_role_not_blank
    CHECK (length(btrim(role)) BETWEEN 1 AND 100),
  CONSTRAINT chk_project_members_valid_range
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ex_project_members_no_role_overlap'
      AND conrelid = 'public.project_members'::regclass
  ) THEN
    ALTER TABLE public.project_members
      ADD CONSTRAINT ex_project_members_no_role_overlap
      EXCLUDE USING gist (
        project_id WITH =,
        user_id WITH =,
        role WITH =,
        tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_members_current_role
  ON public.project_members(project_id, user_id, role)
  WHERE (valid_to IS NULL);

CREATE INDEX IF NOT EXISTS idx_project_members_project_current
  ON public.project_members(project_id, role, valid_from DESC)
  WHERE (valid_to IS NULL);

CREATE INDEX IF NOT EXISTS idx_project_members_user_current
  ON public.project_members(user_id, role, valid_from DESC)
  WHERE (valid_to IS NULL);

CREATE INDEX IF NOT EXISTS idx_project_members_validity
  ON public.project_members
  USING gist (project_id, user_id, role, tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)'));

COMMIT;
