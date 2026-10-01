import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../common/audit/audit.service';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { PgBitrix24ReverseRepository, type ReversePaymentSnapshot } from './pg-bitrix24-reverse-repository';

// Committed fixtures and a retention function that prunes database-wide: this suite runs ONLY
// against an owned disposable database with migration 226 applied. The URL must opt in via
// ERP_BITRIX_RACE_DATABASE_URL, the database name must start with "bitrix_race_", and the runner
// drops the database afterwards. Nothing here must ever point at a shared stage DB.
const url = process.env.ERP_BITRIX_RACE_DATABASE_URL;
const targetEnv = process.env.ERP_BITRIX_RACE_TARGET_ENV;

function assertOwnedTarget(): void {
  expect(targetEnv).toBe('backend-test');
  const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
  if (!dbName.startsWith('bitrix_race_')) {
    throw new Error(
      `ERP_BITRIX_RACE_DATABASE_URL must point at an owned disposable "bitrix_race_*" database (got "${dbName}")`,
    );
  }
}

/** Real BEGIN/COMMIT transactions on the suite's single connection. */
class CommittedDatabase extends DatabaseService {
  readonly tx: TransactionClient;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 15000 }), {} as never);
    this.tx = { raw: client, query: this.query.bind(this) };
  }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    try {
      const result = await handler(this.tx);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

const ORDER_RECONCILE = 'bitrix24_reverse.order_payments_reconcile';
const REQUEST_RECONCILE = 'bitrix24_reverse.request_payments_reconcile';
const RETENTION_PRUNED = 'bitrix24_reverse.reconcile_retention_pruned';

describe.skipIf(!url)('Bitrix24 reconcile retention on an owned disposable PostgreSQL', () => {
  let pool: Pool;
  let conn: PoolClient | undefined;
  let repo: PgBitrix24ReverseRepository;
  let actorId: number;
  let clientId: number;
  let projectId: number;
  let contactBitrixId: string;
  const tag = 'E2E-retention-' + randomUUID();

  beforeAll(async () => {
    assertOwnedTarget();
    pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    conn = await pool.connect();
    repo = new PgBitrix24ReverseRepository(new CommittedDatabase(conn), new AuditService());
    actorId = Number((await conn.query(
      `INSERT INTO users (username,email,password_hash,role_id) VALUES ($1,$2,'E2E-NO-LOGIN',1) RETURNING user_id`,
      [tag, tag + '@example.invalid'],
    )).rows[0].user_id);
    await conn.query('SELECT set_config($1,$2,false)', ['app.user_id', String(actorId)]);
    await conn.query('SELECT set_config($1,$2,false)', [
      'hasura.user',
      JSON.stringify({ 'x-hasura-user-id': String(actorId), 'x-hasura-role': 'admin' }),
    ]);
    clientId = Number((await conn.query(
      'INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag],
    )).rows[0].client_id);
    projectId = Number((await conn.query(
      'INSERT INTO projects (code,name,client_id,created_by) VALUES ($1,$2,$3,$4) RETURNING project_id',
      ['E2E-' + randomUUID().replace(/-/g, '').slice(0, 12), tag, clientId, actorId],
    )).rows[0].project_id);
    contactBitrixId = String(clientId + 900000000);
    await conn.query(
      `INSERT INTO crm_sync_mapping (entity_type,erp_id,bitrix_object,bitrix_id,status,source_system)
       VALUES ('client',$1,'contact',$2,'active','bitrix24')`,
      [String(clientId), contactBitrixId],
    );
    await conn.query(
      `INSERT INTO bitrix24_app_installation
         (member_id, domain, access_token_ciphertext, refresh_token_ciphertext,
          access_token_expires_at, application_token_hash)
       VALUES ($1,'mebelkz.bitrix24.kz','synthetic','synthetic','2030-01-01',$2)`,
      [tag, 'c'.repeat(64)],
    );
  });

  afterAll(async () => {
    try { conn?.release(); } catch { /* already released */ }
    await pool?.end().catch(() => undefined);
  });

  async function createOrder(kind: 'crm_request' | 'production_order'): Promise<{ orderId: number; dealId: string }> {
    // A production order must own a detail or a catalogue line (deferred aggregate trigger); the
    // payment reconcile under test never reads them, so the bare header skips that trigger.
    if (kind === 'production_order') await conn!.query('SET session_replication_role = replica');
    const inserted = await conn!.query(
      `INSERT INTO orders (order_name,client_id,order_kind,source_system,order_status_id,payment_status_id,created_by,manager_id,production_status_from_details_enabled,planned_completion_date,project_id)
       VALUES ($1,$2,$3,'bitrix24',1,1,$4,$4,false,'2099-09-20',$5) RETURNING order_id`,
      [`${tag}-${kind}`, clientId, kind, actorId, kind === 'production_order' ? projectId : null],
    ).finally(() => conn!.query('SET session_replication_role = origin'));
    const orderId = Number(inserted.rows[0].order_id);
    const dealId = String(orderId + 900000000);
    await conn!.query(
      `INSERT INTO crm_sync_mapping (entity_type,erp_id,bitrix_object,bitrix_id,status,source_system)
       VALUES ('order',$1,'deal',$2,'active','bitrix24')`,
      [String(orderId), dealId],
    );
    return { orderId, dealId };
  }

  const payment = (id: number, overrides: Partial<ReversePaymentSnapshot> = {}): ReversePaymentSnapshot => ({
    bitrixPaymentId: String(id),
    paySystemId: null, paySystemName: 'E2E-retention',
    amount: 500, currencyId: 'KZT', paid: true,
    paymentDate: new Date('2026-09-25T12:00:00+05:00'),
    bitrixCreatedAt: new Date('2026-09-25T10:00:00+03:00'),
    bitrixUpdatedAt: new Date('2026-09-25T12:00:00+03:00'),
    normalizedHash: `hash-${id}`,
    ...overrides,
  });

  async function reconcileAudit(requestId: string) {
    const rows = (await conn!.query<{
      before_json: unknown; after_json: unknown; metadata_json: unknown;
    }>('SELECT before_json, after_json, metadata_json FROM audit_log WHERE request_id=$1', [requestId])).rows;
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  describe('writer marks whether the reconcile changed stored payments', () => {
    it('request reconcile: new, re-read, author-only change, removal', async () => {
      const { orderId, dealId } = await createOrder('crm_request');
      const requestId = Number((await conn!.query(
        `INSERT INTO bitrix24_incoming_request (bitrix_deal_id,title,bitrix_url,state,linked_order_id,client_id,counterparty_object_type,counterparty_bitrix_id)
         VALUES ($1,$2,'https://example.invalid/E2E','active',$3,$4,'contact',$5) RETURNING request_id`,
        [dealId, tag, orderId, clientId, contactBitrixId],
      )).rows[0].request_id);
      const paymentId = orderId + 910000000;
      const run = async (payments: ReversePaymentSnapshot[]) => {
        const auditRequestId = `${tag}:request:${randomUUID()}`;
        const fence = await repo.getPaymentSyncFence(dealId);
        expect((await repo.replaceRequestPaymentSnapshots(requestId, payments, auditRequestId, undefined, fence)).applied).toBe(true);
        return reconcileAudit(auditRequestId);
      };

      expect(await run([payment(paymentId)])).toEqual({
        before_json: { activePaymentCount: 0, activePaymentAmount: 0 },
        after_json: { activePaymentCount: 1, activePaymentAmount: 500 },
        metadata_json: { changed: true },
      });
      expect(await run([payment(paymentId)])).toEqual({
        before_json: { activePaymentCount: 1, activePaymentAmount: 500 },
        after_json: { activePaymentCount: 1, activePaymentAmount: 500 },
        metadata_json: { changed: false },
      });
      // Same id, hash, count and amount — only the payment author changed in Bitrix24.
      const authored = payment(paymentId, { paidById: '77', paidByName: 'E2E Автор' });
      expect((await run([authored])).metadata_json).toEqual({ changed: true });
      expect((await run([authored])).metadata_json).toEqual({ changed: false });
      expect(await run([])).toEqual({
        before_json: { activePaymentCount: 1, activePaymentAmount: 500 },
        after_json: { activePaymentCount: 0, activePaymentAmount: 0 },
        metadata_json: { changed: true },
      });
      expect((await run([])).metadata_json).toEqual({ changed: false });
    });

    it('mapped order reconcile: new, re-read, changed hash', async () => {
      const { orderId, dealId } = await createOrder('production_order');
      const paymentId = orderId + 920000000;
      const run = async (payments: ReversePaymentSnapshot[]) => {
        const auditRequestId = `${tag}:order:${randomUUID()}`;
        const fence = await repo.getPaymentSyncFence(dealId);
        expect((await repo.replaceMappedOrderPaymentSnapshots(
          orderId, payments, auditRequestId, undefined, dealId, fence,
        )).applied).toBe(true);
        return reconcileAudit(auditRequestId);
      };

      expect(await run([])).toEqual({
        before_json: { activePaymentCount: 0, activePaymentAmount: 0 },
        after_json: { activePaymentCount: 0, activePaymentAmount: 0 },
        metadata_json: { changed: false },
      });
      expect((await run([payment(paymentId)])).metadata_json).toEqual({ changed: true });
      expect((await run([payment(paymentId)])).metadata_json).toEqual({ changed: false });
      expect((await run([payment(paymentId, { normalizedHash: 'hash-other' })])).metadata_json).toEqual({ changed: true });
    });
  });

  describe('prune_bitrix24_reconcile_noise', () => {
    interface Scenario {
      kept: string[];
      removed: string[];
      keptEvents: string[];
      removedEvents: string[];
    }

    async function insertAudit(input: {
      event: string; entityId: string; daysAgo: number; after: Record<string, number>;
      metadata?: Record<string, unknown>; requestId?: string;
    }): Promise<string> {
      return (await conn!.query<{ audit_id: string }>(
        `INSERT INTO audit_log (event, entity_type, entity_id, request_id, source, after_json, metadata_json, created_at)
         VALUES ($1,'order',$2,$3,'bitrix24',$4::jsonb,$5::jsonb, now() - make_interval(days => $6::int))
         RETURNING audit_id`,
        [input.event, input.entityId, input.requestId ?? randomUUID(), JSON.stringify(input.after),
          input.metadata ? JSON.stringify(input.metadata) : null, input.daysAgo],
      )).rows[0].audit_id;
    }

    let nextBitrixId = 1;
    async function insertInbound(input: {
      id?: string; eventName?: string; source?: string | null; status?: string; daysAgo: number; scope: string;
    }): Promise<string> {
      const id = input.id ?? randomUUID();
      const status = input.status ?? 'processed';
      await conn!.query(
        `INSERT INTO bitrix24_inbound_event
           (inbound_event_id, member_id, event_name, object_type, bitrix_id, event_ts, payload_json,
            fingerprint, status, created_at, processed_at)
         VALUES ($1,$2,$3,'deal',$4, now(), $5::jsonb, $6, $7,
                 now() - make_interval(days => $8::int),
                 CASE WHEN $7 = 'processed' THEN now() - make_interval(days => $8::int) END)`,
        [id, tag, input.eventName ?? 'BITRIX24_RECONCILE_DEAL', String(nextBitrixId++),
          JSON.stringify(input.source === null ? {} : { source: input.source ?? 'scheduled-reconcile' }),
          `${input.scope}:${id}`, status, input.daysAgo],
      );
      return id;
    }

    /** One full set of cases under its own entity ids, so each test prunes a fresh copy. */
    async function seedScenario(scope: string): Promise<Scenario> {
      const kept: string[] = [];
      const removed: string[] = [];
      const keptEvents: string[] = [];
      const removedEvents: string[] = [];
      const zero = { activePaymentCount: 0, activePaymentAmount: 0 };
      const one = { activePaymentCount: 1, activePaymentAmount: 100 };
      const two = { activePaymentCount: 2, activePaymentAmount: 200 };
      const entity = (name: string) => `${scope}-${name}`;

      // Unmarked records: the baseline and every change stay, repeats go.
      const a2Event = randomUUID();
      const a3Event = randomUUID();
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('A'), daysAgo: 30, after: zero }));
      removed.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('A'), daysAgo: 29, after: zero, requestId: a2Event }));
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('A'), daysAgo: 28, after: one, requestId: a3Event }));
      removed.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('A'), daysAgo: 27, after: one }));
      // Marked records: `true` always stays, `false` with an unchanged state goes.
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('A'), daysAgo: 26, after: one, metadata: { changed: true } }));
      removed.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('A'), daysAgo: 25, after: one, metadata: { changed: false } }));

      // Mixed deploy / rollback: a state produced by another writer is first seen by a marked
      // `changed: false` record, then an unmarked record changes it back. Both must survive every
      // number of passes, or the second change would be compared with the baseline and lost.
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('B'), daysAgo: 30, after: one }));
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('B'), daysAgo: 29, after: two, metadata: { changed: false } }));
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('B'), daysAgo: 28, after: one }));
      removed.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('B'), daysAgo: 27, after: one, metadata: { changed: false } }));

      // Inside the retention window nothing is touched, changed or not.
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('C'), daysAgo: 8, after: zero }));
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('C'), daysAgo: 6, after: zero }));
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('C'), daysAgo: 1, after: zero, metadata: { changed: false } }));

      // The request reconcile event follows the same rule in its own partition.
      kept.push(await insertAudit({ event: REQUEST_RECONCILE, entityId: entity('A'), daysAgo: 20, after: zero }));
      removed.push(await insertAudit({ event: REQUEST_RECONCILE, entityId: entity('A'), daysAgo: 19, after: zero }));

      // Any other audit event is out of scope, however repetitive.
      kept.push(await insertAudit({ event: 'bitrix24_reverse.deal_state_upsert', entityId: entity('A'), daysAgo: 30, after: zero }));
      kept.push(await insertAudit({ event: 'bitrix24_reverse.deal_state_upsert', entityId: entity('A'), daysAgo: 29, after: zero }));

      // A repeat that a CAD event references stays (that foreign key has no cascade).
      kept.push(await insertAudit({ event: ORDER_RECONCILE, entityId: entity('D'), daysAgo: 30, after: zero }));
      const referenced = await insertAudit({ event: ORDER_RECONCILE, entityId: entity('D'), daysAgo: 29, after: zero });
      kept.push(referenced);
      await conn!.query(
        `INSERT INTO cad_events (id, event, entity_id, request_id, audit_id, metadata)
         VALUES ($1, 'E2E.retention', $2, $3, $4, '{}'::jsonb)`,
        [randomUUID(), entity('D'), randomUUID(), referenced],
      );

      // Queue events: only processed scheduled reconciles without a remaining audit row go.
      removedEvents.push(await insertInbound({ id: a2Event, daysAgo: 29, scope }));
      keptEvents.push(await insertInbound({ id: a3Event, daysAgo: 28, scope }));
      removedEvents.push(await insertInbound({ daysAgo: 30, scope }));
      keptEvents.push(await insertInbound({ daysAgo: 1, scope }));
      keptEvents.push(await insertInbound({ daysAgo: 30, status: 'pending', scope }));
      keptEvents.push(await insertInbound({ daysAgo: 30, status: 'dead', scope }));
      keptEvents.push(await insertInbound({ daysAgo: 30, source: 'product-mapping', scope }));
      keptEvents.push(await insertInbound({ daysAgo: 30, eventName: 'ONCRMDEALUPDATE', source: null, scope }));
      return { kept, removed, keptEvents, removedEvents };
    }

    async function expectScenario(scenario: Scenario): Promise<void> {
      const audit = (await conn!.query<{ audit_id: string }>(
        'SELECT audit_id FROM audit_log WHERE audit_id = ANY($1::uuid[])',
        [[...scenario.kept, ...scenario.removed]],
      )).rows.map((row) => row.audit_id).sort();
      expect(audit).toEqual([...scenario.kept].sort());
      const events = (await conn!.query<{ inbound_event_id: string }>(
        'SELECT inbound_event_id FROM bitrix24_inbound_event WHERE inbound_event_id = ANY($1::uuid[])',
        [[...scenario.keptEvents, ...scenario.removedEvents]],
      )).rows.map((row) => row.inbound_event_id).sort();
      expect(events).toEqual([...scenario.keptEvents].sort());
    }

    const prune = async (batch: number | null) => (await conn!.query<{ audit_deleted: string; inbound_deleted: string }>(
      `SELECT audit_deleted, inbound_deleted
         FROM prune_bitrix24_reconcile_noise(now() - interval '7 days', $1::int)`,
      [batch],
    )).rows.map((row) => ({ audit: Number(row.audit_deleted), inbound: Number(row.inbound_deleted) }))[0];

    it('one pass keeps the last week, the marked records and every change; a second pass removes nothing', async () => {
      const scenario = await seedScenario(`${tag}-full`);
      expect(await prune(null)).toEqual({ audit: scenario.removed.length, inbound: scenario.removedEvents.length });
      await expectScenario(scenario);
      expect(await prune(null)).toEqual({ audit: 0, inbound: 0 });
      await expectScenario(scenario);
    });

    it('single-row batches converge to the same set as one pass', async () => {
      const scenario = await seedScenario(`${tag}-batched`);
      let audit = 0;
      let inbound = 0;
      for (let pass = 0; pass < 50; pass += 1) {
        const pruned = await prune(1);
        expect(pruned.audit).toBeLessThanOrEqual(1);
        expect(pruned.inbound).toBeLessThanOrEqual(1);
        audit += pruned.audit;
        inbound += pruned.inbound;
        if (pruned.audit === 0 && pruned.inbound === 0) break;
      }
      expect({ audit, inbound }).toEqual({ audit: scenario.removed.length, inbound: scenario.removedEvents.length });
      await expectScenario(scenario);
      expect(await prune(null)).toEqual({ audit: 0, inbound: 0 });
    });

    it('rejects a missing cutoff and a non-positive batch', async () => {
      await expect(conn!.query('SELECT * FROM prune_bitrix24_reconcile_noise(NULL, 10)')).rejects.toThrow(/cutoff is required/);
      await expect(conn!.query('SELECT * FROM prune_bitrix24_reconcile_noise(now(), 0)')).rejects.toThrow(/batch must be positive/);
    });

    it('the migration audited its own one-time cleanup', async () => {
      const rows = (await conn!.query<{ metadata_json: Record<string, unknown>; source: string; entity_type: string }>(
        `SELECT metadata_json, source, entity_type FROM audit_log WHERE event=$1 AND request_id='migration:226'`,
        [RETENTION_PRUNED],
      )).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ source: 'bitrix24', entity_type: 'audit_retention' });
      expect(rows[0].metadata_json).toMatchObject({
        trigger: 'migration', completed: true, retentionDays: 7, auditDeleted: 0, inboundDeleted: 0,
      });
    });

    it('an interrupted migration cleanup leaves every committed removal audited; the rerun completes once', async () => {
      // The real cleanup block of the migration, with a two-row batch so the scenario spans
      // several committed batches, and an optional failure right after the first one.
      const migration = readFileSync(
        resolve(__dirname, '../../../../db/migrations/226_bitrix24_reconcile_retention.sql'), 'utf8',
      );
      const cleanup = migration.slice(migration.indexOf('\nCOMMIT;\n') + '\nCOMMIT;\n'.length)
        .replace(/^\s*--.*$/gm, '')
        .replace('v_batch CONSTANT INTEGER := 200000;', 'v_batch CONSTANT INTEGER := 2;');
      expect(cleanup).toContain('v_batch CONSTANT INTEGER := 2;');
      const interrupted = cleanup.replace(
        /(END IF;\s+COMMIT;)/,
        "$1\n    RAISE EXCEPTION 'E2E-interrupt after the first committed batch';",
      );
      expect(interrupted).not.toBe(cleanup);

      const scenario = await seedScenario(`${tag}-interrupted`);
      const audited = async () => (await conn!.query<{ request_id: string; metadata_json: Record<string, unknown> }>(
        `SELECT request_id, metadata_json FROM audit_log
          WHERE event=$1 AND metadata_json ->> 'trigger' = 'migration'`,
        [RETENTION_PRUNED],
      )).rows;
      const batchRows = (rows: Awaited<ReturnType<typeof audited>>) => rows.filter((row) => row.request_id !== 'migration:226');
      const completions = (rows: Awaited<ReturnType<typeof audited>>) => rows.filter((row) => row.request_id === 'migration:226');
      const sum = (rows: Awaited<ReturnType<typeof audited>>, key: string) =>
        rows.reduce((total, row) => total + Number(row.metadata_json[key]), 0);
      const leftOf = async (ids: string[], table: 'audit_log' | 'bitrix24_inbound_event') => Number((await conn!.query(
        table === 'audit_log'
          ? 'SELECT count(*) AS n FROM audit_log WHERE audit_id = ANY($1::uuid[])'
          : 'SELECT count(*) AS n FROM bitrix24_inbound_event WHERE inbound_event_id = ANY($1::uuid[])',
        [ids],
      )).rows[0].n);
      const before = await audited();
      expect(batchRows(before)).toHaveLength(0);

      await expect(conn!.query(interrupted)).rejects.toThrow(/E2E-interrupt/);
      const afterInterrupt = await audited();
      expect(completions(afterInterrupt)).toHaveLength(completions(before).length);
      expect(batchRows(afterInterrupt)).toHaveLength(1);
      expect(batchRows(afterInterrupt)[0].request_id).toMatch(/^migration:226:[0-9a-f-]{36}:1$/);
      expect(batchRows(afterInterrupt)[0].metadata_json).toMatchObject({ trigger: 'migration', batch: 1, retentionDays: 7 });
      // What the first batch removed is committed and exactly what its audit row says.
      expect(sum(batchRows(afterInterrupt), 'auditDeleted'))
        .toBe(scenario.removed.length - await leftOf(scenario.removed, 'audit_log'));
      expect(sum(batchRows(afterInterrupt), 'inboundDeleted'))
        .toBe(scenario.removedEvents.length - await leftOf(scenario.removedEvents, 'bitrix24_inbound_event'));
      expect(sum(batchRows(afterInterrupt), 'auditDeleted')).toBe(2);

      await conn!.query(cleanup);
      await expectScenario(scenario);
      const afterRerun = await audited();
      expect(sum(batchRows(afterRerun), 'auditDeleted')).toBe(scenario.removed.length);
      expect(sum(batchRows(afterRerun), 'inboundDeleted')).toBe(scenario.removedEvents.length);
      expect(completions(afterRerun)).toHaveLength(completions(before).length + 1);
      const runIds = new Set(batchRows(afterRerun).map((row) => row.metadata_json.runId));
      expect(runIds.size).toBe(2);
      const completed = completions(afterRerun).find((row) => runIds.has(row.metadata_json.runId));
      expect(completed?.metadata_json).toMatchObject({
        completed: true,
        auditDeleted: scenario.removed.length - 2,
        inboundDeleted: scenario.removedEvents.length - sum(batchRows(afterInterrupt), 'inboundDeleted'),
      });
    });

    it('the scheduler path prunes through the repository and audits only a run that removed something', async () => {
      const scenario = await seedScenario(`${tag}-repository`);
      const auditedRuns = async () => (await conn!.query<{ metadata_json: Record<string, unknown>; request_id: string }>(
        `SELECT metadata_json, request_id FROM audit_log
          WHERE event=$1 AND metadata_json ->> 'trigger' = 'scheduler'`,
        [RETENTION_PRUNED],
      )).rows;

      expect(await repo.pruneReconcileNoise({ retentionDays: 7, batchSize: 1000 })).toEqual({
        auditDeleted: scenario.removed.length,
        inboundDeleted: scenario.removedEvents.length,
      });
      await expectScenario(scenario);
      const runs = await auditedRuns();
      expect(runs).toHaveLength(1);
      expect(runs[0].request_id).toMatch(/^bitrix24-reconcile-retention:[0-9a-f-]{36}$/);
      expect(runs[0].metadata_json).toMatchObject({
        trigger: 'scheduler', retentionDays: 7,
        auditDeleted: scenario.removed.length, inboundDeleted: scenario.removedEvents.length,
      });
      expect(Number.isNaN(Date.parse(String(runs[0].metadata_json.cutoff)))).toBe(false);

      expect(await repo.pruneReconcileNoise({ retentionDays: 7, batchSize: 1000 })).toEqual({ auditDeleted: 0, inboundDeleted: 0 });
      expect(await auditedRuns()).toHaveLength(1);
    });
  });
});
