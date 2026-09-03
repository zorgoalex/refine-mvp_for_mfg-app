BEGIN;

WITH resolved AS (
  SELECT
    (
      SELECT order_status_id
      FROM order_statuses
      WHERE is_active = true AND lower(trim(order_status_name)) = 'выдан'
      ORDER BY order_status_id
      LIMIT 1
    ) AS order_issued_id,
    (
      SELECT order_status_id
      FROM order_statuses
      WHERE is_active = true AND lower(trim(order_status_name)) IN ('готов', 'готов к выдаче')
      ORDER BY CASE WHEN lower(trim(order_status_name)) = 'готов к выдаче' THEN 0 ELSE 1 END,
        order_status_id
      LIMIT 1
    ) AS order_ready_id,
    (
      SELECT order_status_id
      FROM order_statuses
      WHERE is_active = true AND lower(trim(order_status_name)) = 'в производстве'
      ORDER BY order_status_id
      LIMIT 1
    ) AS order_in_production_id,
    (
      SELECT production_status_id
      FROM production_statuses
      WHERE is_active = true
        AND (
          lower(trim(COALESCE(production_status_code, ''))) = 'issued'
          OR lower(trim(production_status_name)) = 'выдан'
        )
      ORDER BY CASE WHEN lower(trim(COALESCE(production_status_code, ''))) = 'issued' THEN 0 ELSE 1 END,
        production_status_id
      LIMIT 1
    ) AS production_issued_id,
    (
      SELECT production_status_id
      FROM production_statuses
      WHERE is_active = true
        AND (
          lower(trim(COALESCE(production_status_code, ''))) = 'packed'
          OR lower(trim(production_status_name)) = 'упакован'
        )
      ORDER BY CASE WHEN lower(trim(COALESCE(production_status_code, ''))) = 'packed' THEN 0 ELSE 1 END,
        production_status_id
      LIMIT 1
    ) AS production_packed_id,
    (
      SELECT production_status_id
      FROM production_statuses
      WHERE is_active = true
        AND (
          lower(trim(COALESCE(production_status_code, ''))) = 'laminated'
          OR lower(trim(production_status_name)) = 'закатан'
        )
      ORDER BY CASE WHEN lower(trim(COALESCE(production_status_code, ''))) = 'laminated' THEN 0 ELSE 1 END,
        production_status_id
      LIMIT 1
    ) AS production_laminated_id
), desired(name, order_status_id, production_status_id, previous_status_ids, transition_mode, priority) AS (
  SELECT
    'Выдан -> проз-во Выдан',
    order_issued_id,
    production_issued_id,
    NULL::jsonb,
    'advance_only',
    10
  FROM resolved
  UNION ALL
  SELECT
    'Готов к выдаче -> произ-во Упакован',
    order_ready_id,
    production_packed_id,
    NULL::jsonb,
    'set_exact',
    20
  FROM resolved
  UNION ALL
  SELECT
    'В производстве после готовности -> произ-во Закатан',
    order_in_production_id,
    production_laminated_id,
    jsonb_build_array(order_ready_id, order_issued_id),
    'set_exact',
    30
  FROM resolved
), valid_desired AS (
  SELECT *
  FROM desired
  WHERE order_status_id IS NOT NULL
    AND production_status_id IS NOT NULL
    AND (previous_status_ids IS NULL OR NOT previous_status_ids @> '[null]'::jsonb)
)
UPDATE status_automation_rules rule
SET event_type = 'order.status_changed',
    action_type = 'change_details_production_status',
    target_status_id = desired.production_status_id,
    conditions_json = jsonb_build_object('currentOrderStatusIn', jsonb_build_array(desired.order_status_id))
      || CASE
        WHEN desired.previous_status_ids IS NULL THEN '{}'::jsonb
        ELSE jsonb_build_object('previousOrderStatusIn', desired.previous_status_ids)
      END,
    action_config_json = jsonb_build_object('detailTransitionMode', desired.transition_mode),
    priority = desired.priority,
    is_enabled = true,
    version = rule.version + 1,
    updated_at = now()
FROM valid_desired desired
WHERE rule.name = desired.name;

WITH resolved AS (
  SELECT
    (SELECT order_status_id FROM order_statuses WHERE is_active = true AND lower(trim(order_status_name)) = 'выдан' ORDER BY order_status_id LIMIT 1) AS order_issued_id,
    (SELECT order_status_id FROM order_statuses WHERE is_active = true AND lower(trim(order_status_name)) IN ('готов', 'готов к выдаче') ORDER BY CASE WHEN lower(trim(order_status_name)) = 'готов к выдаче' THEN 0 ELSE 1 END, order_status_id LIMIT 1) AS order_ready_id,
    (SELECT order_status_id FROM order_statuses WHERE is_active = true AND lower(trim(order_status_name)) = 'в производстве' ORDER BY order_status_id LIMIT 1) AS order_in_production_id,
    (SELECT production_status_id FROM production_statuses WHERE is_active = true AND (lower(trim(COALESCE(production_status_code, ''))) = 'issued' OR lower(trim(production_status_name)) = 'выдан') ORDER BY CASE WHEN lower(trim(COALESCE(production_status_code, ''))) = 'issued' THEN 0 ELSE 1 END, production_status_id LIMIT 1) AS production_issued_id,
    (SELECT production_status_id FROM production_statuses WHERE is_active = true AND (lower(trim(COALESCE(production_status_code, ''))) = 'packed' OR lower(trim(production_status_name)) = 'упакован') ORDER BY CASE WHEN lower(trim(COALESCE(production_status_code, ''))) = 'packed' THEN 0 ELSE 1 END, production_status_id LIMIT 1) AS production_packed_id,
    (SELECT production_status_id FROM production_statuses WHERE is_active = true AND (lower(trim(COALESCE(production_status_code, ''))) = 'laminated' OR lower(trim(production_status_name)) = 'закатан') ORDER BY CASE WHEN lower(trim(COALESCE(production_status_code, ''))) = 'laminated' THEN 0 ELSE 1 END, production_status_id LIMIT 1) AS production_laminated_id
), desired(name, order_status_id, production_status_id, previous_status_ids, transition_mode, priority) AS (
  SELECT 'Выдан -> проз-во Выдан', order_issued_id, production_issued_id, NULL::jsonb, 'advance_only', 10 FROM resolved
  UNION ALL
  SELECT 'Готов к выдаче -> произ-во Упакован', order_ready_id, production_packed_id, NULL::jsonb, 'set_exact', 20 FROM resolved
  UNION ALL
  SELECT 'В производстве после готовности -> произ-во Закатан', order_in_production_id, production_laminated_id, jsonb_build_array(order_ready_id, order_issued_id), 'set_exact', 30 FROM resolved
)
INSERT INTO status_automation_rules (
  name,
  event_type,
  action_type,
  target_status_id,
  conditions_json,
  action_config_json,
  priority,
  is_enabled
)
SELECT
  desired.name,
  'order.status_changed',
  'change_details_production_status',
  desired.production_status_id,
  jsonb_build_object('currentOrderStatusIn', jsonb_build_array(desired.order_status_id))
    || CASE
      WHEN desired.previous_status_ids IS NULL THEN '{}'::jsonb
      ELSE jsonb_build_object('previousOrderStatusIn', desired.previous_status_ids)
    END,
  jsonb_build_object('detailTransitionMode', desired.transition_mode),
  desired.priority,
  true
FROM desired
WHERE desired.order_status_id IS NOT NULL
  AND desired.production_status_id IS NOT NULL
  AND (desired.previous_status_ids IS NULL OR NOT desired.previous_status_ids @> '[null]'::jsonb)
  AND NOT EXISTS (
    SELECT 1
    FROM status_automation_rules existing
    WHERE existing.name = desired.name
  );

COMMENT ON TABLE status_automation_rules IS
  'Status automation rules; MDF order lifecycle cascade installed by migration 147';

COMMIT;
