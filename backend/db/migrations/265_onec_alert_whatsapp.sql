-- Оповещения 1С → WhatsApp, срез 3 (план spec_erp/plans/1c-agent/2026-10-19-onec-alert-notifications-plan.md §2.5, §5):
-- только расширение ограничений и индексы. Канал `whatsapp` — лично получателям группы, `whatsapp_chat` — в выбранный
-- чат WhatsApp (whatsapp_chat_id обязателен). Внешняя часть отправки может быть отменена (все участники закрылись).
-- Без `public.`: интеграционные тесты 1С применяют миграцию к изолированной схеме через search_path.
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE onec_alert_notification_policies DROP CONSTRAINT IF EXISTS chk_onec_alert_policies_channels;
ALTER TABLE onec_alert_notification_policies ADD CONSTRAINT chk_onec_alert_policies_channels
  CHECK (external_channels <@ ARRAY['telegram', 'whatsapp', 'whatsapp_chat']::text[]);
ALTER TABLE onec_alert_notification_policies DROP CONSTRAINT IF EXISTS chk_onec_alert_policies_whatsapp_chat;
ALTER TABLE onec_alert_notification_policies ADD CONSTRAINT chk_onec_alert_policies_whatsapp_chat
  CHECK (NOT ('whatsapp_chat' = ANY (external_channels)) OR whatsapp_chat_id IS NOT NULL);

ALTER TABLE onec_alert_dispatches DROP CONSTRAINT IF EXISTS chk_onec_alert_dispatches_external;
ALTER TABLE onec_alert_dispatches ADD CONSTRAINT chk_onec_alert_dispatches_external
  CHECK (external_state IN ('none', 'pending_delay', 'queued', 'suppressed', 'cancelled'));
-- Итог доставки внешнего канала, как его вернул канал (sent, failed, unknown, cancelled, skipped) и причина: пока
-- NULL, диспетчер следит за строкой (отмена по закрытию, повтор после delivery_gap/expired).
ALTER TABLE onec_alert_dispatch_recipients
  ADD COLUMN IF NOT EXISTS channel_state TEXT NULL,
  ADD COLUMN IF NOT EXISTS channel_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS channel_state_at TIMESTAMPTZ NULL;
-- Отправки с поставленной внешней частью и строки, за которыми ещё следит диспетчер.
CREATE INDEX IF NOT EXISTS idx_onec_alert_dispatches_external_queued ON onec_alert_dispatches (created_at)
  WHERE external_state = 'queued';
CREATE INDEX IF NOT EXISTS idx_onec_alert_recipients_external_queued ON onec_alert_dispatch_recipients (dispatch_id)
  WHERE channel = 'whatsapp' AND status = 'queued' AND channel_state IS NULL;

COMMENT ON COLUMN onec_alert_notification_policies.external_channels IS
  'Внешние каналы: whatsapp — лично получателям, whatsapp_chat — в чат whatsapp_chat_id, telegram — позже';

COMMIT;
