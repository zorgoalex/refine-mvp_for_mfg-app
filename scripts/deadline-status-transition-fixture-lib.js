const { execFileSync } = require('node:child_process');

const COMMANDS = new Set(['snapshot', 'restore', 'create', 'evidence']);
const PRODUCTION_MARKERS = ['prod', 'production', 'live'];
const TARGET_ENV_KEYS = [
  'DEADLINE_STATUS_TRANSITION_TARGET_ENV',
  'DEADLINE_ENGINE_STAGE_BACKEND_API_URL',
  'DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER',
  'COMPOSE_PROJECT_NAME',
  'BACKEND_FQDN',
  'FRONTEND_ORIGIN',
  'APP_ENV',
  'BACKEND_ENV',
  'BACKEND_NODE_ENV',
  'NODE_ENV',
];

function hasProductionTarget(values) {
  return values
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim().toLowerCase())
    .some((value) => PRODUCTION_MARKERS.some((marker) => value.includes(marker)));
}

function readPositiveInteger(value, name) {
  const normalized = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(normalized);
}

function readFixtureConfig(env = process.env) {
  if (env.DEADLINE_STATUS_TRANSITION_STAGE_CANARY !== 'true') {
    throw new Error('DEADLINE_STATUS_TRANSITION_STAGE_CANARY=true is required');
  }
  if (env.DEADLINE_STATUS_TRANSITION_RESTORE !== 'true') {
    throw new Error('DEADLINE_STATUS_TRANSITION_RESTORE=true is required');
  }
  if (env.DEADLINE_STATUS_TRANSITION_TARGET_ENV !== 'backend-test') {
    throw new Error('DEADLINE_STATUS_TRANSITION_TARGET_ENV=backend-test is required');
  }

  const targetValues = TARGET_ENV_KEYS.map((key) => env[key]).filter(Boolean);
  if (hasProductionTarget(targetValues)) {
    throw new Error('Refusing to run deadline status transition fixture against production target');
  }

  const fixtureKey = env.DEADLINE_STATUS_TRANSITION_FIXTURE_KEY?.trim();
  if (!fixtureKey) {
    throw new Error('DEADLINE_STATUS_TRANSITION_FIXTURE_KEY is required');
  }

  const orderId = readPositiveInteger(
    env.DEADLINE_STATUS_TRANSITION_ORDER_ID ?? '11182',
    'DEADLINE_STATUS_TRANSITION_ORDER_ID',
  );

  return {
    fixtureKey,
    orderId,
    postgresContainer:
      env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER?.trim() || 'erp_test-postgresdb-1',
    workerNow:
      env.DEADLINE_STATUS_TRANSITION_WORKER_NOW?.trim() || '2000-01-05T00:01:00.000Z',
  };
}

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

function sqlLiteral(value) {
  return `'${sqlString(value)}'`;
}

function buildSnapshotSql(config) {
  return `
${buildSnapshotTableSql()}

INSERT INTO deadline_status_transition_canary_snapshots (
  fixture_key,
  order_id,
  original_status_id
)
SELECT
  ${sqlLiteral(config.fixtureKey)},
  o.order_id,
  o.order_status_id
FROM orders o
WHERE o.order_id = ${config.orderId}
  AND COALESCE(o.delete_flag, false) = false
  AND o.completion_date IS NULL
  AND o.issue_date IS NULL
ON CONFLICT (fixture_key, order_id) DO NOTHING;

SELECT json_build_object(
  'fixtureKey', ${sqlLiteral(config.fixtureKey)},
  'orderId', ${config.orderId},
  'originalStatusId', (
    SELECT original_status_id
    FROM deadline_status_transition_canary_snapshots
    WHERE fixture_key = ${sqlLiteral(config.fixtureKey)}
      AND order_id = ${config.orderId}
  ),
  'currentStatusId', (
    SELECT order_status_id
    FROM orders
    WHERE order_id = ${config.orderId}
  )
)::text;
`.trim();
}

function buildSnapshotTableSql() {
  return `
CREATE TABLE IF NOT EXISTS deadline_status_transition_canary_snapshots (
  fixture_key TEXT NOT NULL,
  order_id BIGINT NOT NULL,
  original_status_id BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fixture_key, order_id)
);
`.trim();
}

function buildFixtureDeadlineCte(config) {
  return `fixture_deadlines AS (
  SELECT deadline_id
  FROM deadline_instances
  WHERE metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
    AND metadata_json->>'fixtureRole' = 'status-transition'
    AND order_id = ${config.orderId}
)`;
}

function buildFixtureEventCte() {
  return `fixture_events AS (
  SELECT de.deadline_event_id
  FROM deadline_events de
  JOIN fixture_deadlines fd ON fd.deadline_id = de.deadline_id
)`;
}

function buildFixtureRuleCte(config) {
  return `fixture_rules AS (
  SELECT action_rule_id
  FROM deadline_action_rules
  WHERE config_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
    AND config_json->>'fixtureRole' = 'status-transition'
    AND (config_json->>'orderId')::bigint = ${config.orderId}
    AND action_type = 'change_order_status'
)`;
}

function buildRestoreBodySql(config) {
  return `
WITH ${buildFixtureDeadlineCte(config)}, ${buildFixtureEventCte()}, ${buildFixtureRuleCte(config)}
DELETE FROM deadline_action_executions
WHERE deadline_event_id IN (SELECT deadline_event_id FROM fixture_events)
   OR action_rule_id IN (SELECT action_rule_id FROM fixture_rules);

WITH ${buildFixtureDeadlineCte(config)}, ${buildFixtureEventCte()}
DELETE FROM outbox_events
WHERE (
    payload_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
    AND (payload_json->>'orderId')::bigint = ${config.orderId}
  )
   OR payload_json->>'deadlineEventId' IN (SELECT deadline_event_id::text FROM fixture_events)
   OR payload_json->>'deadlineId' IN (SELECT deadline_id::text FROM fixture_deadlines);

WITH ${buildFixtureDeadlineCte(config)}, ${buildFixtureEventCte()}
DELETE FROM audit_log
WHERE (
    metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
    AND (metadata_json->>'orderId')::bigint = ${config.orderId}
  )
   OR metadata_json->>'deadlineEventId' IN (SELECT deadline_event_id::text FROM fixture_events)
   OR metadata_json->>'deadlineId' IN (SELECT deadline_id::text FROM fixture_deadlines);

WITH ${buildFixtureRuleCte(config)}
DELETE FROM deadline_order_overrides
WHERE action_rule_id IN (SELECT action_rule_id FROM fixture_rules)
  AND order_id = ${config.orderId};

WITH ${buildFixtureDeadlineCte(config)}
DELETE FROM deadline_events
WHERE deadline_id IN (SELECT deadline_id FROM fixture_deadlines);

DELETE FROM deadline_instances
WHERE metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
  AND metadata_json->>'fixtureRole' = 'status-transition'
  AND order_id = ${config.orderId};

DELETE FROM deadline_action_rules
WHERE config_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
  AND config_json->>'fixtureRole' = 'status-transition'
  AND (config_json->>'orderId')::bigint = ${config.orderId}
  AND action_type = 'change_order_status';

UPDATE orders o
SET order_status_id = s.original_status_id
FROM deadline_status_transition_canary_snapshots s
WHERE s.fixture_key = ${sqlLiteral(config.fixtureKey)}
  AND s.order_id = ${config.orderId}
  AND o.order_id = s.order_id;
`.trim();
}

function buildRestoreSql(config) {
  return `
BEGIN;
${buildSnapshotTableSql()}
${buildRestoreBodySql(config)}
COMMIT;
${buildEvidenceSql(config)}
`.trim();
}

function buildCreateSql(config) {
  return `
BEGIN;
${buildSnapshotSql(config)}
${buildRestoreBodySql(config)}

DO $$
DECLARE
  current_status_id BIGINT;
  target_status_id BIGINT;
BEGIN
  SELECT o.order_status_id
  INTO current_status_id
  FROM orders o
  WHERE o.order_id = ${config.orderId}
    AND COALESCE(o.delete_flag, false) = false
    AND o.completion_date IS NULL
    AND o.issue_date IS NULL;

  IF current_status_id IS NULL THEN
    RAISE EXCEPTION 'Fixture order % is missing, deleted, complete, or issued', ${config.orderId};
  END IF;

  SELECT os.order_status_id
  INTO target_status_id
  FROM order_statuses os
  WHERE COALESCE(os.is_active, true) = true
    AND os.order_status_id <> current_status_id
  ORDER BY os.sort_order NULLS LAST, os.order_status_id
  LIMIT 1;

  IF target_status_id IS NULL THEN
    RAISE EXCEPTION 'No active non-current target order status for fixture order %', ${config.orderId};
  END IF;

  CREATE TEMP TABLE deadline_status_transition_fixture_selection(
    current_status_id BIGINT,
    target_status_id BIGINT
  ) ON COMMIT DROP;

  INSERT INTO deadline_status_transition_fixture_selection VALUES (current_status_id, target_status_id);
END $$;

WITH selection AS (
  SELECT current_status_id, target_status_id
  FROM deadline_status_transition_fixture_selection
),
inserted_deadline AS (
  INSERT INTO deadline_instances (
    entity_type,
    entity_id,
    order_id,
    deadline_at,
    status,
    source,
    metadata_json,
    started_at,
    created_at,
    updated_at
  )
  SELECT
    'order',
    ${sqlLiteral(String(config.orderId))},
    ${config.orderId},
    ${sqlLiteral(config.workerNow)}::timestamptz - interval '1 minute',
    'active',
    'manual',
    jsonb_build_object(
      'fixtureKey', ${sqlLiteral(config.fixtureKey)},
      'fixtureRole', 'status-transition',
      'workerNow', ${sqlLiteral(config.workerNow)}
    ),
    ${sqlLiteral(config.workerNow)}::timestamptz - interval '1 minute',
    ${sqlLiteral(config.workerNow)}::timestamptz - interval '1 minute',
    ${sqlLiteral(config.workerNow)}::timestamptz - interval '1 minute'
  FROM selection
  RETURNING deadline_id
),
primary_rule AS (
  INSERT INTO deadline_action_rules (
    scope_type,
    event_type,
    action_type,
    is_enabled,
    priority,
    config_json,
    created_at,
    updated_at
  )
  SELECT
    'order',
    'DEADLINE_EXPIRED',
    'change_order_status',
    true,
    10,
    jsonb_build_object(
      'fixtureKey', ${sqlLiteral(config.fixtureKey)},
      'fixtureRole', 'status-transition',
      'ruleRole', 'primary',
      'orderId', ${config.orderId},
      'scope', jsonb_build_object('type', 'global_orders'),
      'conditions', jsonb_build_object(
        'allowedFromOrderStatusIds', jsonb_build_array(selection.current_status_id),
        'excludeOrderStatusIds', jsonb_build_array(),
        'excludeCompletedOrders', true,
        'requireCurrentDeadlineEvent', false
      ),
      'actionConfig', jsonb_build_object('targetOrderStatusId', selection.target_status_id)
    ),
    now(),
    now()
  FROM selection
  RETURNING action_rule_id
),
lower_rule AS (
  INSERT INTO deadline_action_rules (
    scope_type,
    event_type,
    action_type,
    is_enabled,
    priority,
    config_json,
    created_at,
    updated_at
  )
  SELECT
    'order',
    'DEADLINE_EXPIRED',
    'change_order_status',
    true,
    20,
    jsonb_build_object(
      'fixtureKey', ${sqlLiteral(config.fixtureKey)},
      'fixtureRole', 'status-transition',
      'ruleRole', 'lower-priority',
      'orderId', ${config.orderId},
      'scope', jsonb_build_object('type', 'global_orders'),
      'conditions', jsonb_build_object(
        'allowedFromOrderStatusIds', jsonb_build_array(selection.current_status_id),
        'excludeOrderStatusIds', jsonb_build_array(),
        'excludeCompletedOrders', true,
        'requireCurrentDeadlineEvent', false
      ),
      'actionConfig', jsonb_build_object('targetOrderStatusId', selection.target_status_id)
    ),
    now(),
    now()
  FROM selection
  RETURNING action_rule_id
),
disabled_override AS (
  INSERT INTO deadline_order_overrides (
    order_id,
    action_rule_id,
    is_disabled,
    override_config_json,
    reason,
    created_by_user_id,
    updated_by_user_id
  )
  SELECT
    ${config.orderId},
    primary_rule.action_rule_id,
    true,
    jsonb_build_object('fixtureKey', ${sqlLiteral(config.fixtureKey)}, 'fixtureRole', 'status-transition', 'orderId', ${config.orderId}),
    'Stage canary disabled override before status transition execution',
    158,
    158
  FROM primary_rule
  RETURNING override_id
)
SELECT json_build_object(
  'fixtureKey', ${sqlLiteral(config.fixtureKey)},
  'orderId', ${config.orderId},
  'deadlineCount', (SELECT count(*)::int FROM inserted_deadline),
  'actionRuleCount', (SELECT count(*)::int FROM primary_rule) + (SELECT count(*)::int FROM lower_rule),
  'activeOverrideCount', (SELECT count(*)::int FROM disabled_override),
  'targetStatusId', (SELECT target_status_id::int FROM deadline_status_transition_fixture_selection),
  'currentStatusId', (SELECT current_status_id::int FROM deadline_status_transition_fixture_selection)
)::text;

COMMIT;
`.trim();
}

function buildEvidenceSql(config) {
  return `
${buildSnapshotTableSql()}

WITH ${buildFixtureDeadlineCte(config)},
${buildFixtureEventCte()},
${buildFixtureRuleCte(config)},
fixture_executions AS (
  SELECT dae.*
  FROM deadline_action_executions dae
  JOIN fixture_events fe ON fe.deadline_event_id = dae.deadline_event_id
  WHERE dae.action_rule_id IN (SELECT action_rule_id FROM fixture_rules)
),
fixture_audit AS (
  SELECT al.*
  FROM audit_log al
  WHERE (
      al.metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
      AND (al.metadata_json->>'orderId')::bigint = ${config.orderId}
    )
     OR al.metadata_json->>'deadlineId' IN (SELECT deadline_id::text FROM fixture_deadlines)
     OR al.metadata_json->>'deadlineEventId' IN (SELECT deadline_event_id::text FROM fixture_events)
),
fixture_outbox AS (
  SELECT oe.*
  FROM outbox_events oe
  WHERE (
      oe.payload_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
      AND (oe.payload_json->>'orderId')::bigint = ${config.orderId}
    )
     OR oe.payload_json->>'deadlineId' IN (SELECT deadline_id::text FROM fixture_deadlines)
     OR oe.payload_json->>'deadlineEventId' IN (SELECT deadline_event_id::text FROM fixture_events)
),
residue AS (
  SELECT json_build_object(
    'deadlineCount', (SELECT count(*)::int FROM fixture_deadlines),
    'eventCount', (SELECT count(*)::int FROM fixture_events),
    'actionRuleCount', (SELECT count(*)::int FROM fixture_rules),
    'actionExecutionCount', (SELECT count(*)::int FROM fixture_executions),
    'activeOverrideCount', (
      SELECT count(*)::int
      FROM deadline_order_overrides doo
      WHERE doo.action_rule_id IN (SELECT action_rule_id FROM fixture_rules)
        AND doo.retired_at IS NULL
    )
  ) AS value
)
SELECT json_build_object(
  'fixtureKey', ${sqlLiteral(config.fixtureKey)},
  'orderId', ${config.orderId},
  'originalStatusId', (
    SELECT original_status_id::int
    FROM deadline_status_transition_canary_snapshots
    WHERE fixture_key = ${sqlLiteral(config.fixtureKey)}
      AND order_id = ${config.orderId}
  ),
  'currentStatusId', (
    SELECT order_status_id::int
    FROM orders
    WHERE order_id = ${config.orderId}
  ),
  'targetStatusId', (
    SELECT max(target_status_id)::int
    FROM fixture_executions
  ),
  'deadlineCount', (SELECT count(*)::int FROM fixture_deadlines),
  'eventCount', (SELECT count(*)::int FROM fixture_events),
  'actionRuleCount', (SELECT count(*)::int FROM fixture_rules),
  'actionExecutionCount', (SELECT count(*)::int FROM fixture_executions),
  'activeOverrideCount', (
    SELECT count(*)::int
    FROM deadline_order_overrides doo
    WHERE doo.action_rule_id IN (SELECT action_rule_id FROM fixture_rules)
      AND doo.retired_at IS NULL
  ),
  'selectedExecutionCount', (
    SELECT count(*)::int
    FROM fixture_executions
    WHERE action_type = 'change_order_status'
      AND status = 'executed'
  ),
  'lowerPrioritySkippedCount', (
    SELECT count(*)::int
    FROM fixture_executions
    WHERE action_type = 'change_order_status'
      AND status = 'skipped'
      AND skip_reason = 'lower_priority_rule_not_selected'
  ),
  'overrideSkippedCount', (
    SELECT count(*)::int
    FROM fixture_executions
    WHERE action_type = 'change_order_status'
      AND status = 'skipped'
      AND skip_reason = 'order_override_disabled'
  ),
  'productionAuditRows', (
    SELECT count(*)::int
    FROM fixture_audit
    WHERE event = 'orders.status_change'
      AND source = 'deadline-engine'
  ),
  'productionOutboxRows', (
    SELECT count(*)::int
    FROM fixture_outbox
    WHERE event_type = 'order.status_changed'
  ),
  'postRestoreResidue', (SELECT value FROM residue)
)::text;
`.trim();
}

function runSql(config, sql, options = {}) {
  const output = (options.execFileSync || execFileSync)(
    'docker',
    [
      'exec',
      '-i',
      config.postgresContainer,
      'psql',
      '-U',
      'erp_user',
      '-d',
      'erpdb',
      '-qAtX',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();
  const jsonLine = output
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.trim().startsWith('{'));
  if (!jsonLine) {
    throw new Error('Fixture SQL did not return JSON');
  }
  return JSON.parse(jsonLine);
}

function runCommand(command, env = process.env, options = {}) {
  if (!COMMANDS.has(command)) {
    throw new Error('Usage: deadline-status-transition-fixture <snapshot|restore|create|evidence>');
  }
  const config = readFixtureConfig(env);
  if (command === 'snapshot') return runSql(config, buildSnapshotSql(config), options);
  if (command === 'restore') return runSql(config, buildRestoreSql(config), options);
  if (command === 'create') return runSql(config, buildCreateSql(config), options);
  return runSql(config, buildEvidenceSql(config), options);
}

module.exports = {
  buildCreateSql,
  buildEvidenceSql,
  buildRestoreSql,
  buildSnapshotSql,
  hasProductionTarget,
  readFixtureConfig,
  runCommand,
  runSql,
};
