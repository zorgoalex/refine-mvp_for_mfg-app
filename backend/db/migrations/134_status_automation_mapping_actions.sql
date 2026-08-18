BEGIN;

ALTER TABLE status_automation_rules
  ADD COLUMN IF NOT EXISTS action_config_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE status_automation_rules
  ALTER COLUMN target_status_id DROP NOT NULL;

ALTER TABLE status_automation_rules
  DROP CONSTRAINT IF EXISTS status_automation_rules_action_type_check;

ALTER TABLE status_automation_rules
  ADD CONSTRAINT status_automation_rules_action_type_check
  CHECK (action_type IN (
    'change_order_status',
    'change_production_status',
    'change_details_production_status',
    'map_order_status_to_details_production_status',
    'map_production_status_to_order_status'
  ));

COMMIT;
