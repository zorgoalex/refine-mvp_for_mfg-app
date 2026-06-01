const { execFileSync } = require('node:child_process');

const COMMANDS = new Set(['snapshot', 'evidence', 'create', 'restore']);
const FIXTURE_KEY = 'deadline-escalate-canary-2026-06-01';
const FIXTURE_ROLE = 'escalate';
const MANAGER_USER_ID = 1;
const WORKER_NOW = '2000-01-06T00:01:00.000Z';
const PRODUCTION_MARKERS = ['prod', 'production', 'live'];
const TARGET_ENV_KEYS = [
  'COMPOSE_PROJECT_NAME',
  'APP_ENV',
  'BACKEND_ENV',
  'BACKEND_NODE_ENV',
  'NODE_ENV',
  'BACKEND_FQDN',
  'FRONTEND_ORIGIN',
  'DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER',
  'DEADLINE_ENGINE_STAGE_BACKEND_API_URL',
];

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}

function sqlLiteral(value) {
  return `'${escapeSql(value)}'`;
}

function hasProductionTarget(values) {
  return values
    .filter((value) => value !== undefined && value !== null)
    .map((value) => String(value).trim().toLowerCase())
    .some((value) => PRODUCTION_MARKERS.some((marker) => value.includes(marker)));
}

function requireBackendTestTarget(env = process.env) {
  if (env.DEADLINE_ESCALATE_STAGE_CANARY !== 'true') {
    throw new Error('DEADLINE_ESCALATE_STAGE_CANARY=true is required');
  }
  if (env.DEADLINE_ESCALATE_TARGET_ENV !== 'backend-test') {
    throw new Error('DEADLINE_ESCALATE_TARGET_ENV=backend-test is required');
  }
  if (env.DEADLINE_ESCALATE_RESTORE !== 'true') {
    throw new Error('DEADLINE_ESCALATE_RESTORE=true is required');
  }

  const targetValues = TARGET_ENV_KEYS.map((key) => env[key]).filter(Boolean);
  if (hasProductionTarget(targetValues)) {
    throw new Error('Refusing to run deadline escalate fixture against a production target');
  }
}

function readPositiveIntegerEnv(env, key) {
  const rawValue = env[key]?.trim();
  if (!rawValue) {
    throw new Error(`${key} is required`);
  }
  if (!/^[1-9]\d*$/.test(rawValue)) {
    throw new Error(`${key} must be a positive integer`);
  }
  return Number(rawValue);
}

function readConfig(env = process.env) {
  requireBackendTestTarget(env);
  return {
    fixtureKey: env.DEADLINE_ESCALATE_FIXTURE_KEY?.trim() || FIXTURE_KEY,
    orderId: readPositiveIntegerEnv(env, 'DEADLINE_ESCALATE_ORDER_ID'),
    managerUserId: MANAGER_USER_ID,
    postgresContainer:
      env.DEADLINE_ENGINE_STAGE_POSTGRES_CONTAINER?.trim() || 'erp_test-postgresdb-1',
    workerNow: env.DEADLINE_ESCALATE_WORKER_NOW?.trim() || WORKER_NOW,
  };
}

function buildFixtureDeadlineCte(config) {
  return `fixture_deadlines AS (
  SELECT deadline_id
  FROM deadline_instances
  WHERE metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
    AND metadata_json->>'fixtureRole' = ${sqlLiteral(FIXTURE_ROLE)}
    AND order_id = ${config.orderId}
)`;
}

function buildFixtureEventCte() {
  return `fixture_deadline_events AS (
  SELECT de.deadline_event_id
  FROM deadline_events de
  JOIN fixture_deadlines fd ON fd.deadline_id = de.deadline_id
)`;
}

function buildFixtureRuleCte(config) {
  return `fixture_action_rules AS (
  SELECT action_rule_id
  FROM deadline_action_rules
  WHERE config_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
    AND config_json->>'fixtureRole' = ${sqlLiteral(FIXTURE_ROLE)}
    AND scope_type = 'order'
    AND event_type = 'DEADLINE_EXPIRED'
    AND action_type = 'escalate'
)`;
}

function buildRestoreBodySql(config) {
  return `
WITH ${buildFixtureDeadlineCte(config)},
${buildFixtureEventCte()},
${buildFixtureRuleCte(config)}
DELETE FROM deadline_action_executions
WHERE deadline_event_id IN (SELECT deadline_event_id FROM fixture_deadline_events)
   OR action_rule_id IN (SELECT action_rule_id FROM fixture_action_rules);

WITH ${buildFixtureDeadlineCte(config)},
${buildFixtureEventCte()}
DELETE FROM notifications
WHERE source_type = 'deadline'
  AND source_id IN (SELECT deadline_event_id::text FROM fixture_deadline_events);

WITH ${buildFixtureDeadlineCte(config)},
${buildFixtureEventCte()}
DELETE FROM outbox_events
WHERE (
    aggregate_type = 'deadline'
    AND aggregate_id IN (SELECT deadline_id::text FROM fixture_deadlines)
  )
  OR payload_json->>'deadlineEventId' IN (
    SELECT deadline_event_id::text FROM fixture_deadline_events
  )
  OR payload_json->>'deadlineId' IN (
    SELECT deadline_id::text FROM fixture_deadlines
  )
  OR (
    payload_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
    AND (payload_json->>'orderId')::bigint = ${config.orderId}
  );

WITH ${buildFixtureDeadlineCte(config)},
${buildFixtureEventCte()}
DELETE FROM audit_log
WHERE (
    entity_type = 'deadline'
    AND entity_id IN (SELECT deadline_id::text FROM fixture_deadlines)
  )
  OR metadata_json->>'deadlineEventId' IN (
    SELECT deadline_event_id::text FROM fixture_deadline_events
  )
  OR metadata_json->>'deadlineId' IN (
    SELECT deadline_id::text FROM fixture_deadlines
  )
  OR (
    metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
    AND (metadata_json->>'orderId')::bigint = ${config.orderId}
  );

WITH ${buildFixtureDeadlineCte(config)}
DELETE FROM deadline_events
WHERE deadline_id IN (SELECT deadline_id FROM fixture_deadlines);

WITH ${buildFixtureRuleCte(config)}
DELETE FROM deadline_action_rules
WHERE action_rule_id IN (SELECT action_rule_id FROM fixture_action_rules)
  AND config_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
  AND config_json->>'fixtureRole' = ${sqlLiteral(FIXTURE_ROLE)};

DELETE FROM deadline_instances
WHERE metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
  AND metadata_json->>'fixtureRole' = ${sqlLiteral(FIXTURE_ROLE)}
  AND order_id = ${config.orderId};
`.trim();
}

function buildEvidenceSql(config) {
  return `
WITH ${buildFixtureDeadlineCte(config)},
${buildFixtureEventCte()},
${buildFixtureRuleCte(config)},
fixture_action_executions AS (
  SELECT dae.*
  FROM deadline_action_executions dae
  JOIN fixture_deadline_events fde ON fde.deadline_event_id = dae.deadline_event_id
  WHERE dae.action_rule_id IN (SELECT action_rule_id FROM fixture_action_rules)
),
fixture_notifications AS (
  SELECT n.*
  FROM notifications n
  JOIN fixture_deadline_events fde ON fde.deadline_event_id::text = n.source_id
  WHERE n.source_type = 'deadline'
),
fixture_audit AS (
  SELECT al.*
  FROM audit_log al
  WHERE (
      al.entity_type = 'deadline'
      AND al.entity_id IN (SELECT deadline_id::text FROM fixture_deadlines)
    )
     OR al.metadata_json->>'deadlineEventId' IN (
      SELECT deadline_event_id::text FROM fixture_deadline_events
    )
     OR al.metadata_json->>'deadlineId' IN (
      SELECT deadline_id::text FROM fixture_deadlines
    )
     OR (
      al.metadata_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
      AND (al.metadata_json->>'orderId')::bigint = ${config.orderId}
    )
),
fixture_outbox AS (
  SELECT oe.*
  FROM outbox_events oe
  WHERE (
      oe.aggregate_type = 'deadline'
      AND oe.aggregate_id IN (SELECT deadline_id::text FROM fixture_deadlines)
    )
     OR oe.payload_json->>'deadlineEventId' IN (
      SELECT deadline_event_id::text FROM fixture_deadline_events
    )
     OR oe.payload_json->>'deadlineId' IN (
      SELECT deadline_id::text FROM fixture_deadlines
    )
     OR (
      oe.payload_json->>'fixtureKey' = ${sqlLiteral(config.fixtureKey)}
      AND (oe.payload_json->>'orderId')::bigint = ${config.orderId}
    )
)
SELECT json_build_object(
  'fixtureKey', ${sqlLiteral(config.fixtureKey)},
  'orderId', ${config.orderId},
  'managerUserId', ${config.managerUserId},
  'deadlineCount', (SELECT count(*)::int FROM fixture_deadlines),
  'eventCount', (SELECT count(*)::int FROM fixture_deadline_events),
  'actionRuleCount', (SELECT count(*)::int FROM fixture_action_rules),
  'actionExecutionCount', (SELECT count(*)::int FROM fixture_action_executions),
  'selectedExecutionCount', (
    SELECT count(*)::int
    FROM fixture_action_executions
    WHERE action_type = 'escalate'
      AND status = 'executed'
      AND (result_json->>'escalatedUserId')::bigint = ${config.managerUserId}
  ),
  'managerNotificationCount', (
    SELECT count(*)::int
    FROM fixture_notifications n
    WHERE n.user_id = ${config.managerUserId}
      AND n.idempotency_key LIKE 'deadline-notification:%:escalate:${config.managerUserId}'
  ),
  'distinctManagerUserCount', (
    SELECT COUNT(DISTINCT n.user_id)::int
    FROM fixture_notifications n
    WHERE n.user_id = ${config.managerUserId}
  ),
  'notificationIdempotencyKey', (
    SELECT max(coalesce(n.idempotency_key, fae.result_json->>'notificationIdempotencyKey'))
    FROM fixture_notifications n
    FULL JOIN fixture_action_executions fae
      ON fae.result_json->>'notificationIdempotencyKey' = n.idempotency_key
    WHERE coalesce(n.idempotency_key, fae.result_json->>'notificationIdempotencyKey')
      LIKE 'deadline-notification:%:escalate:${config.managerUserId}'
  ),
  'auditCount', (SELECT count(*)::int FROM fixture_audit),
  'outboxCount', (SELECT count(*)::int FROM fixture_outbox)
)::text;
`.trim();
}

function buildSnapshotSql(config) {
  return buildEvidenceSql(config);
}

function buildCreateSql(config) {
  return `
BEGIN;

${buildRestoreBodySql(config)}

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM orders o
    JOIN users u ON u.user_id = o.manager_id
    WHERE o.order_id = ${config.orderId}
      AND o.manager_id = ${config.managerUserId}
      AND manager_id = ${config.managerUserId}
      AND COALESCE(o.delete_flag, false) = false
      AND o.completion_date IS NULL
      AND u.is_active = true
  ) THEN
    RAISE EXCEPTION 'Deadline escalate fixture order % is missing, deleted, complete, or lacks active manager user %', ${config.orderId}, ${config.managerUserId};
  END IF;
END $$;

INSERT INTO deadline_instances (
  entity_type,
  entity_id,
  order_id,
  responsible_user_id,
  deadline_at,
  status,
  source,
  metadata_json,
  started_at,
  created_at,
  updated_at
)
VALUES (
  'order',
  ${sqlLiteral(config.orderId)},
  ${config.orderId},
  ${config.managerUserId},
  ${sqlLiteral(config.workerNow)}::timestamptz - interval '1 minute',
  'active',
  'manual',
  jsonb_build_object('fixtureKey', ${sqlLiteral(config.fixtureKey)}, 'fixtureRole', ${sqlLiteral(FIXTURE_ROLE)}, 'managerUserId', ${config.managerUserId}, 'workerNow', ${sqlLiteral(config.workerNow)}, 'createdBy', 'deadline-escalate-fixture'),
  ${sqlLiteral(config.workerNow)}::timestamptz - interval '1 minute',
  ${sqlLiteral(config.workerNow)}::timestamptz - interval '1 minute',
  ${sqlLiteral(config.workerNow)}::timestamptz - interval '1 minute'
);

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
VALUES (
  'order',
  'DEADLINE_EXPIRED',
  'escalate',
  true,
  10,
  jsonb_build_object(
    'fixtureKey', ${sqlLiteral(config.fixtureKey)},
    'fixtureRole', ${sqlLiteral(FIXTURE_ROLE)},
    'managerUserId', ${config.managerUserId},
    'scope', jsonb_build_object('type', 'global_orders'),
    'conditions', jsonb_build_object(
      'excludeCompletedOrders', true,
      'requireCurrentDeadlineEvent', false
    ),
    'actionConfig', jsonb_build_object(),
    'createdBy', 'deadline-escalate-fixture'
  ),
  now(),
  now()
);

COMMIT;

${buildEvidenceSql(config)}
`.trim();
}

function buildRestoreSql(config) {
  return `
BEGIN;

${buildRestoreBodySql(config)}

COMMIT;

${buildEvidenceSql(config)}
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
    throw new Error('Deadline escalate fixture SQL did not return JSON');
  }
  return JSON.parse(jsonLine);
}

function runCommand(command, env = process.env, options = {}) {
  if (!COMMANDS.has(command)) {
    throw new Error('Usage: deadline-escalate-fixture <snapshot|evidence|create|restore>');
  }

  const config = readConfig(env);
  if (command === 'snapshot' || command === 'evidence') {
    return runSql(config, buildEvidenceSql(config), options);
  }
  if (command === 'create') {
    return runSql(config, buildCreateSql(config), options);
  }
  return runSql(config, buildRestoreSql(config), options);
}

module.exports = {
  buildCreateSql,
  buildEvidenceSql,
  buildRestoreSql,
  buildSnapshotSql,
  escapeSql,
  hasProductionTarget,
  readConfig,
  requireBackendTestTarget,
  runCommand,
  runSql,
};
