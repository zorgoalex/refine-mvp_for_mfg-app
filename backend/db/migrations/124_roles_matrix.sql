-- Runtime role permissions matrix. Static TypeScript permissions remain the
-- catalog/default seed source; these tables are the runtime source of truth.
BEGIN;

CREATE TABLE IF NOT EXISTS permissions_catalog (
  permission_name text PRIMARY KEY,
  domain text NOT NULL,
  label text NOT NULL,
  description text,
  sort_order integer NOT NULL,
  is_dangerous boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id integer NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  permission_name text NOT NULL REFERENCES permissions_catalog(permission_name) ON DELETE CASCADE,
  is_enabled boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_name)
);

CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_enabled
  ON role_permissions(permission_name, is_enabled);

CREATE TABLE IF NOT EXISTS role_policy_scopes (
  role_id integer NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  scope_key text NOT NULL,
  scope_value text NOT NULL CHECK (scope_value IN ('all', 'own', 'assigned', 'none')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_role_policy_scopes_key_value
  ON role_policy_scopes(scope_key, scope_value);

CREATE TABLE IF NOT EXISTS permissions_state (
  id boolean PRIMARY KEY DEFAULT true,
  version bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT permissions_state_singleton CHECK (id = true),
  CONSTRAINT permissions_state_positive_version CHECK (version >= 1)
);

INSERT INTO permissions_state (id, version)
VALUES (true, 1)
ON CONFLICT (id) DO NOTHING;

COMMIT;
