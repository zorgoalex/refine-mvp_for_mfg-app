const { execFileSync } = require('node:child_process');

const VALID_COMMANDS = new Set(['snapshot', 'create', 'restore']);
const PRODUCTION_MARKERS = ['prod', 'production', 'live'];
const TARGET_ENV_KEYS = [
  'DEADLINE_WORKER_TARGET_ENV',
  'APP_ENV',
  'BACKEND_ENV',
  'BACKEND_NODE_ENV',
  'NODE_ENV',
];
const UNKNOWN_COMMAND_MESSAGE =
  'Unknown or missing deadline worker fixture command. Usage: npm run deadline-worker:fixture -- <snapshot|create|restore>';

function sqlString(value) {
  return String(value).replaceAll("'", "''");
}

function sqlLiteral(value) {
  return `'${sqlString(value)}'`;
}

function hasProductionTarget(targetEnvironments) {
  return targetEnvironments
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim().toLowerCase())
    .some((targetEnvironment) =>
      PRODUCTION_MARKERS.some((marker) => targetEnvironment.includes(marker)),
    );
}

function readFixtureConfig(env = process.env) {
  const fixtureKey = env.DEADLINE_WORKER_FIXTURE_KEY?.trim();
  if (!fixtureKey) {
    throw new Error('DEADLINE_WORKER_FIXTURE_KEY is required');
  }

  const orderIdValue = env.DEADLINE_WORKER_FIXTURE_ORDER_ID?.trim();
  if (!orderIdValue) {
    throw new Error('DEADLINE_WORKER_FIXTURE_ORDER_ID is required');
  }

  if (!/^[1-9]\d*$/.test(orderIdValue)) {
    throw new Error('DEADLINE_WORKER_FIXTURE_ORDER_ID must be a positive integer');
  }

  if (env.DEADLINE_WORKER_FIXTURE_RESTORE !== 'true') {
    throw new Error('DEADLINE_WORKER_FIXTURE_RESTORE=true is required');
  }

  const targetEnvironments = TARGET_ENV_KEYS.map((key) => env[key]).filter(Boolean);
  if (
    hasProductionTarget(targetEnvironments) &&
    env.DEADLINE_WORKER_ALLOW_PRODUCTION !== 'true'
  ) {
    throw new Error(
      'Refusing to run deadline worker fixture against a production target without DEADLINE_WORKER_ALLOW_PRODUCTION=true',
    );
  }

  return {
    fixtureKey,
    orderId: Number(orderIdValue),
    postgresContainer:
      env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER?.trim() || 'erp_test-postgresdb-1',
    now: env.DEADLINE_WORKER_FIXTURE_NOW?.trim() || '2000-01-03T00:00:00.000Z',
    cancelDeadlineAt: '2099-01-01T00:00:00.000Z',
    manualDeadlineAt: '2000-01-01T00:00:00.000Z',
    manualWorkerNow: '2000-01-01T00:01:00.000Z',
    scheduledDeadlineAt: '2000-01-02T00:00:00.000Z',
    scheduledWorkerNow: '2000-01-02T00:01:00.000Z',
  };
}

function fixtureDeadlineCte(config) {
  return `fixture_deadline_instances AS (
    SELECT deadline_id
    FROM deadline_instances
    WHERE metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
      AND order_id = ${config.orderId}
  )`;
}

function fixtureEventCte() {
  return `fixture_deadline_events AS (
    SELECT de.deadline_event_id
    FROM deadline_events de
    JOIN fixture_deadline_instances fdi ON fdi.deadline_id = de.deadline_id
  )`;
}

function fixtureActionRuleCte(config) {
  return `fixture_action_rules AS (
    SELECT action_rule_id
    FROM deadline_action_rules
    WHERE config_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
  )`;
}

function restoreBodySql(config) {
  return `
WITH ${fixtureDeadlineCte(config)},
${fixtureEventCte()},
${fixtureActionRuleCte(config)}
DELETE FROM deadline_action_executions
WHERE deadline_event_id IN (SELECT deadline_event_id FROM fixture_deadline_events)
   OR action_rule_id IN (SELECT action_rule_id FROM fixture_action_rules);

WITH ${fixtureDeadlineCte(config)}
DELETE FROM outbox_events
WHERE aggregate_type = 'deadline'
  AND aggregate_id IN (SELECT deadline_id::text FROM fixture_deadline_instances);

WITH ${fixtureDeadlineCte(config)}
DELETE FROM audit_log
WHERE entity_type = 'deadline'
  AND entity_id IN (SELECT deadline_id::text FROM fixture_deadline_instances);

WITH ${fixtureDeadlineCte(config)},
${fixtureEventCte()}
DELETE FROM notifications
WHERE source_type = 'deadline'
  AND source_id IN (SELECT deadline_event_id::text FROM fixture_deadline_events);

WITH ${fixtureDeadlineCte(config)}
DELETE FROM deadline_events
WHERE deadline_id IN (SELECT deadline_id FROM fixture_deadline_instances);

DELETE FROM deadline_instances
WHERE metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
  AND order_id = ${config.orderId};

WITH ${fixtureActionRuleCte(config)}
DELETE FROM deadline_action_rules
WHERE action_rule_id IN (SELECT action_rule_id FROM fixture_action_rules)
  AND config_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)};
`.trim();
}

function snapshotFixtureSql(config) {
  return `
WITH fixture_deadline_instances AS (
  SELECT deadline_id
  FROM deadline_instances
  WHERE metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
    AND order_id = ${config.orderId}
),
fixture_deadline_events AS (
  SELECT de.deadline_event_id
  FROM deadline_events de
  JOIN fixture_deadline_instances fdi ON fdi.deadline_id = de.deadline_id
),
fixture_action_rules AS (
  SELECT action_rule_id
  FROM deadline_action_rules
  WHERE config_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
),
fixture_counts AS (
  SELECT
    (SELECT COUNT(*)::int FROM fixture_deadline_instances) AS deadline_count,
    (SELECT COUNT(*)::int FROM fixture_deadline_events) AS event_count,
    (SELECT COUNT(*)::int FROM fixture_action_rules) AS action_rule_count,
    (
      SELECT COUNT(*)::int
      FROM audit_log al
      JOIN fixture_deadline_instances fdi ON fdi.deadline_id::text = al.entity_id
      WHERE al.entity_type = 'deadline'
    ) AS audit_count,
    (
      SELECT COUNT(*)::int
      FROM outbox_events oe
      JOIN fixture_deadline_instances fdi ON fdi.deadline_id::text = oe.aggregate_id
      WHERE oe.aggregate_type = 'deadline'
    ) AS outbox_count,
    (
      SELECT COUNT(*)::int
      FROM notifications n
      JOIN fixture_deadline_events fde ON fde.deadline_event_id::text = n.source_id
      WHERE n.source_type = 'deadline'
    ) AS notification_count,
    (
      SELECT COUNT(*)::int
      FROM deadline_action_executions dae
      JOIN fixture_deadline_events fde ON fde.deadline_event_id = dae.deadline_event_id
    ) AS action_execution_count
)
SELECT json_build_object(
  'fixtureKey', ${sqlLiteral(config.fixtureKey)},
  'orderId', ${config.orderId},
  'deadlineCount', deadline_count,
  'eventCount', event_count,
  'actionRuleCount', action_rule_count,
  'auditCount', audit_count,
  'outboxCount', outbox_count,
  'notificationCount', notification_count,
  'actionExecutionCount', action_execution_count,
  'fingerprint', md5(concat_ws(':', ${sqlLiteral(config.fixtureKey)}, ${config.orderId}, deadline_count, event_count, action_rule_count, audit_count, outbox_count, notification_count, action_execution_count))
)::text
FROM fixture_counts;
`.trim();
}

function buildFixtureSql(config) {
  return `
BEGIN;

${restoreBodySql(config)}

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM orders
    WHERE order_id = ${config.orderId}
      AND COALESCE(delete_flag, false) = false
  ) THEN
    RAISE EXCEPTION 'Deadline worker fixture order % does not exist or is deleted', ${config.orderId};
  END IF;
END $$;

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
VALUES
  (
    'order',
    ${sqlLiteral(config.orderId)},
    ${config.orderId},
    ${sqlLiteral(config.cancelDeadlineAt)}::timestamptz,
    'active',
    'manual',
    jsonb_build_object('fixtureKey', ${sqlLiteral(config.fixtureKey)}, 'fixtureRole', 'cancel', 'createdBy', 'deadline-worker-fixture'),
    ${sqlLiteral(config.now)}::timestamptz,
    ${sqlLiteral(config.now)}::timestamptz,
    ${sqlLiteral(config.now)}::timestamptz
  ),
  (
    'order',
    ${sqlLiteral(config.orderId)},
    ${config.orderId},
    ${sqlLiteral(config.manualDeadlineAt)}::timestamptz,
    'active',
    'manual',
    jsonb_build_object('fixtureKey', ${sqlLiteral(config.fixtureKey)}, 'fixtureRole', 'manual-worker', 'workerNow', ${sqlLiteral(config.manualWorkerNow)}, 'createdBy', 'deadline-worker-fixture'),
    ${sqlLiteral(config.now)}::timestamptz,
    ${sqlLiteral(config.now)}::timestamptz,
    ${sqlLiteral(config.now)}::timestamptz
  ),
  (
    'order',
    ${sqlLiteral(config.orderId)},
    ${config.orderId},
    ${sqlLiteral(config.scheduledDeadlineAt)}::timestamptz,
    'active',
    'manual',
    jsonb_build_object('fixtureKey', ${sqlLiteral(config.fixtureKey)}, 'fixtureRole', 'scheduled-worker', 'workerNow', ${sqlLiteral(config.scheduledWorkerNow)}, 'createdBy', 'deadline-worker-fixture'),
    ${sqlLiteral(config.now)}::timestamptz,
    ${sqlLiteral(config.now)}::timestamptz,
    ${sqlLiteral(config.now)}::timestamptz
  );

INSERT INTO deadline_action_rules (
  scope_type, event_type, action_type, is_enabled, config_json, created_at, updated_at
)
VALUES (
  'order',
  'DEADLINE_EXPIRED',
  'notify_assignee',
  true,
  jsonb_build_object('fixtureKey', ${sqlLiteral(config.fixtureKey)}, 'fixtureRole', 'worker-action', 'createdBy', 'deadline-worker-fixture'),
  ${sqlLiteral(config.now)}::timestamptz,
  ${sqlLiteral(config.now)}::timestamptz
);

COMMIT;

${snapshotFixtureSql(config)}
`.trim();
}

function restoreFixtureSql(config) {
  return `
BEGIN;

${restoreBodySql(config)}

COMMIT;

${snapshotFixtureSql(config)}
`.trim();
}

function runSql(config, sql, options = {}) {
  const output = execFileSync(
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

  return options.json ? JSON.parse(output) : output;
}

function runFixtureCommand(command, env = process.env) {
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(UNKNOWN_COMMAND_MESSAGE);
  }

  const config = readFixtureConfig(env);
  if (command === 'snapshot') {
    return runSql(config, snapshotFixtureSql(config), { json: true });
  }
  if (command === 'create') {
    return runSql(config, buildFixtureSql(config), { json: true });
  }
  return runSql(config, restoreFixtureSql(config), { json: true });
}

module.exports = {
  buildFixtureSql,
  hasProductionTarget,
  readFixtureConfig,
  restoreFixtureSql,
  runFixtureCommand,
  runSql,
  snapshotFixtureSql,
};
