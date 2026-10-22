-- Оповещения 1С → уведомления, срез 0 (план spec_erp/plans/1c-agent/2026-10-19-onec-alert-notifications-plan.md §2.2):
-- только добавление. onec_alert_episodes — журнал эпизодов оповещений 1С: строка на каждое открытие/переоткрытие,
-- пишется в той же SQL-операции, что меняет onec_alerts (методы PgOnecRepository). FK на onec_alerts нет: история
-- переживает очистку оповещений по сроку хранения.
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS onec_alert_episodes (
  episode_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id BIGINT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL,
  severity_at_open TEXT NOT NULL,
  severity_max TEXT NOT NULL,
  acknowledged_at TIMESTAMPTZ NULL,
  resolved_at TIMESTAMPTZ NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reconciled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_onec_alert_episodes_severity CHECK (severity_at_open IN ('info', 'warning', 'critical') AND severity_max IN ('info', 'warning', 'critical')),
  CONSTRAINT chk_onec_alert_episodes_status CHECK (status IN ('pending', 'notified', 'suppressed', 'closed_unnotified'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_onec_alert_episodes_alert_opened ON onec_alert_episodes (alert_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_onec_alert_episodes_open ON onec_alert_episodes (alert_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_onec_alert_episodes_pending ON onec_alert_episodes (episode_id) WHERE status = 'pending';
COMMENT ON TABLE onec_alert_episodes IS
  'Эпизоды оповещений 1С (открытие/переоткрытие → закрытие); пишутся вместе с onec_alerts, читаются диспетчером уведомлений';

-- Открытые на момент выкладки оповещения — эпизодами, которые по одному не рассылаются (их покажет сводка при включении).
INSERT INTO onec_alert_episodes (alert_id, opened_at, kind, severity_at_open, severity_max, acknowledged_at, status)
SELECT a.alert_id, a.opened_at, a.kind, a.severity, a.severity,
       CASE WHEN a.acknowledged_at >= a.opened_at THEN a.acknowledged_at END, 'closed_unnotified'
  FROM onec_alerts a
 WHERE a.state <> 'resolved'
ON CONFLICT (alert_id, opened_at) DO NOTHING;

COMMIT;
