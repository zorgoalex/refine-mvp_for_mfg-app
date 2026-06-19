/**
 * CRM-sync backfill entrypoint — run with tsx:
 *   npx tsx scripts/crm-sync-backfill.ts [--dry-run]
 *
 * Refuses to run unless BACKEND_ENABLE_TWENTY_SYNC=true.
 * Never prints secrets.
 */
import { Pool } from 'pg';
import type { QueryResult, QueryResultRow } from 'pg';
import { PgCrmSourceRepository } from '../src/modules/crm-sync/adapters/pg-crm-source-repository';
import { PgCrmSyncMappingRepository } from '../src/modules/crm-sync/adapters/pg-crm-sync-mapping-repository';
import { TwentySyncConsumer } from '../src/modules/crm-sync/application/twenty-sync-consumer';
import { TwentyApiClient, NoopTwentyApiClient } from '../src/modules/crm-sync/adapters/twenty-api-client';
import { AuditService } from '../src/common/audit/audit.service';
import { runBackfill } from '../src/modules/crm-sync/application/crm-sync-backfill';
import type { TransactionClient } from '../src/database/database.types';
import type { DatabaseService } from '../src/database/database.service';
import type { SyncIntent } from '../src/modules/crm-sync/application/twenty-sync-consumer';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// ---------------------------------------------------------------------------
// Feature flag guard
// ---------------------------------------------------------------------------
const enabled = process.env.BACKEND_ENABLE_TWENTY_SYNC === 'true';
if (!enabled) {
  process.stderr.write(
    '[crm-sync-backfill] ERROR: BACKEND_ENABLE_TWENTY_SYNC is not set to "true". ' +
    'Set it before running the backfill.\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Validate Twenty credentials (required even for dry-run)
// ---------------------------------------------------------------------------
const baseUrl = process.env.TWENTY_SYNC_BASE_URL ?? null;
const apiKey = process.env.TWENTY_SYNC_API_KEY ?? null;

if (!dryRun && (!baseUrl || !apiKey)) {
  process.stderr.write(
    '[crm-sync-backfill] ERROR: TWENTY_SYNC_BASE_URL and TWENTY_SYNC_API_KEY must be set ' +
    'for a live (non-dry-run) backfill.\n',
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
const batchSize = Number(process.env.BACKEND_TWENTY_SYNC_BATCH_SIZE ?? '100');

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
} as unknown as DatabaseService;

// ---------------------------------------------------------------------------
// Construct domain objects
// ---------------------------------------------------------------------------
const source = new PgCrmSourceRepository(dbShim);
const mapping = new PgCrmSyncMappingRepository();
const audit = new AuditService();

const twenty = dryRun
  ? new NoopTwentyApiClient((msg) => console.log(msg))
  : new TwentyApiClient(baseUrl!, apiKey!);  // credentials validated above

const consumer = new TwentySyncConsumer({ source, twenty, mapping, db: dbShim });

// ---------------------------------------------------------------------------
// Persist helper (mirrors relay's per-intent short-tx pattern)
// ---------------------------------------------------------------------------
async function persist(intents: SyncIntent[]): Promise<void> {
  if (!intents.length) return; // skip empty tx
  await dbShim.transaction(async (tx) => {
    for (const intent of intents) {
      await mapping.upsertSuccess(tx, intent.mapping);
      await audit.record(tx, intent.audit);
    }
  });
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(
    `[crm-sync-backfill] Starting${dryRun ? ' (DRY RUN — no DB or Twenty writes)' : ''}...`,
  );

  const result = await runBackfill({ source, consumer, persist, batchSize, dryRun });

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
