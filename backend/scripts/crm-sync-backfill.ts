/**
 * CRM-sync backfill entrypoint — run with tsx:
 *   npx tsx scripts/crm-sync-backfill.ts --scope clients|all [--dry-run|--restart]
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
import { PgCrmSyncBackfillCheckpointRepository } from '../src/modules/crm-sync/adapters/pg-crm-sync-backfill-checkpoint-repository';
import { PgCrmSyncBackfillPersistence } from '../src/modules/crm-sync/adapters/pg-crm-sync-backfill-persistence';
import { Bitrix24SyncConsumer } from '../src/modules/crm-sync/application/bitrix24-sync-consumer';
import { Bitrix24ApiClient, NoopBitrix24ApiClient } from '../src/modules/crm-sync/adapters/bitrix24-api-client';
import { AuditService } from '../src/common/audit/audit.service';
import {
  runBackfill,
  type BackfillCheckpoint,
} from '../src/modules/crm-sync/application/crm-sync-backfill';
import type { TransactionClient } from '../src/database/database.types';
import type { DatabaseService } from '../src/database/database.service';
import {
  assertBitrix24BackfillTiming,
  resolveBitrix24Config,
} from './crm-sync-backfill-creds';
import {
  BackfillInterruptedError,
  interruptibleSleep,
  parseBackfillCliOptions,
} from './crm-sync-backfill-options';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let cliOptions: ReturnType<typeof parseBackfillCliOptions>;
try {
  cliOptions = parseBackfillCliOptions(args);
} catch (error) {
  process.stderr.write(
    `[crm-sync-backfill] ERROR: ${error instanceof Error ? error.message : String(error)}\n` +
    'Usage: npm run crm-sync:backfill -- --scope clients|all ' +
    '[--dry-run|--restart] [--progress-every N]\n',
  );
  process.exit(1);
}
const { dryRun, restart, scope, progressEvery } = cliOptions;

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
    '[crm-sync-backfill] ERROR: invalid live Bitrix24 configuration. Check the HTTPS ' +
    'webhook, payment-system ID, timeout, rate and retry settings.\n',
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
if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > 1000) {
  process.stderr.write(
    '[crm-sync-backfill] ERROR: BACKEND_BITRIX24_SYNC_BATCH_SIZE ' +
    'must be an integer from 1 to 1000.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Build pg pool + minimal DatabaseService shim
// ---------------------------------------------------------------------------
const pool = new Pool({ connectionString: databaseUrl });
const stopController = new AbortController();
let stopRequested = false;
let receivedSignal: NodeJS.Signals | null = null;
let lastCommittedCheckpoint: BackfillCheckpoint | null = null;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    receivedSignal = signal;
    stopRequested = true;
    stopController.abort();
    process.stderr.write(
      `[crm-sync-backfill] ${signal}: stopping safely after current operation...\n`,
    );
  });
}

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
const checkpoints = new PgCrmSyncBackfillCheckpointRepository();
const audit = new AuditService();
const persistence = new PgCrmSyncBackfillPersistence(
  dbShim,
  outbox,
  mapping,
  audit,
  checkpoints,
);

const effectiveConfig = bitrixConfig ?? {
  webhookUrl: 'https://dry-run.invalid/rest/1/token',
  paySystemId: 1,
  currencyId: 'KZT',
  assignedById: null,
  erpBaseUrl: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173',
  requestTimeoutMs: 30_000,
  maxRequestsPerSecond: 2,
  limitRetryMaxAttempts: 11,
  queryLimitBaseDelayMs: 1000,
  operationLimitFallbackDelayMs: 60000,
};
const bitrix = dryRun
  ? new NoopBitrix24ApiClient((msg) => console.log(msg))
  : new Bitrix24ApiClient(
    effectiveConfig.webhookUrl,
    undefined,
    effectiveConfig.requestTimeoutMs,
    {
      maxRequestsPerSecond: effectiveConfig.maxRequestsPerSecond,
      limitRetryMaxAttempts: effectiveConfig.limitRetryMaxAttempts,
      queryLimitBaseDelayMs: effectiveConfig.queryLimitBaseDelayMs,
      operationLimitFallbackDelayMs: effectiveConfig.operationLimitFallbackDelayMs,
      sleep: (delayMs) => interruptibleSleep(delayMs, stopController.signal),
      onLimitRetry: ({ method, code, attempt, maxAttempts, delayMs }) => {
        console.warn(
          `[crm-sync-backfill] Bitrix limit method=${method} code=${code} ` +
          `attempt=${attempt}/${maxAttempts} delayMs=${delayMs}`,
        );
      },
    },
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
// Run
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(
    `[crm-sync-backfill] Starting scope=${scope} ` +
    `mode=${dryRun ? 'dry-run' : restart ? 'restart' : 'resume'} ` +
    `rate=${effectiveConfig.maxRequestsPerSecond}/s ` +
    `limitAttempts=${effectiveConfig.limitRetryMaxAttempts}`,
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
      let checkpoint: BackfillCheckpoint | null = null;
      if (writerToken) {
        await assertOwnership?.();
        if (restart) {
          await persistence.reset(writerToken, scope);
          console.log(`[crm-sync-backfill] Reset checkpoint scope=${scope}`);
        }
        checkpoint = await checkpoints.load(dbShim, scope);
        lastCommittedCheckpoint = checkpoint;
        console.log(
          checkpoint
            ? `[crm-sync-backfill] Resume ${formatCheckpoint(checkpoint)}`
            : `[crm-sync-backfill] Fresh checkpoint scope=${scope}`,
        );
      }

      return await runBackfill({
        source,
        consumer,
        persist: async (intents, nextCheckpoint) => {
          if (!writerToken) {
            throw new Error('live backfill persistence requires a writer token');
          }
          await persistence.persist(writerToken, intents, nextCheckpoint);
        },
        batchSize,
        dryRun,
        scope,
        checkpoint,
        assertOwnership,
        shouldStop: () => stopRequested,
        onProgress: (progress) => {
          if (progress.committed) {
            lastCommittedCheckpoint = progress.checkpoint;
          }
          const total =
            progress.checkpoint.processedClients +
            progress.checkpoint.processedOrders;
          if (progress.kind !== 'record' || total % progressEvery === 0) {
            console.log(
              `[crm-sync-backfill] Progress kind=${progress.kind} ` +
              `${formatCheckpoint(progress.checkpoint)}` +
              `${progress.committed ? '' : ' dry-run'}`,
            );
          }
        },
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

  if (result.alreadyCompleted) {
    console.log(
      `[crm-sync-backfill] Scope ${scope} already completed. ` +
      'Use --restart for a fresh full pass.',
    );
  }
  if (result.interrupted) {
    console.log(
      `[crm-sync-backfill] Interrupted safely at ${formatCheckpoint(result.checkpoint)}. ` +
      'Rerun the same command to resume.',
    );
    return;
  }
  console.log(
    `[crm-sync-backfill] Done. clients=${result.clients} orders=${result.orders}${dryRun ? ' (dry-run)' : ''}`,
  );
}

main()
  .then(() => {
    if (receivedSignal) {
      process.exitCode = receivedSignal === 'SIGINT' ? 130 : 143;
    }
  })
  .catch((err: unknown) => {
    const interrupted = stopRequested || err instanceof BackfillInterruptedError;
    process.stderr.write(
      interrupted
        ? `[crm-sync-backfill] Interrupted. Last committed: ` +
          `${lastCommittedCheckpoint ? formatCheckpoint(lastCommittedCheckpoint) : 'none'}. ` +
          'Rerun the same command to resume.\n'
        : `[crm-sync-backfill] FATAL: ${err instanceof Error ? err.message : String(err)}\n` +
          `[crm-sync-backfill] Last committed: ` +
          `${lastCommittedCheckpoint ? formatCheckpoint(lastCommittedCheckpoint) : 'none'}. ` +
          'Rerun the same command to resume.\n',
    );
    process.exitCode = interrupted
      ? receivedSignal === 'SIGTERM' ? 143 : 130
      : 1;
  })
  .finally(() => pool.end());

function formatCheckpoint(checkpoint: BackfillCheckpoint): string {
  return `scope=${checkpoint.scope} phase=${checkpoint.phase} ` +
    `clientCursor=${checkpoint.lastClientId ?? '-'} ` +
    `orderCursor=${checkpoint.lastOrderId ?? '-'} ` +
    `clients=${checkpoint.processedClients} orders=${checkpoint.processedOrders}`;
}
