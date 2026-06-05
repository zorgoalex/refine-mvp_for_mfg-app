-- Project generic entity links and typed participants foundation.
--
-- Temporal ranges use [valid_from, valid_to), so adjacent intervals are valid
-- history while overlapping current or historical rows are rejected.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS public.project_entity_types (
  code TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  table_name TEXT NOT NULL,
  id_column TEXT NOT NULL,
  display_column TEXT,
  required_permission TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_project_entity_types_code CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$')
);

CREATE TABLE IF NOT EXISTS public.project_entity_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.project_projects(id) ON DELETE RESTRICT,
  entity_type_code TEXT NOT NULL REFERENCES public.project_entity_types(code) ON DELETE RESTRICT,
  entity_id_text TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'related',
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  ended_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  end_reason TEXT,
  CONSTRAINT chk_project_entity_links_entity_id_text CHECK (length(btrim(entity_id_text)) BETWEEN 1 AND 200),
  CONSTRAINT chk_project_entity_links_relation_type CHECK (relation_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT chk_project_entity_links_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ex_project_entity_links_no_relation_overlap'
      AND conrelid = 'public.project_entity_links'::regclass
  ) THEN
    ALTER TABLE public.project_entity_links
      ADD CONSTRAINT ex_project_entity_links_no_relation_overlap
      EXCLUDE USING gist (
        project_id WITH =,
        entity_type_code WITH =,
        entity_id_text WITH =,
        relation_type WITH =,
        tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_entity_links_current_relation
  ON public.project_entity_links(project_id, entity_type_code, entity_id_text, relation_type)
  WHERE (valid_to IS NULL);

CREATE INDEX IF NOT EXISTS idx_project_entity_links_project_current
  ON public.project_entity_links(project_id, entity_type_code, relation_type, valid_from DESC)
  WHERE (valid_to IS NULL);

CREATE TABLE IF NOT EXISTS public.project_participant_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 100,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_project_participant_roles_code CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$')
);

CREATE TABLE IF NOT EXISTS public.project_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES public.project_projects(id) ON DELETE RESTRICT,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('user', 'employee')),
  participant_id_text TEXT NOT NULL,
  role_code TEXT NOT NULL REFERENCES public.project_participant_roles(code) ON DELETE RESTRICT,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  ended_by BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  end_reason TEXT,
  CONSTRAINT chk_project_participants_participant_id_text CHECK (length(btrim(participant_id_text)) BETWEEN 1 AND 200),
  CONSTRAINT chk_project_participants_participant_id_numeric CHECK (participant_id_text ~ '^[1-9][0-9]*$'),
  CONSTRAINT chk_project_participants_valid_range CHECK (valid_to IS NULL OR valid_to > valid_from)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ex_project_participants_no_participant_overlap'
      AND conrelid = 'public.project_participants'::regclass
  ) THEN
    ALTER TABLE public.project_participants
      ADD CONSTRAINT ex_project_participants_no_participant_overlap
      EXCLUDE USING gist (
        project_id WITH =,
        participant_type WITH =,
        participant_id_text WITH =,
        tstzrange(valid_from, COALESCE(valid_to, 'infinity'::timestamptz), '[)') WITH &&
      );
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_participants_current_participant
  ON public.project_participants(project_id, participant_type, participant_id_text)
  WHERE (valid_to IS NULL);

CREATE INDEX IF NOT EXISTS idx_project_participants_project_current
  ON public.project_participants(project_id, role_code, valid_from DESC)
  WHERE (valid_to IS NULL);

INSERT INTO public.project_entity_types (code, label, table_name, id_column, display_column, required_permission)
VALUES
  ('order', 'Order', 'orders', 'order_id', 'order_name', 'orders.view'),
  ('user', 'User', 'users', 'user_id', 'username', 'users.view'),
  ('employee', 'Employee', 'employees', 'employee_id', 'full_name', 'employees.view'),
  ('client', 'Client', 'clients', 'client_id', 'client_name', 'clients.view'),
  ('workshop', 'Workshop', 'workshops', 'workshop_id', 'workshop_name', 'workshops.view'),
  ('deadline_instance', 'Deadline instance', 'deadline_instances', 'deadline_id', NULL, 'deadlines.view')
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  table_name = EXCLUDED.table_name,
  id_column = EXCLUDED.id_column,
  display_column = EXCLUDED.display_column,
  required_permission = EXCLUDED.required_permission,
  is_active = true,
  updated_at = now();

INSERT INTO public.project_participant_roles (code, label, description, sort_order)
VALUES
  ('owner', 'Owner', 'Project curator role; not a domain owner invariant', 10),
  ('manager', 'Manager', 'Project coordination role', 20),
  ('participant', 'Participant', 'Default project participant role', 30),
  ('observer', 'Observer', 'Read-oriented project participant role', 40)
ON CONFLICT (code) DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_active = true,
  updated_at = now();

COMMIT;
