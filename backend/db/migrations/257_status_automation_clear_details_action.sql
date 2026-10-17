BEGIN;

-- Action «снять производственный статус у деталей» for status automation rules.
ALTER TABLE status_automation_rules
  DROP CONSTRAINT IF EXISTS status_automation_rules_action_type_check;

ALTER TABLE status_automation_rules
  ADD CONSTRAINT status_automation_rules_action_type_check
  CHECK (action_type IN (
    'change_order_status',
    'change_production_status',
    'change_details_production_status',
    'clear_details_production_status',
    'map_order_status_to_details_production_status',
    'map_production_status_to_order_status'
  ));

COMMIT;
