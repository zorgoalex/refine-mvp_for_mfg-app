-- Status automation rules: событие -> условия -> целевой статус (спека 2026-07-14).
BEGIN;

CREATE TABLE IF NOT EXISTS status_automation_rules (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  event_type    text        NOT NULL,
  action_type   text        NOT NULL CHECK (action_type IN
                  ('change_order_status','change_production_status','change_details_production_status')),
  target_status_id bigint  NOT NULL,
  conditions_json jsonb     NOT NULL DEFAULT '{}'::jsonb,
  priority      integer     NOT NULL DEFAULT 100,
  is_enabled    boolean     NOT NULL DEFAULT false,
  version       integer     NOT NULL DEFAULT 1,
  created_by    bigint,
  edited_by     bigint,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz
);

CREATE INDEX IF NOT EXISTS idx_status_automation_rules_dispatch
  ON status_automation_rules (event_type, is_enabled, priority, id);

COMMIT;
