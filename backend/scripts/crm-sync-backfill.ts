/**
 * CRM-sync backfill entrypoint — run with tsx:
 *   npx tsx scripts/crm-sync-backfill.ts [--dry-run]
 *
 * Refuses to run unless BACKEND_ENABLE_BITRIX24_SYNC=true.
 * Never prints secrets.
 */
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { QueryResult, QueryResultRow } from 'pg';
import { PgCrmSourceRepository } from '../src/modules/crm-sync/adapters/pg-crm-source-repository';
import { PgCrmSyncMappingRepository } from '../src/modules/crm-sync/adapters/pg-crm-sync-mapping-repository';
import { PgCrmSyncOutboxRepository } from '../src/modules/crm-sync/adapters/pg-crm-sync-outbox-repository';
import { Bitrix24SyncConsumer } from '../src/modules/crm-sync/application/bitrix24-sync-consumer';
import { Bitrix24ApiClient, NoopBitrix24ApiClient } from '../src/modules/crm-sync/adapters/bitrix24-api-client';
import { AuditService } from '../src/common/audit/audit.service';
import { runBackfill } from '../src/modules/crm-sync/application/crm-sync-backfill';
import type { TransactionClient } from '../src/database/database.types';
import type { DatabaseService } from '../src/database/database.service';
import type { SyncIntent } from '../src/modules/crm-sync/application/bitrix24-sync-consumer';
import {
  assertBitrix24BackfillTiming,
  resolveBitrix24Config,
} from './crm-sync-backfill-creds';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Feature flag guard
// ---------------------------------------------------------------------------
const enabled = process.env.BACKEND_ENABLE_BITRIX24_SYNC === 'true';
if (!enabled) {
  process.stderr.write(
    '[crm-sync-backfill] ERROR: BACKEND_ENABLE_BITRIX24_SYNC is not set to "true". ' +
    'Set it before running the backfill.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate Bitrix24 configuration
// ---------------------------------------------------------------------------
// Trim + treat blank (missing or whitespace-only) as absent so a config typo
// hard-refuses instead of building a live client with an empty bearer token.
const bitrixConfig = resolveBitrix24Config(process.env);

if (!dryRun && !bitrixConfig) {
  process.stderr.write(
    '[crm-sync-backfill] ERROR: HTTPS BITRIX24_WEBHOOK_URL and BITRIX24_PAY_SYSTEM_ID ' +
    'must be set for a live backfill.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database URL
// ---------------------------------------------------------------------------
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write('[crm-sync-backfill] ERROR: DATABASE_URL is not set.\n');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// batchSize from env (mirrors CrmSyncRuntimeConfigService defaults)
// ---------------------------------------------------------------------------
const batchSize = Number(process.env.BACKEND_BITRIX24_SYNC_BATCH_SIZE ?? '100');

// ---------------------------------------------------------------------------
// Build pg pool + minimal DatabaseService shim
// ---------------------------------------------------------------------------
const pool = new Pool({ connectionString: databaseUrl });

/**
 * Minimal DatabaseService shim that wraps the pool.
 * Mirrors the pattern used in integration tests.
 */
const dbShim: DatabaseService = {
  isConfigured: true,
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return pool.query<T>(text, [...params]);
  },
  async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx: TransactionClient = {
        raw: client as never,
        query<T2 extends QueryResultRow = QueryResultRow>(
          text: string,
          params: readonly unknown[] = [],
        ): Promise<QueryResult<T2>> {
          return client.query<T2>(text, [...params]);
        },
      };
      const result = await handler(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // preserve original error
      }
      throw err;
    } finally {
      client.release();
    }
  },
  async withAdvisoryLock<T>(
    key: string,
    handler: (assertOwned: () => Promise<void>) => Promise<T>,
  ): Promise<T | null> {
    const client = await pool.connect();
    const acquired = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [key],
    );
    if (!acquired.rows[0]?.acquired) {
      client.release();
      return null;
    }
    try {
      return await handler(async () => {
        await client.query('SELECT 1');
      });
    } finally {
      await client.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [key],
      ).catch(() => undefined);
      client.release();
    }
  },
} as unknown as DatabaseService;

// ---------------------------------------------------------------------------
// Construct domain objects
// ---------------------------------------------------------------------------
const source = new PgCrmSourceRepository(dbShim);
const mapping = new PgCrmSyncMappingRepository();
const outbox = new PgCrmSyncOutboxRepository();
const audit = new AuditService();

const effectiveConfig = bitrixConfig ?? {
  webhookUrl: 'https://dry-run.invalid/rest/1/token',
  paySystemId: 1,
  currencyId: 'KZT',
  assignedById: null,
  erpBaseUrl: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  requestTimeoutMs: 30_000,
};
const bitrix = dryRun
  ? new NoopBitrix24ApiClient((msg) => console.log(msg))
  : new Bitrix24ApiClient(
    effectiveConfig.webhookUrl,
    undefined,
    effectiveConfig.requestTimeoutMs,
  );

const consumer = new Bitrix24SyncConsumer({
  source,
  bitrix,
  mapping,
  db: dbShim,
  options: effectiveConfig,
  durablePaymentCreates: !dryRun,
});

// ---------------------------------------------------------------------------
// Persist helper (mirrors relay's per-intent short-tx pattern)
// ---------------------------------------------------------------------------
async function persist(intents: SyncIntent[]): Promise<void> {
  if (!intents.length) return; // skip empty tx
  await dbShim.transaction(async (tx) => {
    for (const intent of intents) {
      await mapping.upsertSuccess(tx, intent.mapping);
      await audit.record(tx, intent.audit);
      if (intent.clearPaymentCreateGuardId) {
        await mapping.deletePaymentCreateGuard(
          tx,
          intent.clearPaymentCreateGuardId,
        );
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(
    `[crm-sync-backfill] Starting${dryRun ? ' (DRY RUN — no DB or Bitrix24 writes)' : ''}...`,
  );

  const leaseMs = Number(process.env.BACKEND_BITRIX24_SYNC_LEASE_MS ?? '300000');
  assertBitrix24BackfillTiming(effectiveConfig.requestTimeoutMs, leaseMs);

  const execute = async (
    assertAdvisoryOwned?: () => Promise<void>,
  ): Promise<Awaited<ReturnType<typeof runBackfill>>> => {
    const writerToken = dryRun ? null : randomUUID();
    if (
      writerToken &&
      !await outbox.acquireWriterLock(dbShim, writerToken, leaseMs)
    ) {
      throw new Error('another Bitrix24 relay/backfill writer currently holds the live lock');
    }

    let ownershipLost = false;
    const assertOwnership = writerToken && assertAdvisoryOwned
      ? async () => {
        if (ownershipLost) throw new Error('Bitrix24 writer ownership lost');
        await assertAdvisoryOwned();
        if (!await outbox.heartbeatWriterLock(dbShim, writerToken)) {
          ownershipLost = true;
          throw new Error('Bitrix24 writer ownership lost');
        }
      }
      : undefined;
    const heartbeatTimer = writerToken && assertOwnership
      ? setInterval(
        () => void assertOwnership().catch(() => {
          ownershipLost = true;
        }),
        Math.max(1000, Math.floor(leaseMs / 3)),
      )
      : null;
    heartbeatTimer?.unref();

    try {
      return await runBackfill({
        source,
        consumer,
        persist,
        batchSize,
        dryRun,
        assertOwnership,
      });
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (writerToken) {
        await outbox.releaseWriterLock(dbShim, writerToken).catch(() => undefined);
      }
    }
  };

  const result = dryRun
    ? await execute()
    : await dbShim.withAdvisoryLock(
      'bitrix24-live-writer',
      (assertOwned) => execute(assertOwned),
    );
  if (!result) {
    throw new Error('another Bitrix24 relay/backfill writer owns the advisory lock');
  }

  console.log(
    `[crm-sync-backfill] Done. clients=${result.clients} orders=${result.orders}${dryRun ? ' (dry-run)' : ''}`,
  );
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    process.stderr.write(
      `[crm-sync-backfill] FATAL: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    pool.end().finally(() => process.exit(1));
  });
