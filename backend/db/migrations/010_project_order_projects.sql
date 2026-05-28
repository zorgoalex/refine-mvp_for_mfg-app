-- Project foundation P3.
--
-- Temporal order/project links. The tstzrange bounds are [valid_from, valid_to),
-- so adjacent [valid_from, valid_to) intervals allow adjacent links without overlap.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_available_extensions
    WHERE name = 'btree_gist'
  ) THEN
    RAISE EXCEPTION 'btree_gist extension is not available; project_order_projects exclusion constraints require it';
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS public.project_order_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id BIGINT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES public.project_projects(id) ON DELETE RESTRICT,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  relation_type TEXT NOT NULL DEFAULT 'main',
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  ended_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  end_reason TEXT,
  CONSTRAINT chk_project_order_projects_relation_type
    CHECK (relation_type IN ('main', 'secondary', 'reporting', 'billing', 'derived')),
  CONSTRAINT chk_project_order_projects_valid_range
    CHECK (valid_to IS NULL OR valid_to > valid_from)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ex_project_order_projects_no_relation_overlap'
      AND conrelid = 'public.project_order_projects'::regclass
  ) THEN
    ALTER TABLE public.project_order_projects
      ADD CONSTRAINT ex_project_order_projects_no_relation_overlap
      EXCLUDE USING gist (
        order_id WITH =,
        project_id WITH =,
        relation_type WITH =,
        tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
      );
  END IF;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ex_project_order_projects_one_primary_overlap'
      AND conrelid = 'public.project_order_projects'::regclass
  ) THEN
    ALTER TABLE public.project_order_projects
      ADD CONSTRAINT ex_project_order_projects_one_primary_overlap
      EXCLUDE USING gist (
        order_id WITH =,
        tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
      )
      WHERE (is_primary);
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_order_projects_current_relation
  ON public.project_order_projects(order_id, project_id, relation_type)
  WHERE (valid_to IS NULL);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_order_projects_current_primary
  ON public.project_order_projects(order_id)
  WHERE (is_primary AND valid_to IS NULL);

CREATE INDEX IF NOT EXISTS idx_project_order_projects_order_current
  ON public.project_order_projects(order_id, is_primary DESC, relation_type, valid_from DESC)
  WHERE (valid_to IS NULL);

CREATE INDEX IF NOT EXISTS idx_project_order_projects_project_current
  ON public.project_order_projects(project_id, relation_type, valid_from DESC)
  WHERE (valid_to IS NULL);

CREATE INDEX IF NOT EXISTS idx_project_order_projects_validity
  ON public.project_order_projects
  USING gist (order_id, tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)'));

COMMIT;
