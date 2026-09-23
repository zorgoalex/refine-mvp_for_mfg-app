-- Private-filesystem WhatsApp daily order-card delivery queue.
BEGIN;

CREATE TABLE IF NOT EXISTS whatsapp_daily_digest_settings (
  singleton_id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (singleton_id=1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  group_chat_id TEXT CHECK (group_chat_id IS NULL OR group_chat_id ~ '^[0-9]{5,24}(-[0-9]{5,24})?@g[.]us$'),
  send_time TIME NOT NULL DEFAULT TIME '08:45',
  cards_per_message SMALLINT NOT NULL DEFAULT 2,
  time_zone TEXT NOT NULL DEFAULT 'Asia/Almaty' CHECK (time_zone='Asia/Almaty'),
  catch_up_policy TEXT NOT NULL DEFAULT 'until_deadline' CHECK (catch_up_policy IN ('skip','until_deadline','end_of_day')),
  catch_up_deadline TIME NOT NULL DEFAULT TIME '10:00',
  partial_policy TEXT NOT NULL DEFAULT 'remaining' CHECK (partial_policy IN ('remaining','repeat_all','manual')),
  updated_by BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR group_chat_id IS NOT NULL),
  CHECK (catch_up_policy <> 'until_deadline' OR catch_up_deadline >= send_time),
  CONSTRAINT chk_whatsapp_daily_digest_cards_per_message CHECK (cards_per_message IN (1,2))
);

INSERT INTO whatsapp_daily_digest_settings(singleton_id) VALUES (1) ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS whatsapp_daily_digest_runs (
  run_id UUID PRIMARY KEY,
  business_date DATE NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('auto','manual','retry')),
  auto_origin BOOLEAN NOT NULL DEFAULT FALSE,
  parent_run_id UUID REFERENCES whatsapp_daily_digest_runs(run_id) ON DELETE RESTRICT,
  idempotency_key UUID NOT NULL,
  request_digest TEXT NOT NULL CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  settings_version INTEGER NOT NULL CHECK (settings_version > 0),
  destination_chat_id TEXT NOT NULL CHECK (destination_chat_id ~ '^[0-9]{5,24}(-[0-9]{5,24})?@g[.]us$'),
  catch_up_policy TEXT NOT NULL CHECK (catch_up_policy IN ('skip','until_deadline','end_of_day')),
  deadline_at TIMESTAMPTZ,
  partial_policy TEXT NOT NULL CHECK (partial_policy IN ('remaining','repeat_all','manual')),
  snapshot JSONB,
  renderer_version TEXT NOT NULL,
  order_count INTEGER NOT NULL CHECK (order_count BETWEEN 0 AND 500),
  total_area NUMERIC(14,3) NOT NULL CHECK (total_area >= 0),
  state TEXT NOT NULL CHECK (state IN ('queued','sending','sent','partial','failed','unknown','cancelled','expired','empty','skipped')),
  reason TEXT CHECK (reason IS NULL OR reason ~ '^[A-Z0-9_]{1,64}$'),
  actor_user_id BIGINT,
  request_id TEXT,
  retry_depth SMALLINT NOT NULL DEFAULT 0 CHECK (retry_depth BETWEEN 0 AND 3),
  image_expires_at TIMESTAMPTZ,
  snapshot_purged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_daily_digest_auto_date
  ON whatsapp_daily_digest_runs(business_date) WHERE kind='auto';
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_daily_digest_manual_idempotency
  ON whatsapp_daily_digest_runs(idempotency_key) WHERE kind IN ('manual','retry');
CREATE INDEX IF NOT EXISTS idx_whatsapp_daily_digest_runs_recent
  ON whatsapp_daily_digest_runs(created_at DESC,run_id DESC);

CREATE TABLE IF NOT EXISTS whatsapp_daily_digest_pages (
  run_id UUID NOT NULL REFERENCES whatsapp_daily_digest_runs(run_id) ON DELETE RESTRICT,
  page_index SMALLINT NOT NULL,
  order_ids JSONB NOT NULL CHECK (jsonb_typeof(order_ids)='array' AND jsonb_array_length(order_ids) BETWEEN 1 AND 2),
  file_key TEXT NOT NULL CHECK (file_key ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}-(1|[1-9][0-9]?|[1-4][0-9]{2}|500)[.]png$'),
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 1048576),
  expires_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','sent','failed','unknown','cancelled','expired')),
  attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 4),
  preflight_attempt_count SMALLINT NOT NULL DEFAULT 0 CHECK (preflight_attempt_count BETWEEN 0 AND 3),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider_message_id TEXT,
  error_code TEXT CHECK (error_code IS NULL OR error_code ~ '^[A-Z0-9_]{1,64}$'),
  send_started_at TIMESTAMPTZ,
  lock_token UUID,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_whatsapp_daily_digest_page_index CHECK (page_index BETWEEN 1 AND 500),
  PRIMARY KEY (run_id,page_index)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_daily_digest_pages_file ON whatsapp_daily_digest_pages(file_key);
CREATE INDEX IF NOT EXISTS idx_whatsapp_daily_digest_pages_due
  ON whatsapp_daily_digest_pages(state,expires_at,run_id,page_index);

COMMIT;
