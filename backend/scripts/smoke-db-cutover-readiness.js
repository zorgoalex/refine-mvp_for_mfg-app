#!/usr/bin/env node

const fs = require('fs');
const { Client } = require('pg');

const REQUIRED_RELATIONS = [
  'public.auth_sessions',
  'public.audit_log',
  'public.file_uploads',
  'public.integration_jobs',
  'public.refresh_tokens',
  'public.orders',
  'public.order_details',
  'public.payments',
  'public.users',
  'public.orders_view',
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = {
    ...process.env,
    ...(args.envFile ? readEnvFile(args.envFile) : {}),
  };
  const databaseUrl = resolveDatabaseUrl(env, args.databaseUrlEnv);

  const client = await connect(databaseUrl, {
    resolvePostgresdbLocalhost: args.resolvePostgresdbLocalhost,
  });

  try {
    const relationCount = await assertRequiredRelations(client);
    await assertSetSessionUserExists(client);
    await assertOrdersViewGuard(client);
    const sortedCount = await assertOrdersViewDefaultSort(client);
    const riskyCount = await countLongDigitOrderNames(client);
    const probeStatus = args.allowTransactionalProbe
      ? await runTransactionalOverflowProbe(client)
      : 'skipped; pass --allow-transactional-probe on a restored copy';

    console.log('DB cutover readiness smoke ok.');
    console.log(`required relations ok: ${relationCount}`);
    console.log('set_session_user ok');
    console.log('orders_view overflow guard ok');
    console.log(`orders_view default sort ok: ${sortedCount} rows`);
    console.log(`long-digit active order names currently protected: ${riskyCount}`);
    console.log(`transactional overflow probe: ${probeStatus}`);
  } finally {
    await client.end();
  }
}

function parseArgs(rawArgs) {
  const result = {
    allowTransactionalProbe: false,
    databaseUrlEnv: '',
    envFile: '',
    resolvePostgresdbLocalhost: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];

    if (arg === '--allow-transactional-probe') {
      result.allowTransactionalProbe = true;
    } else if (arg === '--resolve-postgresdb-localhost') {
      result.resolvePostgresdbLocalhost = true;
    } else if (arg.startsWith('--env-file=')) {
      result.envFile = arg.slice('--env-file='.length);
    } else if (arg === '--env-file') {
      result.envFile = rawArgs[index + 1];
      index += 1;
    } else if (arg.startsWith('--database-url-env=')) {
      result.databaseUrlEnv = arg.slice('--database-url-env='.length);
    } else if (arg === '--database-url-env') {
      result.databaseUrlEnv = rawArgs[index + 1];
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      usageAndExit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      usageAndExit(1);
    }
  }

  return result;
}

function usageAndExit(code = 1) {
  console.error(
    [
      'Usage:',
      '  npm run smoke:db-cutover -- --env-file <path> [options]',
      '',
      'Options:',
      '  --database-url-env <name>       Env var containing the Postgres URL.',
      '  --allow-transactional-probe     Temporarily update one order inside ROLLBACK to prove overflow guard.',
      '  --resolve-postgresdb-localhost  Retry postgresdb host as 127.0.0.1 for host-side local smoke.',
    ].join('\n'),
  );
  process.exit(code);
}

function readEnvFile(filePath) {
  const env = {};
  const text = fs.readFileSync(filePath, 'utf8');

  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1].startsWith('#')) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[match[1]] = value;
  }

  return env;
}

function resolveDatabaseUrl(env, preferredEnvName) {
  const candidates = [
    preferredEnvName,
    'DATABASE_URL',
    'HASURA_GRAPHQL_DATABASE_URL',
    'POSTGRES_URL',
    'PG_DATABASE_URL',
  ].filter(Boolean);

  for (const name of candidates) {
    const value = env[name];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  throw new Error(`No database URL found in env candidates: ${candidates.join(', ')}`);
}

async function connect(databaseUrl, options) {
  try {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    return client;
  } catch (error) {
    if (!options.resolvePostgresdbLocalhost || error.code !== 'EAI_AGAIN') {
      throw error;
    }

    const url = new URL(databaseUrl);
    if (url.hostname !== 'postgresdb') {
      throw error;
    }

    url.hostname = '127.0.0.1';
    url.port = url.port || '5432';
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    return client;
  }
}

async function assertRequiredRelations(client) {
  const result = await client.query(
    `
    SELECT relation_name, to_regclass(relation_name) AS regclass
    FROM unnest($1::text[]) AS relation_name
    ORDER BY relation_name
    `,
    [REQUIRED_RELATIONS],
  );

  const missing = result.rows
    .filter((row) => !row.regclass)
    .map((row) => row.relation_name);

  if (missing.length > 0) {
    throw new Error(`Missing required DB relations: ${missing.join(', ')}`);
  }

  return result.rowCount;
}

async function assertSetSessionUserExists(client) {
  const result = await client.query(
    "SELECT to_regprocedure('public.set_session_user(bigint)') AS function_name",
  );

  if (!result.rows[0]?.function_name) {
    throw new Error('Missing required function public.set_session_user(bigint)');
  }
}

async function assertOrdersViewGuard(client) {
  const result = await client.query(
    "SELECT pg_get_viewdef('public.orders_view'::regclass, true) AS viewdef",
  );
  const viewDefinition = String(result.rows[0]?.viewdef || '').toLowerCase();

  if (!viewDefinition.includes('2147483647') || !viewDefinition.includes('bigint')) {
    throw new Error('orders_view.order_name_numeric overflow guard is missing');
  }
}

async function assertOrdersViewDefaultSort(client) {
  const result = await client.query(`
    SELECT order_id, order_name, order_name_numeric
    FROM orders_view
    ORDER BY order_date DESC NULLS LAST, order_name_numeric DESC NULLS LAST
    LIMIT 10
  `);

  return result.rowCount;
}

async function countLongDigitOrderNames(client) {
  const result = await client.query(`
    WITH digits AS (
      SELECT regexp_replace(COALESCE(order_name, ''), '\\D', '', 'g') AS value
      FROM orders
      WHERE delete_flag = false
    )
    SELECT COUNT(*)::int AS count
    FROM digits
    WHERE value <> ''
      AND (length(value) > 10 OR value::numeric > 2147483647)
  `);

  return Number(result.rows[0]?.count || 0);
}

async function runTransactionalOverflowProbe(client) {
  await client.query('BEGIN');
  try {
    const orderResult = await client.query(`
      SELECT order_id, created_by
      FROM orders
      WHERE delete_flag = false
      ORDER BY order_id DESC
      LIMIT 1
    `);

    const order = orderResult.rows[0];
    if (!order) {
      await client.query('ROLLBACK');
      return 'skipped; no active orders';
    }

    const userResult = await client.query(
      `
      SELECT COALESCE(
        $1::bigint,
        (SELECT user_id FROM users WHERE is_active = true ORDER BY user_id LIMIT 1),
        (SELECT user_id FROM users ORDER BY user_id LIMIT 1)
      ) AS user_id
      `,
      [order.created_by],
    );
    const userId = userResult.rows[0]?.user_id;
    if (!userId) {
      throw new Error('Cannot resolve a user id for set_session_user()');
    }

    await client.query('SELECT set_session_user($1)', [userId]);
    await client.query('UPDATE orders SET order_name = $1 WHERE order_id = $2', [
      'Тест_202605032013183',
      order.order_id,
    ]);

    const viewResult = await client.query(
      `
      SELECT order_name_numeric
      FROM orders_view
      WHERE order_id = $1
      `,
      [order.order_id],
    );

    if (viewResult.rows[0]?.order_name_numeric !== null) {
      throw new Error('orders_view overflow probe did not return NULL for long numeric order_name');
    }

    await client.query('ROLLBACK');
    return 'ok';
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Ignore rollback errors and report the original failure.
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(`DB cutover readiness smoke failed: ${error.message}`);
  process.exit(1);
});
