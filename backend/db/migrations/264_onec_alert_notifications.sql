-- Оповещения 1С → уведомления, срез 1 (план spec_erp/plans/1c-agent/2026-10-19-onec-alert-notifications-plan.md
-- §2.3–2.6, §2.10): только добавление. Настройка доставки по 8 группам видов оповещений, журнал отправок (стадия
-- отправки, её участники-эпизоды, получатели по каналам) и состояние диспетчера (момент включения = cutoff).
-- Без `public.`: интеграционные тесты 1С применяют миграцию к изолированной схеме через search_path.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS onec_alert_notification_policies (
  group_code TEXT PRIMARY KEY,
  importance TEXT NOT NULL DEFAULT 'auto',
  recipient_role_codes TEXT[] NOT NULL DEFAULT '{}',
  recipient_user_ids BIGINT[] NOT NULL DEFAULT '{}',
  external_channels TEXT[] NOT NULL DEFAULT '{}',
  whatsapp_chat_id TEXT NULL,
  whatsapp_chat_name TEXT NULL,
  delay_minutes INTEGER NOT NULL DEFAULT 0,
  repeat_minutes INTEGER NULL,
  notify_resolved BOOLEAN NOT NULL DEFAULT true,
  quiet_hours TEXT NULL,
  critical_ignores_quiet_hours BOOLEAN NOT NULL DEFAULT true,
  version INTEGER NOT NULL DEFAULT 1,
  updated_by BIGINT NULL REFERENCES users(user_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_onec_alert_policies_group CHECK (group_code IN
    ('agent_offline', 'agent_state', 'sync', 'commands', 'config_source', 'certificate', 'stock_snapshots', 'other')),
  CONSTRAINT chk_onec_alert_policies_importance CHECK (importance IN ('auto', 'critical', 'important', 'info')),
  CONSTRAINT chk_onec_alert_policies_channels CHECK (external_channels <@ ARRAY['telegram', 'whatsapp']::text[]),
  CONSTRAINT chk_onec_alert_policies_delay CHECK (delay_minutes BETWEEN 0 AND 120),
  CONSTRAINT chk_onec_alert_policies_repeat CHECK (repeat_minutes IS NULL OR repeat_minutes BETWEEN 30 AND 1440),
  CONSTRAINT chk_onec_alert_policies_quiet CHECK (quiet_hours IS NULL OR quiet_hours ~ '^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$'),
  CONSTRAINT chk_onec_alert_policies_version CHECK (version >= 1)
);
COMMENT ON TABLE onec_alert_notification_policies IS
  'Доставка оповещений 1С по группам видов: важность, получатели, внешние каналы, задержка, повтор, тихие часы';

-- Сид: получатели пусты (→ запасная цепочка: onec.manage+onec.view, затем суперадмины), внешних каналов нет.
-- Повтор 2 ч — у групп, где бывают критичные (диспетчер повторяет только критичные).
INSERT INTO onec_alert_notification_policies (group_code, importance, repeat_minutes) VALUES
  ('agent_offline', 'critical', 120),
  ('agent_state', 'auto', 120),
  ('sync', 'important', NULL),
  ('commands', 'important', NULL),
  ('config_source', 'critical', 120),
  ('certificate', 'auto', 120),
  ('stock_snapshots', 'important', NULL),
  ('other', 'auto', 120)
ON CONFLICT (group_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS onec_alert_notification_state (
  id BOOLEAN PRIMARY KEY DEFAULT true,
  active BOOLEAN NOT NULL DEFAULT false,
  enabled_at TIMESTAMPTZ NULL,
  last_tick_at TIMESTAMPTZ NULL,
  last_tick_error TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_onec_alert_notification_state_singleton CHECK (id)
);
INSERT INTO onec_alert_notification_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
COMMENT ON TABLE onec_alert_notification_state IS
  'Диспетчер оповещений 1С: включён ли (active), момент последнего включения (cutoff для сводки), последний тик';

CREATE TABLE IF NOT EXISTS onec_alert_dispatches (
  dispatch_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id BIGINT NULL,
  group_code TEXT NOT NULL,
  stage TEXT NOT NULL,
  importance TEXT NOT NULL,
  external_state TEXT NOT NULL DEFAULT 'none',
  external_due_at TIMESTAMPTZ NULL,
  fallback_level SMALLINT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_onec_alert_dispatches_stage CHECK (stage IN ('opened', 'escalated', 'reminder', 'resolved', 'digest')),
  CONSTRAINT chk_onec_alert_dispatches_importance CHECK (importance IN ('critical', 'important', 'info')),
  CONSTRAINT chk_onec_alert_dispatches_external CHECK (external_state IN ('none', 'pending_delay', 'queued', 'suppressed')),
  CONSTRAINT chk_onec_alert_dispatches_fallback CHECK (fallback_level BETWEEN 1 AND 3)
);
CREATE INDEX IF NOT EXISTS idx_onec_alert_dispatches_created ON onec_alert_dispatches (created_at DESC, dispatch_id DESC);
CREATE INDEX IF NOT EXISTS idx_onec_alert_dispatches_external_due ON onec_alert_dispatches (external_due_at)
  WHERE external_state = 'pending_delay';
COMMENT ON TABLE onec_alert_dispatches IS 'Отправки оповещений 1С: одна стадия одной группы одного источника';

CREATE TABLE IF NOT EXISTS onec_alert_dispatch_members (
  dispatch_id BIGINT NOT NULL REFERENCES onec_alert_dispatches(dispatch_id) ON DELETE CASCADE,
  episode_id BIGINT NOT NULL REFERENCES onec_alert_episodes(episode_id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  seq SMALLINT NOT NULL DEFAULT 1,
  PRIMARY KEY (dispatch_id, episode_id),
  CONSTRAINT chk_onec_alert_dispatch_members_seq CHECK (seq BETWEEN 1 AND 99)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_onec_alert_dispatch_members_stage ON onec_alert_dispatch_members (episode_id, stage, seq);
COMMENT ON TABLE onec_alert_dispatch_members IS 'Эпизоды, вошедшие в отправку; стадия эпизода отправляется один раз (seq — номер напоминания)';

CREATE TABLE IF NOT EXISTS onec_alert_dispatch_recipients (
  recipient_row_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispatch_id BIGINT NOT NULL REFERENCES onec_alert_dispatches(dispatch_id) ON DELETE CASCADE,
  channel TEXT NOT NULL,
  user_id BIGINT NULL REFERENCES users(user_id),
  chat_id TEXT NULL,
  attempt SMALLINT NOT NULL DEFAULT 1,
  fallback_level SMALLINT NULL,
  status TEXT NOT NULL,
  skip_reason TEXT NULL,
  notification_id UUID NULL,
  channel_delivery_ref TEXT NULL,
  expires_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_onec_alert_recipients_channel CHECK (channel IN ('in_app', 'balloon', 'telegram', 'whatsapp')),
  CONSTRAINT chk_onec_alert_recipients_address CHECK (num_nonnulls(user_id, chat_id) = 1),
  CONSTRAINT chk_onec_alert_recipients_attempt CHECK (attempt BETWEEN 1 AND 4),
  CONSTRAINT chk_onec_alert_recipients_fallback CHECK (fallback_level IS NULL OR fallback_level BETWEEN 1 AND 3),
  CONSTRAINT chk_onec_alert_recipients_status CHECK (status IN ('written', 'queued', 'skipped', 'superseded'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_onec_alert_recipients_user ON onec_alert_dispatch_recipients (dispatch_id, channel, user_id, attempt)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_onec_alert_recipients_chat ON onec_alert_dispatch_recipients (dispatch_id, channel, chat_id, attempt)
  WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_onec_alert_recipients_user ON onec_alert_dispatch_recipients (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
COMMENT ON TABLE onec_alert_dispatch_recipients IS 'Получатели отправки по каналам (колокольчик, балун, Telegram, WhatsApp), с уровнем запасной цепочки';

COMMIT;
