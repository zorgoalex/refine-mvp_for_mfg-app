-- 1C agent integration, stage E1: source/agent registry, client certificates,
-- sessions, heartbeat status, versioned remote configuration, incidents, the
-- module-owned outbox and alerts, and normalized audit dimensions.
-- Command queue (E2) and ETL schema onec_etl (E3) are separate migrations.
BEGIN;

CREATE TABLE onec_sources (
  source_id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  identity jsonb,
  identity_status text NOT NULL DEFAULT 'unverified'
    CHECK (identity_status IN ('unverified','bound','identity_changed')),
  -- Human-readable generation number; restored backups may repeat it.
  generation bigint NOT NULL DEFAULT 1 CHECK (generation > 0),
  -- Opaque, never-reused generation reference compared by equality.
  generation_ref uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES users(user_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES users(user_id)
);

CREATE TABLE onec_agents (
  agent_id text PRIMARY KEY CHECK (agent_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  source_id bigint NOT NULL UNIQUE REFERENCES onec_sources(source_id),
  site_id text NOT NULL CHECK (length(btrim(site_id)) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  minimum_agent_version text NOT NULL DEFAULT '1.0'
    CHECK (minimum_agent_version ~ '^[0-9]{1,9}\.[0-9]{1,9}(\.[0-9]{1,9})?$'),
  config_publish_blocked boolean NOT NULL DEFAULT false,
  config_publish_blocked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by bigint REFERENCES users(user_id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES users(user_id)
);

CREATE TABLE onec_agent_certificates (
  cert_id bigserial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES onec_agents(agent_id),
  sha256_fingerprint bytea NOT NULL UNIQUE CHECK (octet_length(sha256_fingerprint) = 32),
  subject text CHECK (subject IS NULL OR length(subject) <= 1024),
  not_before timestamptz,
  not_after timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by bigint REFERENCES users(user_id),
  revoked_at timestamptz,
  revoked_by bigint REFERENCES users(user_id),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX onec_agent_certificates_agent_idx ON onec_agent_certificates(agent_id, status);

CREATE TABLE onec_agent_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES onec_agents(agent_id),
  agent_version text NOT NULL CHECK (length(agent_version) <= 64),
  local_schema_version integer,
  capabilities text[] NOT NULL DEFAULT '{}',
  accepted boolean NOT NULL,
  source_identity jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onec_agent_sessions_agent_idx ON onec_agent_sessions(agent_id, started_at DESC);
CREATE INDEX onec_agent_sessions_retention_idx ON onec_agent_sessions(last_seen_at);

CREATE TABLE onec_agent_status (
  agent_id text PRIMARY KEY REFERENCES onec_agents(agent_id),
  received_at timestamptz NOT NULL,
  agent_version text,
  state text NOT NULL,
  state_reason text,
  heartbeat jsonb NOT NULL DEFAULT '{}'::jsonb,
  active_config_version bigint,
  rejected_config_version bigint,
  rejected_reason text,
  cert_expires_at timestamptz,
  history_written_at timestamptz
);

CREATE TABLE onec_agent_status_history (
  history_id bigserial PRIMARY KEY,
  agent_id text NOT NULL REFERENCES onec_agents(agent_id),
  at timestamptz NOT NULL DEFAULT now(),
  state text NOT NULL,
  state_reason text,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX onec_agent_status_history_agent_idx ON onec_agent_status_history(agent_id, at DESC);

CREATE TABLE onec_agent_config_drafts (
  agent_id text PRIMARY KEY REFERENCES onec_agents(agent_id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  configuration_canonical text NOT NULL,
  config_hash text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by bigint REFERENCES users(user_id)
);

CREATE TABLE onec_agent_config_versions (
  agent_id text NOT NULL REFERENCES onec_agents(agent_id),
  config_version bigint NOT NULL CHECK (config_version > 0),
  status text NOT NULL CHECK (status IN ('published','superseded')),
  configuration_canonical text NOT NULL,
  config_hash text NOT NULL,
  published_from_revision bigint NOT NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by bigint REFERENCES users(user_id),
  PRIMARY KEY (agent_id, config_version)
);
CREATE UNIQUE INDEX onec_agent_config_versions_one_published
  ON onec_agent_config_versions(agent_id) WHERE status = 'published';

-- Published configuration bytes are immutable; only published -> superseded.
CREATE FUNCTION onec_reject_config_version_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'onec_agent_config_versions rows are immutable';
  END IF;
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.config_version IS DISTINCT FROM OLD.config_version
     OR NEW.configuration_canonical IS DISTINCT FROM OLD.configuration_canonical
     OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
     OR NEW.published_from_revision IS DISTINCT FROM OLD.published_from_revision
     OR NEW.published_at IS DISTINCT FROM OLD.published_at
     OR NEW.published_by IS DISTINCT FROM OLD.published_by
     OR NOT (OLD.status = 'published' AND NEW.status = 'superseded') THEN
    RAISE EXCEPTION 'onec_agent_config_versions: only published -> superseded is allowed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER onec_agent_config_version_immutable
  BEFORE UPDATE OR DELETE ON onec_agent_config_versions
  FOR EACH ROW EXECUTE FUNCTION onec_reject_config_version_change();

CREATE TABLE onec_agent_incidents (
  incident_id bigserial PRIMARY KEY,
  agent_id text REFERENCES onec_agents(agent_id),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  command_id uuid,
  run_id uuid,
  batch_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL UNIQUE,
  occurrences integer NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  first_at timestamptz NOT NULL DEFAULT now(),
  last_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by bigint REFERENCES users(user_id)
);
CREATE INDEX onec_agent_incidents_open_idx ON onec_agent_incidents(last_at DESC) WHERE resolved_at IS NULL;

-- Module-owned outbox: the notifications-engine relay claims every pending
-- row of public.outbox_events regardless of type, so 1C events live here.
CREATE TABLE onec_outbox_events (
  event_id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','processed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX onec_outbox_events_claim_idx ON onec_outbox_events(status, next_attempt_at, event_id);

-- Normalized audit dimensions for text/UUID identifiers that
-- audit_log_related_entity (bigint ids) cannot hold.
CREATE TABLE onec_audit_links (
  audit_id uuid PRIMARY KEY REFERENCES audit_log(audit_id) ON DELETE CASCADE,
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','onec_agent','system')),
  agent_id text,
  source_id bigint,
  source_generation bigint,
  command_id uuid,
  run_id uuid,
  batch_id uuid,
  config_version bigint,
  session_id uuid,
  cert_id bigint,
  request_id text,
  correlation_id text
);
CREATE INDEX onec_audit_links_agent_idx ON onec_audit_links(agent_id) WHERE agent_id IS NOT NULL;
CREATE INDEX onec_audit_links_source_idx ON onec_audit_links(source_id) WHERE source_id IS NOT NULL;
CREATE INDEX onec_audit_links_command_idx ON onec_audit_links(command_id) WHERE command_id IS NOT NULL;
CREATE INDEX onec_audit_links_run_idx ON onec_audit_links(run_id) WHERE run_id IS NOT NULL;
CREATE INDEX onec_audit_links_batch_idx ON onec_audit_links(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX onec_audit_links_config_idx ON onec_audit_links(agent_id, config_version) WHERE config_version IS NOT NULL;
CREATE INDEX onec_audit_links_session_idx ON onec_audit_links(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX onec_audit_links_correlation_idx ON onec_audit_links(correlation_id) WHERE correlation_id IS NOT NULL;

CREATE TABLE onec_alerts (
  alert_id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_.]{0,63}$'),
  agent_id text REFERENCES onec_agents(agent_id),
  source_id bigint REFERENCES onec_sources(source_id),
  run_id uuid,
  command_id uuid,
  cert_id bigint REFERENCES onec_agent_certificates(cert_id),
  severity text NOT NULL CHECK (severity IN ('info','warning','critical')),
  dedupe_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','resolved')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by bigint REFERENCES users(user_id),
  resolved_at timestamptz
);
CREATE INDEX onec_alerts_open_idx ON onec_alerts(state, last_seen_at DESC) WHERE state <> 'resolved';

INSERT INTO permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
VALUES
  ('onec.view', 'integrations', 'Просмотр интеграции 1С', 'Агенты 1С, состояние, конфигурация, алерты и инциденты', 200, false, true),
  ('onec.manage', 'integrations', 'Управление интеграцией 1С', 'Источники, агенты, сертификаты и публикация конфигурации агента 1С', 201, true, true),
  ('onec.commands.send', 'integrations', 'Служебные команды агенту 1С', 'Отправка служебных команд и ручных выгрузок агенту 1С', 202, true, true)
ON CONFLICT (permission_name) DO UPDATE SET
  domain=EXCLUDED.domain, label=EXCLUDED.label, description=EXCLUDED.description,
  sort_order=EXCLUDED.sort_order, is_dangerous=EXCLUDED.is_dangerous,
  is_active=true, updated_at=now();

INSERT INTO role_permissions(role_id, permission_name, is_enabled)
SELECT role_id, permission_name, true
FROM roles CROSS JOIN (VALUES ('onec.view'),('onec.manage'),('onec.commands.send')) p(permission_name)
WHERE role_code IN ('admin','superadmin')
ON CONFLICT (role_id, permission_name) DO NOTHING;

UPDATE permissions_state SET version=version+1, updated_at=now() WHERE id=true;

COMMIT;
