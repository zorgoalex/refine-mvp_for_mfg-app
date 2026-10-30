import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditService } from '../../../common/audit/audit.service';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { Bitrix24ApiError, type Bitrix24ApiPort } from '../adapters/bitrix24-api-client';
import { PgCrmSourceRepository } from '../adapters/pg-crm-source-repository';
import { PgCrmSyncMappingRepository } from '../adapters/pg-crm-sync-mapping-repository';
import { PgCrmSyncOutboxRepository } from '../adapters/pg-crm-sync-outbox-repository';
import { Bitrix24SyncConsumer, CrmSyncAuditOnlyError } from '../application/bitrix24-sync-consumer';
import { persistSyncIntent } from '../application/persist-sync-intent';
import { PgBitrix24ReverseRepository, type ReverseDealSnapshot } from './pg-bitrix24-reverse-repository';

const url = process.env.ERP_REVERSE_MERGE_TEST_DATABASE_URL;

class FixtureDatabase extends DatabaseService {
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }), {} as never);
  }
  override get isConfigured() { return true; }
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    return this.client.query<T>(sql, [...params]);
  }
  override async transaction<T>(fn: (tx: TransactionClient) => Promise<T>): Promise<T> {
    const tx: TransactionClient = { raw: this.client, query: this.query.bind(this) } as TransactionClient;
    await this.client.query('SAVEPOINT reverse_tx');
    try {
      const result = await fn(tx);
      await this.client.query('RELEASE SAVEPOINT reverse_tx');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT reverse_tx');
      await this.client.query('RELEASE SAVEPOINT reverse_tx');
      throw error;
    }
  }
}

// Reverse sync against a merged client (migration 268, already on the stage schema): two fresh «Тест» clients, the
// merged one keeps its Bitrix contact as an alias of the survivor. One transaction, rolled back at the end.
describe.skipIf(!url)('Bitrix24 reverse / merged client / real PostgreSQL, rollback-only', () => {
  let pool: Pool, client: PoolClient, db: FixtureDatabase, repository: PgBitrix24ReverseRepository;
  let mergedId: number, survivorId: number, actorUserId: number, mergeId: number;
  const contactId = '990000101';
  const one = async <T extends QueryResultRow>(sql: string, params: unknown[] = []) => (await client.query<T>(sql, params)).rows[0];

  const deal = (bitrixId: string, overrides: Partial<ReverseDealSnapshot> = {}): ReverseDealSnapshot => ({
    bitrixId,
    title: 'Тест слияние сделка',
    fullTitle: 'Тест слияние сделка',
    // The processor resolved the contact before the merge: the repository resolves it again under the client key.
    clientId: mergedId,
    counterpartyObjectType: 'contact',
    counterpartyBitrixId: contactId,
    originErpOrderId: null,
    crmAmount: 1000,
    currencyId: 'KZT',
    stageId: 'NEW',
    assignedById: null,
    beginDate: '2099-01-02',
    closeDate: null,
    comments: null,
    bitrixUrl: `https://example.invalid/crm/deal/details/${bitrixId}/`,
    normalizedHash: `it-merge-${bitrixId}`,
    remoteRevision: `it-merge-${bitrixId}`,
    bitrixCreatedAt: new Date('2099-01-02T00:00:00Z'),
    bitrixUpdatedAt: new Date('2099-01-02T00:00:00Z'),
    rawSnapshot: {},
    ...overrides,
  });
  const audits = async (event: string) => (await client.query<{ entity_id: string; related_client_id: string | null; related_order_id: string | null; metadata_json: Record<string, unknown> }>(
    `SELECT entity_id, related_client_id, related_order_id, metadata_json FROM audit_log
      WHERE event=$1 AND entity_id=$2 ORDER BY audit_id`,
    [event, String(mergedId)],
  )).rows;

  const outbound = (bitrix: Record<string, unknown>) => {
    const mappingRepository = new PgCrmSyncMappingRepository();
    const consumer = new Bitrix24SyncConsumer({
      source: new PgCrmSourceRepository(db as never),
      bitrix: {
        withRequestGuard: (_guard: unknown, operation: () => Promise<unknown>) => operation(),
        createCrmItem: async () => { throw new Error('must not create'); },
        findCrmItemByOrigin: async () => { throw new Error('must not search'); },
        deleteCrmItem: async () => { throw new Error('must not delete'); },
        ...bitrix,
      } as unknown as Bitrix24ApiPort,
      mapping: mappingRepository,
      db,
      options: { erpBaseUrl: 'https://erp.example', currencyId: 'KZT', assignedById: 1, paySystemId: 6 },
    });
    const run = async (clientId: number, beforePersist?: () => Promise<void>) => {
      const intents = await consumer.sync({
        outboxEventId: '00000000-0000-4000-8000-0000000000aa', eventType: 'crm.sync.client.upsert', aggregateType: 'crm_sync',
        aggregateId: String(clientId), payload: { entity: 'client', id: String(clientId), op: 'upsert' }, attempts: 0,
      });
      await beforePersist?.();
      await db.transaction(async (tx) => {
        for (const intent of intents) await persistSyncIntent(tx, mappingRepository, auditService, intent);
      });
      return intents;
    };
    return run;
  };

  beforeEach(async () => {
    expect(process.env.ERP_REVERSE_MERGE_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 2, statement_timeout: 20000, connectionTimeoutMillis: 5000 });
    client = await pool.connect();
    await client.query('BEGIN');
    db = new FixtureDatabase(client);
    repository = new PgBitrix24ReverseRepository(db, auditService);
    // The reverse sync service actor (materialization refuses any other).
    actorUserId = Number((await one<{ user_id: string }>(
      `SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
        WHERE u.is_active AND u.is_service_account AND r.role_code = 'integration_service' AND r.is_active
        ORDER BY u.user_id LIMIT 1`,
    )).user_id);
    survivorId = Number((await one<{ client_id: string }>(
      `INSERT INTO clients (client_name, person_type, is_active) VALUES ('Тест слияние остающийся', 'individual', true) RETURNING client_id`,
    )).client_id);
    mergedId = Number((await one<{ client_id: string }>(
      `INSERT INTO clients (client_name, person_type, is_active) VALUES ('Тест слияние объединённый', 'individual', true) RETURNING client_id`,
    )).client_id);
    await client.query(
      `INSERT INTO client_phones (client_id, phone_number, phone_type, is_primary) VALUES ($1, '+77000000101', 'mobile', true)`,
      [mergedId],
    );
    await client.query(
      `INSERT INTO crm_sync_mapping (entity_type, erp_id, bitrix_object, bitrix_id, status, source_system, last_bitrix_hash)
       VALUES ('client', $1, 'contact', $2, 'active', 'bitrix24', 'before-merge')`,
      [String(mergedId), contactId],
    );
    const caseId = Number((await one<{ case_id: string }>(
      `INSERT INTO integration_duplicate_cases (rule_code, entity_kind, key_version, strength, status, detected_via)
       VALUES ('client.phone', 'client', 1, 'exact', 'merged', 'erp_manual') RETURNING case_id`,
    )).case_id);
    mergeId = Number((await one<{ merge_id: string }>(
      `INSERT INTO client_merges (case_id, survivor_id, merged_id, status, actor_user_id, request_id, correlation_id, undo_until)
       VALUES ($1, $2, $3, 'done', $4, 'it-merge', 'it-merge', now() + interval '30 days') RETURNING merge_id`,
      [caseId, survivorId, mergedId, actorUserId],
    )).merge_id);
    await client.query('UPDATE clients SET is_active=false WHERE client_id=$1', [mergedId]);
    await client.query(
      'INSERT INTO client_merge_redirects (merged_client_id, survivor_id, merge_id) VALUES ($1, $2, $3)',
      [mergedId, survivorId, mergeId],
    );
  });

  afterEach(async () => {
    await client?.query('ROLLBACK').catch(() => undefined);
    client?.release();
    await pool?.end();
  });

  it('an edit of the merged client contact is skipped: name, phones and activity stay, the hash advances', async () => {
    const id = await repository.upsertClient({
      objectType: 'contact',
      bitrixId: contactId,
      name: 'Тест слияние переименован',
      notes: 'новая заметка',
      // No «неактивен» line: a plain upsert would reactivate the client (and the merge guard would refuse it).
      erpMarkedInactive: false,
      phones: [{ phoneNumber: '+77000000999', phoneType: 'mobile', isPrimary: true }],
      originErpId: null,
      normalizedHash: 'after-merge',
      bitrixCreatedAt: null,
      bitrixUpdatedAt: new Date('2099-01-01T00:00:00Z'),
      rawSnapshot: {},
    }, 'it-merge-upsert');

    expect(id).toBe(mergedId);
    expect(await one('SELECT client_name, is_active, notes FROM clients WHERE client_id=$1', [mergedId]))
      .toEqual({ client_name: 'Тест слияние объединённый', is_active: false, notes: null });
    expect((await client.query('SELECT phone_number FROM client_phones WHERE client_id=$1', [mergedId])).rows)
      .toEqual([{ phone_number: '+77000000101' }]);
    expect(await one(`SELECT status, last_bitrix_hash FROM crm_sync_mapping WHERE entity_type='client' AND erp_id=$1`, [String(mergedId)]))
      .toEqual({ status: 'active', last_bitrix_hash: 'after-merge' });
    const skipped = await audits('crm_sync.reverse.merged_client_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ related_client_id: String(mergedId) });
    expect(skipped[0].metadata_json).toMatchObject({ survivorId, operation: 'upsert', bitrixObject: 'contact', bitrixId: contactId });

    // The same snapshot again: an echo, no second audit row.
    await repository.upsertClient({
      objectType: 'contact', bitrixId: contactId, name: 'Тест слияние переименован', notes: null, erpMarkedInactive: false,
      phones: [], originErpId: null, normalizedHash: 'after-merge', bitrixCreatedAt: null,
      bitrixUpdatedAt: new Date('2099-01-01T00:00:00Z'), rawSnapshot: {},
    }, 'it-merge-upsert-2');
    expect(await audits('crm_sync.reverse.merged_client_skipped')).toHaveLength(1);
  });

  it('a delete of the merged client contact keeps its mapping and the client', async () => {
    expect(await repository.archiveClient('contact', contactId, 'it-merge-archive')).toBe(false);
    expect(await one(`SELECT status FROM crm_sync_mapping WHERE entity_type='client' AND erp_id=$1`, [String(mergedId)]))
      .toEqual({ status: 'active' });
    expect(await audits('crm_sync.reverse.merged_client_skipped')).toEqual([
      expect.objectContaining({ metadata_json: expect.objectContaining({ operation: 'archive', survivorId }) }),
    ]);
  });

  it('a new deal on the alias contact becomes a request of the survivor', async () => {
    const result = await repository.upsertDeal(deal('990000201'), 'it-merge-deal');
    expect(result.erpOrderId).toBeNull();
    expect(await one('SELECT client_id::text, state FROM bitrix24_incoming_request WHERE request_id=$1', [result.requestId]))
      .toEqual({ client_id: String(survivorId), state: 'unresolved' });
    const redirected = await audits('crm_sync.reverse.merged_client_redirected');
    expect(redirected).toHaveLength(1);
    expect(redirected[0].metadata_json).toMatchObject({ survivorId, bitrixDealId: '990000201', bitrixId: contactId });
  });

  it('a materialized request on the alias contact belongs to the survivor and passes the request invariant', async () => {
    const result = await repository.upsertDeal(deal('990000202'), 'it-merge-materialize', undefined, { actorUserId });
    expect(result.requestId).not.toBeNull();
    const row = await one<{ client_id: string; state: string; order_client: string }>(
      `SELECT r.client_id::text, r.state, o.client_id::text AS order_client
         FROM bitrix24_incoming_request r JOIN orders o ON o.order_id = r.linked_order_id
        WHERE r.request_id=$1`,
      [result.requestId],
    );
    expect(row).toEqual({ client_id: String(survivorId), state: 'active', order_client: String(survivorId) });
    // The deferred request invariant (migration 145 as extended by 268) accepts the alias mapping for the survivor.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });

  it('the backfill leaves the merged client out', async () => {
    const source = new PgCrmSourceRepository(db as never);
    const ids = await source.listClientIds(String(survivorId - 1), 10);
    expect(ids).toContain(String(survivorId));
    expect(ids).not.toContain(String(mergedId));
  });

  it('the source reports the survivor and the merge status; the outbox hands over the creation time', async () => {
    const source = new PgCrmSourceRepository(db as never);
    expect((await source.getClientById(String(mergedId)))?.mergedIntoClientId).toBe(String(survivorId));
    expect((await source.getClientById(String(survivorId)))?.mergedIntoClientId).toBeNull();
    expect(await source.getClientMergeStatus(String(mergeId))).toBe('done');
    await client.query(
      `INSERT INTO crm_sync_outbox (event_type, aggregate_type, aggregate_id, payload_json, idempotency_key, next_attempt_at, created_at)
       VALUES ('crm.sync.client.merged', 'crm_sync', $1, $2::jsonb, $3, '2000-01-01', '2026-10-22T10:00:00Z')`,
      [String(mergedId), JSON.stringify({ mergeId, mergedClientId: mergedId, survivorId }), `client.merged:it-${mergeId}`],
    );
    const [claimed] = await new PgCrmSyncOutboxRepository().claimBatch(db, 'it-merge', 1, 60000);
    expect(claimed).toMatchObject({ eventType: 'crm.sync.client.merged', createdAt: '2026-10-22T10:00:00.000Z' });
  });

  it('an upsert of the merged client after its alias was deleted in Bitrix creates nothing; a request on the alias stays valid', async () => {
    const request = await repository.upsertDeal(deal('990000203'), 'it-merge-alias-request', undefined, { actorUserId });
    const bitrix = {
      withRequestGuard: (_guard: unknown, operation: () => Promise<unknown>) => operation(),
      updateCrmItem: async () => { throw new Bitrix24ApiError('crm.item.update', 'NOT_FOUND', 400, 'Not found'); },
      createCrmItem: async () => { throw new Error('must not create'); },
      findCrmItemByOrigin: async () => { throw new Error('must not search'); },
      deleteCrmItem: async () => { throw new Error('must not delete'); },
    } as unknown as Bitrix24ApiPort;
    const mappingRepository = new PgCrmSyncMappingRepository();
    const consumer = new Bitrix24SyncConsumer({
      source: new PgCrmSourceRepository(db as never),
      bitrix,
      mapping: mappingRepository,
      db,
      options: { erpBaseUrl: 'https://erp.example', currencyId: 'KZT', assignedById: 1, paySystemId: 6 },
    });
    const intents = await consumer.sync({
      outboxEventId: '00000000-0000-4000-8000-0000000000aa', eventType: 'crm.sync.client.upsert', aggregateType: 'crm_sync',
      aggregateId: String(mergedId), payload: { entity: 'client', id: String(mergedId), op: 'upsert' }, attempts: 0,
    });
    await db.transaction(async (tx) => {
      for (const intent of intents) await persistSyncIntent(tx, mappingRepository, auditService, intent);
    });
    expect(await one(`SELECT bitrix_id, status FROM crm_sync_mapping WHERE entity_type='client' AND erp_id=$1`, [String(mergedId)]))
      .toEqual({ bitrix_id: contactId, status: 'active' });
    expect(await one('SELECT client_id::text, state FROM bitrix24_incoming_request WHERE request_id=$1', [request.requestId]))
      .toEqual({ client_id: String(survivorId), state: 'active' });
    expect((await audits('crm_sync.merged_client_skipped'))[0]?.metadata_json).toMatchObject({ reason: 'alias_missing', survivorId });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });

  it('a transient failure is audit-only; a later attempt (also from a failed mapping) keeps the alias active for the request', async () => {
    const request = await repository.upsertDeal(deal('990000204'), 'it-merge-transient', undefined, { actorUserId });
    let fail = true;
    const updates: string[] = [];
    const run = outbound({
      updateCrmItem: async (_type: number, id: string) => {
        if (fail) throw new Bitrix24ApiError('crm.item.update', 'INTERNAL', 503, 'busy');
        updates.push(id);
      },
    });
    await expect(run(mergedId)).rejects.toBeInstanceOf(CrmSyncAuditOnlyError);
    expect(await one(`SELECT status FROM crm_sync_mapping WHERE entity_type='client' AND erp_id=$1`, [String(mergedId)]))
      .toEqual({ status: 'active' });
    // A mapping an older attempt left failed is still the alias: the next delivery makes it active again.
    await client.query(`UPDATE crm_sync_mapping SET status='failed' WHERE entity_type='client' AND erp_id=$1`, [String(mergedId)]);
    fail = false;
    await run(mergedId);
    expect(updates).toEqual([contactId]);
    expect(await one(`SELECT bitrix_id, status FROM crm_sync_mapping WHERE entity_type='client' AND erp_id=$1`, [String(mergedId)]))
      .toEqual({ bitrix_id: contactId, status: 'active' });
    expect(await one('SELECT client_id::text FROM bitrix24_incoming_request WHERE request_id=$1', [request.requestId]))
      .toEqual({ client_id: String(survivorId) });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });

  const mergeInto = async (mergedClientId: number) => {
    const caseId = Number((await one<{ case_id: string }>(
      `INSERT INTO integration_duplicate_cases (rule_code, entity_kind, key_version, strength, status, detected_via)
       VALUES ('client.phone', 'client', 1, 'exact', 'merged', 'erp_manual') RETURNING case_id`,
    )).case_id);
    const id = Number((await one<{ merge_id: string }>(
      `INSERT INTO client_merges (case_id, survivor_id, merged_id, status, actor_user_id, request_id, correlation_id, undo_until)
       VALUES ($1, $2, $3, 'done', $4, 'it-late', 'it-late', now() + interval '30 days') RETURNING merge_id`,
      [caseId, survivorId, mergedClientId, actorUserId],
    )).merge_id);
    await client.query('UPDATE clients SET is_active=false WHERE client_id=$1', [mergedClientId]);
    await client.query(
      'INSERT INTO client_merge_redirects (merged_client_id, survivor_id, merge_id) VALUES ($1, $2, $3)',
      [mergedClientId, survivorId, id],
    );
  };

  it('a merge committed after a replacement contact was created and before it is persisted keeps the alias a request uses', async () => {
    const lateId = Number((await one<{ client_id: string }>(
      `INSERT INTO clients (client_name, person_type, is_active) VALUES ('Тест слияние замена', 'individual', true) RETURNING client_id`,
    )).client_id);
    await client.query(
      `INSERT INTO crm_sync_mapping (entity_type, erp_id, bitrix_object, bitrix_id, status, source_system)
       VALUES ('client', $1, 'contact', '990000105', 'active', 'erp')`,
      [String(lateId)],
    );
    const run = outbound({
      updateCrmItem: async () => { throw new Bitrix24ApiError('crm.item.update', 'NOT_FOUND', 400, 'Not found'); },
      findCrmItemByOrigin: async () => null,
      createCrmItem: async () => '990000106',
    });
    let requestId: number | null = null;
    await run(lateId, async () => {
      await mergeInto(lateId);
      // A deal fetched earlier, still on the old contact: a request of the survivor through the alias.
      requestId = (await repository.upsertDeal(
        deal('990000205', { clientId: lateId, counterpartyBitrixId: '990000105' }),
        'it-merge-late-request', undefined, { actorUserId },
      )).requestId;
    });
    expect(await one(`SELECT bitrix_id, status FROM crm_sync_mapping WHERE entity_type='client' AND erp_id=$1`, [String(lateId)]))
      .toEqual({ bitrix_id: '990000105', status: 'active' });
    expect(await one('SELECT client_id::text, state FROM bitrix24_incoming_request WHERE request_id=$1', [requestId]))
      .toEqual({ client_id: String(survivorId), state: 'active' });
    const skipped = (await client.query<{ metadata_json: Record<string, unknown> }>(
      `SELECT metadata_json FROM audit_log WHERE event='crm_sync.merged_client_skipped' AND entity_id=$1`, [String(lateId)],
    )).rows;
    expect(skipped.map((row) => row.metadata_json)).toEqual([
      expect.objectContaining({ reason: 'replacement_after_merge', keptBitrixId: '990000105', createdBitrixId: '990000106' }),
    ]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });

  it('a merge committed while the contact was being written: no contact is created, the alias stays', async () => {
    const lateId = Number((await one<{ client_id: string }>(
      `INSERT INTO clients (client_name, person_type, is_active) VALUES ('Тест слияние поздний', 'individual', true) RETURNING client_id`,
    )).client_id);
    await client.query(
      `INSERT INTO crm_sync_mapping (entity_type, erp_id, bitrix_object, bitrix_id, status, source_system)
       VALUES ('client', $1, 'contact', '990000102', 'active', 'erp')`,
      [String(lateId)],
    );
    let merged = false;
    const run = outbound({
      updateCrmItem: async () => {
        if (!merged) {
          // The merge commits after the client was read, while its contact is being written.
          const caseId = Number((await one<{ case_id: string }>(
            `INSERT INTO integration_duplicate_cases (rule_code, entity_kind, key_version, strength, status, detected_via)
             VALUES ('client.phone', 'client', 1, 'exact', 'merged', 'erp_manual') RETURNING case_id`,
          )).case_id);
          const lateMerge = Number((await one<{ merge_id: string }>(
            `INSERT INTO client_merges (case_id, survivor_id, merged_id, status, actor_user_id, request_id, correlation_id, undo_until)
             VALUES ($1, $2, $3, 'done', $4, 'it-late', 'it-late', now() + interval '30 days') RETURNING merge_id`,
            [caseId, survivorId, lateId, actorUserId],
          )).merge_id);
          await client.query('UPDATE clients SET is_active=false WHERE client_id=$1', [lateId]);
          await client.query(
            'INSERT INTO client_merge_redirects (merged_client_id, survivor_id, merge_id) VALUES ($1, $2, $3)',
            [lateId, survivorId, lateMerge],
          );
          merged = true;
        }
        throw new Bitrix24ApiError('crm.item.update', 'NOT_FOUND', 400, 'Not found');
      },
    });
    const intents = await run(lateId);
    expect(intents.map((intent) => intent.audit.event)).toEqual(['crm_sync.merged_client_skipped']);
    expect(intents[0].audit.metadata).toMatchObject({ reason: 'alias_missing', survivorId });
    expect(await one(`SELECT bitrix_id, status FROM crm_sync_mapping WHERE entity_type='client' AND erp_id=$1`, [String(lateId)]))
      .toEqual({ bitrix_id: '990000102', status: 'active' });
  });

  it('a contact created for a client holds the merge key during the create (second connection); persistence re-checks under the key separately', async () => {
    const plainId = Number((await one<{ client_id: string }>(
      `INSERT INTO clients (client_name, person_type, is_active) VALUES ('Тест слияние новый контакт', 'individual', true) RETURNING client_id`,
    )).client_id);
    await client.query(
      `INSERT INTO crm_sync_mapping (entity_type, erp_id, bitrix_object, bitrix_id, status, source_system)
       VALUES ('client', $1, 'contact', '990000103', 'active', 'erp')`,
      [String(plainId)],
    );
    let mergeCouldLock: boolean | null = null;
    const run = outbound({
      updateCrmItem: async () => { throw new Bitrix24ApiError('crm.item.update', 'NOT_FOUND', 400, 'Not found'); },
      findCrmItemByOrigin: async () => null,
      createCrmItem: async () => {
        // What a merge of this client does first: the exclusive key, from another connection.
        const other = await pool.connect().catch(() => null);
        if (other) {
          try {
            await other.query('BEGIN');
            mergeCouldLock = (await other.query<{ ok: boolean }>(
              'SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS ok',
              [`bitrix24-reverse:client:erp:${plainId}`],
            )).rows[0].ok;
          } finally {
            await other.query('ROLLBACK').catch(() => undefined);
            other.release();
          }
        }
        return '990000104';
      },
    });
    await run(plainId);
    expect(mergeCouldLock).toBe(false);
    expect(await one(`SELECT bitrix_id, status FROM crm_sync_mapping WHERE entity_type='client' AND erp_id=$1`, [String(plainId)]))
      .toEqual({ bitrix_id: '990000104', status: 'active' });
  });
});
