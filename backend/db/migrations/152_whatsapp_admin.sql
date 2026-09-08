BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_message_templates (
  template_id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4096),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by bigint REFERENCES users(user_id),
  updated_by bigint REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_keyword_rules (
  rule_id bigserial PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  match_mode text NOT NULL CHECK (match_mode IN ('contains_any', 'exact_any')),
  keywords jsonb NOT NULL CHECK (jsonb_typeof(keywords) = 'array' AND jsonb_array_length(keywords) BETWEEN 1 AND 50),
  template_id bigint NOT NULL REFERENCES whatsapp_message_templates(template_id),
  priority integer NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 10000),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by bigint REFERENCES users(user_id),
  updated_by bigint REFERENCES users(user_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  webhook_event_id bigserial PRIMARY KEY,
  external_event_id text NOT NULL UNIQUE CHECK (char_length(external_event_id) BETWEEN 1 AND 255),
  session_name text NOT NULL CHECK (char_length(session_name) BETWEEN 1 AND 100),
  chat_id text CHECK (char_length(chat_id) <= 160),
  message_text text CHECK (char_length(message_text) <= 4096),
  matched_rule_id bigint REFERENCES whatsapp_keyword_rules(rule_id),
  result_code text NOT NULL CHECK (result_code IN ('ignored', 'unmatched', 'queued')),
  received_at timestamptz NOT NULL DEFAULT now(),
  text_expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE TABLE IF NOT EXISTS whatsapp_delivery_jobs (
  delivery_job_id bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
  destination text CHECK (char_length(destination) <= 160),
  body text CHECK (char_length(body) <= 4096),
  source_event_id bigint REFERENCES whatsapp_webhook_events(webhook_event_id),
  source_rule_id bigint REFERENCES whatsapp_keyword_rules(rule_id),
  source_template_id bigint REFERENCES whatsapp_message_templates(template_id),
  source_template_version integer,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','retry_wait','sent','failed','unknown')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_at timestamptz,
  lock_token uuid,
  send_started_at timestamptz,
  provider_message_id text,
  error_code text,
  error_message text CHECK (char_length(error_message) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  body_expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS whatsapp_keyword_rules_match_idx
  ON whatsapp_keyword_rules(enabled, priority, rule_id);
CREATE INDEX IF NOT EXISTS whatsapp_delivery_jobs_claim_idx
  ON whatsapp_delivery_jobs(state, next_attempt_at, delivery_job_id)
  WHERE state IN ('pending','retry_wait');
CREATE INDEX IF NOT EXISTS whatsapp_delivery_jobs_stale_idx
  ON whatsapp_delivery_jobs(locked_at) WHERE state='processing';
CREATE INDEX IF NOT EXISTS whatsapp_webhook_events_received_idx
  ON whatsapp_webhook_events(received_at DESC);

INSERT INTO permissions_catalog
  (permission_name, domain, label, description, sort_order, is_dangerous, is_active)
VALUES
  ('whatsapp.view', 'integrations', 'Просмотр WhatsApp', 'Статус, правила, очередь и аудит WhatsApp', 190, false, true),
  ('whatsapp.manage', 'integrations', 'Управление WhatsApp', 'QR, перезапуск, правила и очередь WhatsApp', 191, true, true)
ON CONFLICT (permission_name) DO UPDATE SET
  domain=EXCLUDED.domain, label=EXCLUDED.label, description=EXCLUDED.description,
  sort_order=EXCLUDED.sort_order, is_dangerous=EXCLUDED.is_dangerous,
  is_active=true, updated_at=now();

INSERT INTO role_permissions(role_id, permission_name, is_enabled)
SELECT role_id, permission_name, true
FROM roles CROSS JOIN (VALUES ('whatsapp.view'),('whatsapp.manage')) p(permission_name)
WHERE role_code IN ('admin','superadmin')
ON CONFLICT (role_id, permission_name) DO NOTHING;

UPDATE permissions_state SET version=version+1, updated_at=now() WHERE id=true;

COMMIT;
