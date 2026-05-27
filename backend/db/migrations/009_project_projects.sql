-- Project foundation P1.
--
-- Creates only the core read model table used by the read-only Projects API.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'pgcrypto'
  ) THEN
    RAISE EXCEPTION 'pgcrypto extension is not available; project_projects needs gen_random_uuid()';
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.project_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  starts_at DATE,
  ends_at DATE,
  owner_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  CONSTRAINT chk_project_projects_status
    CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived')),
  CONSTRAINT chk_project_projects_code_format
    CHECK (code ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$'),
  CONSTRAINT chk_project_projects_name_length
    CHECK (length(btrim(name)) BETWEEN 1 AND 256),
  CONSTRAINT chk_project_projects_dates_order
    CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_projects_active_code
  ON public.project_projects (lower(btrim(code)))
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_projects_status
  ON public.project_projects(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_projects_owner
  ON public.project_projects(owner_user_id, created_at DESC)
  WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_projects_archived_at
  ON public.project_projects(archived_at);

CREATE OR REPLACE FUNCTION public.project_projects_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'project_projects_updated_at'
      AND tgrelid = 'public.project_projects'::regclass
  ) THEN
    CREATE TRIGGER project_projects_updated_at
      BEFORE UPDATE ON public.project_projects
      FOR EACH ROW
      EXECUTE FUNCTION public.project_projects_set_updated_at();
  END IF;
END;
$$;

COMMIT;
