/**
 * Application backfill for existing jobs after migration 079 has created the
 * history tables. Run while cut writes are read-only; migration 080 may already
 * be applied because every row written here satisfies its final constraints:
 *   npm run cut-results:backfill
 *   npm run cut-results:backfill -- --validate-only
 *
 * Never prints credentials or row payloads.
 */
import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import type { DatabaseService } from '../src/database/database.service';
import type { TransactionClient } from '../src/database/database.types';
import { PgCutRepository } from '../src/modules/cut/adapters/pg-cut-repository';
import { freecutItemId } from '../src/modules/cut/application/cut-freecut-mapping';
import type { CutJobDto, CutSheetDto } from '../src/modules/cut/dto/cut.dto';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write('[cut-result-backfill] DATABASE_URL is not set\n');
  process.exit(1);
}

const validateOnly = process.argv.slice(2).includes('--validate-only');
const pool = new Pool({ connectionString: databaseUrl });
const db: DatabaseService = {
  isConfigured: true,
  query<T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    return pool.query<T>(text, [...params]);
  },
  async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tx: TransactionClient = {
        raw: client as never,
        query<T2 extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T2>> {
          return client.query<T2>(text, [...params]);
        },
      };
      const value = await handler(tx);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
} as unknown as DatabaseService;

async function validate(): Promise<void> {
  const failures = await db.query<{ issue_count: string | number }>(
    `SELECT (
       (SELECT count(*) FROM cut_job j
        WHERE EXISTS (SELECT 1 FROM cut_group g WHERE g.cut_job_id = j.cut_job_id)
          AND j.current_cut_result_id IS NULL)
       +
       (SELECT count(*) FROM cut_result
        WHERE snapshot_job IS NULL OR snapshot_manifest IS NULL
           OR snapshot_digest IS NULL OR totals_snapshot IS NULL)
       +
       (SELECT count(*) FROM cut_job j
        JOIN cut_result r ON r.cut_result_id = j.current_cut_result_id
        WHERE r.cut_job_id <> j.cut_job_id OR j.next_cut_result_no <= r.result_no)
     ) AS issue_count`,
  );
  const count = Number(failures.rows[0]?.issue_count ?? 0);
  if (count !== 0) throw new Error(`validation failed: ${count} invariant violation(s)`);

  const snapshots = await db.query<{
    cut_result_id: string | number;
    snapshot_job: CutJobDto;
    snapshot_manifest: { groups?: number; items?: number };
    snapshot_digest: string;
    computed_digest: string;
  }>(`SELECT cut_result_id, snapshot_job, snapshot_manifest, snapshot_digest,
             cut_result_snapshot_digest(snapshot_job) AS computed_digest
      FROM cut_result ORDER BY cut_result_id`);
  for (const row of snapshots.rows) {
    const groups = row.snapshot_job.groups ?? [];
    const items = row.snapshot_job.items ?? [];
    if (
      groups.length === 0 || items.length === 0
      || row.snapshot_manifest.groups !== groups.length
      || row.snapshot_manifest.items !== items.length
      || row.computed_digest !== row.snapshot_digest
      || !snapshotStructurallyComplete(row.snapshot_job)
    ) {
      throw new Error(`validation failed: corrupt cut_result_id=${row.cut_result_id}`);
    }
  }
}

function renderComplete(sheet: CutSheetDto): boolean {
  return sheet.renderSnapshot?.contractVersion === 'cut_sheet_render_v1'
    && Object.keys(sheet.renderSnapshot.views ?? {}).length === 12
    && sheet.renderSnapshot.pdfMeta !== null
    && typeof sheet.renderSnapshot.pdfMeta === 'object'
    && Array.isArray(sheet.renderSnapshot.pdfDetailRows)
    && Array.isArray(sheet.placements?.pieces);
}

/** Independent post-backfill probe: do not trust the writer's pre-insert checks. */
function snapshotStructurallyComplete(snapshot: CutJobDto): boolean {
  const expected = new Map(snapshot.items.map((item) => [
    freecutItemId(item.orderDetailId),
    { qty: item.qty, cutGroupId: item.cutGroupId },
  ]));
  const actual = new Map<string, Set<number>>();
  const snapshotGroupIds = new Set(snapshot.groups.map((group) => group.cutGroupId));
  if ([...expected.values()].some((item) => item.cutGroupId === null || !snapshotGroupIds.has(item.cutGroupId))) return false;
  for (const group of snapshot.groups) {
    if (group.sheets.length === 0) return false;
    if (![...expected.values()].some((item) => item.cutGroupId === group.cutGroupId)) return false;
    const auto = new Set<string>();
    for (const sheet of group.sheets) {
      if (!renderComplete(sheet)) return false;
      for (const piece of sheet.placements.pieces) {
        if (!expected.has(piece.item_id) || expected.get(piece.item_id)?.cutGroupId !== group.cutGroupId) return false;
        const key = `${piece.item_id}#${piece.instance}`;
        if (auto.has(key)) return false;
        auto.add(key);
        const instances = actual.get(piece.item_id) ?? new Set<number>();
        if (instances.has(piece.instance)) return false;
        instances.add(piece.instance);
        actual.set(piece.item_id, instances);
      }
    }
    if (group.manualLayout) {
      if (group.manualLayout.sheets.length === 0) return false;
      const manual = new Set<string>();
      for (const sheet of group.manualLayout.sheets) {
        if (!renderComplete(sheet)) return false;
        for (const piece of sheet.placements.pieces) {
          const key = `${piece.item_id}#${piece.instance}`;
          if (!expected.has(piece.item_id) || manual.has(key)) return false;
          manual.add(key);
        }
      }
      if (manual.size !== auto.size || [...auto].some((key) => !manual.has(key))) return false;
    }
  }
  for (const unplaced of snapshot.unplaced ?? []) {
    if (!expected.has(unplaced.itemId)) return false;
    const instances = actual.get(unplaced.itemId) ?? new Set<number>();
    if (instances.has(unplaced.instance)) return false;
    instances.add(unplaced.instance);
    actual.set(unplaced.itemId, instances);
  }
  return [...expected].every(([itemId, item]) => (actual.get(itemId)?.size ?? 0) === item.qty);
}

async function main(): Promise<void> {
  if (!validateOnly) {
    const repository = new PgCutRepository(db, {
      optimize: async () => { throw new Error('Freecut is disabled in history backfill'); },
    });
    let total = 0;
    while (true) {
      const count = await repository.backfillLegacyResults(50);
      total += count;
      if (count === 0) break;
    }
    process.stdout.write(`[cut-result-backfill] backfilled=${total}\n`);
  }
  await validate();
  process.stdout.write('[cut-result-backfill] validation=ok\n');
}

main()
  .then(() => pool.end())
  .catch((error: unknown) => {
    process.stderr.write(`[cut-result-backfill] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    pool.end().finally(() => process.exit(1));
  });
