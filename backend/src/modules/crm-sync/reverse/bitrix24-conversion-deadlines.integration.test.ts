import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { normalizeBitrixDeal } from './bitrix24-reverse-normalizer';
import { PgOrderReadRepository } from '../../orders/adapters/pg-order-read-repository';
import { createRequire } from 'node:module';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditService } from '../../../common/audit/audit.service';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { PgOrderDeadlineSync } from '../../deadlines/adapters/pg-order-deadline-sync';
import { PgBitrix24ReverseRepository, type ReversePaymentSnapshot } from './pg-bitrix24-reverse-repository';
import { productRowsHash, normalizeBitrixProductRow } from './bitrix24-product-rows';
import { Bitrix24PaymentWidgetRepository } from '../widget/bitrix24-payment-widget.repository';
import { Bitrix24ManualPaymentCommandService } from '../widget/bitrix24-manual-payment-command.service';
import { Bitrix24ProductSyncService } from './bitrix24-product-sync.service';
import { Bitrix24ReverseProcessorService } from './bitrix24-reverse-processor.service';
import { Bitrix24PaidConversionService } from './bitrix24-paid-conversion.service';
import { Bitrix24TokenCipher } from './bitrix24-token-cipher';

// Explicit test-only target. All fixture writes remain inside an outer ROLLBACK;
// conversion uses real SQL/savepoints, including real constraints/audit/outbox.
const url = process.env.ERP_CONVERSION_TEST_DATABASE_URL;
// Optional post-build canary exercises the exact CommonJS production adapter.
const Repository = process.env.ERP_CONVERSION_TEST_USE_DIST === 'true'
  ? (createRequire(import.meta.url)('../../../../dist/modules/crm-sync/reverse/pg-bitrix24-reverse-repository.js') as { PgBitrix24ReverseRepository: typeof PgBitrix24ReverseRepository }).PgBitrix24ReverseRepository
  : PgBitrix24ReverseRepository;
class FixtureDatabase extends DatabaseService {
  failDeadline = false;
  readonly tx: TransactionClient;
  constructor(readonly client: PoolClient) {
    super(new ConfigService<BackendEnv, true>({ DATABASE_QUERY_TIMEOUT_MS: 10000 }), {} as never);
    this.tx = { raw: client, query: this.query.bind(this) };
  }
  firstQueryError: unknown = null;
  override async query<T extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []) {
    if (this.failDeadline && sql.includes('INSERT INTO deadline_events')) {
      await this.client.query('SELECT 1 / 0');
    }
    try {
      return await this.client.query<T>(sql, [...params]);
    } catch (error) {
      // Log ONLY the operation and error identity — parameters can carry
      // session ciphertext; never echo them into test output.
      if (this.firstQueryError === null) {
        this.firstQueryError = error;
        const operation = sql.trim().split(/\s+/).slice(0, 4).join(' ');
        const summary = error instanceof Error ? error.message : String(error);
        console.error(`[fixture] first SQL failure op="${operation}" code=${(error as { code?: string }).code ?? 'n/a'} :: ${summary}`);
      }
      throw error;
    }
  }
  override async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
    await this.client.query('SAVEPOINT conversion');
    try {
      const result = await handler(this.tx);
      await this.client.query('SET CONSTRAINTS ALL IMMEDIATE');
      await this.client.query('SET CONSTRAINTS ALL DEFERRED');
      await this.client.query('RELEASE SAVEPOINT conversion');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK TO SAVEPOINT conversion');
      await this.client.query('RELEASE SAVEPOINT conversion');
      throw error;
    }
  }
}

describe.skipIf(!url)('CRM conversion deadlines on real PostgreSQL (rollback-only)', () => {
  let pool: Pool;
  let client: PoolClient;
  let db: FixtureDatabase;
  let repository: PgBitrix24ReverseRepository;
  let input: Parameters<PgBitrix24ReverseRepository['convertCrmRequestToProduction']>[0];
  let orderId: number;
  let actorId: number;

  beforeEach(async () => {
    expect(process.env.ERP_CONVERSION_TEST_TARGET_ENV).toBe('backend-test');
    pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='3s'");
    const authorshipMigration = readFileSync(new URL('../../../../db/migrations/156_bitrix24_authorship.sql', import.meta.url), 'utf8');
    await client.query(authorshipMigration);
    await client.query(authorshipMigration); // additive/idempotent, rolled back with fixture
    await client.query(readFileSync(new URL('../../../../db/migrations/162_order_catalog_lines.sql', import.meta.url), 'utf8'));
    const autoMigration = readFileSync(new URL('../../../../db/migrations/172_bitrix_paid_request_conversion.sql', import.meta.url), 'utf8');
    await client.query(autoMigration);
    await client.query(autoMigration);
    const productMigration = readFileSync(new URL('../../../../db/migrations/186_bitrix24_product_import.sql', import.meta.url), 'utf8');
    await client.query(productMigration);
    db = new FixtureDatabase(client);
    repository = new Repository(db, new AuditService());
    const name = 'E2E-conversion-' + randomUUID();
    actorId = Number((await client.query("INSERT INTO users (username,email,password_hash,role_id) VALUES ($1,$2,'E2E-NO-LOGIN',1) RETURNING user_id", [name, name + '@example.invalid'])).rows[0].user_id);
    await client.query("SELECT set_config('hasura.user',$1,true)", [JSON.stringify({ 'x-hasura-user-id': String(actorId), 'x-hasura-role': 'admin' })]);
    const clientId = (await client.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [name])).rows[0].client_id;
    orderId = Number((await client.query(`INSERT INTO orders (order_name,client_id,order_kind,source_system,order_status_id,payment_status_id,created_by,manager_id,production_status_from_details_enabled,planned_completion_date)
      VALUES ($1,$2,'crm_request','bitrix24',1,1,$3,$3,false,'2099-09-20') RETURNING order_id`, [name, clientId, actorId])).rows[0].order_id);
    await client.query("INSERT INTO crm_sync_mapping (entity_type,erp_id,bitrix_object,bitrix_id,status,source_system) VALUES ('client',$1,'contact',$2,'active','bitrix24')", [String(clientId), String(clientId + 900000000)]);
    await client.query(`INSERT INTO bitrix24_incoming_request (bitrix_deal_id,title,bitrix_url,state,linked_order_id,client_id,counterparty_object_type,counterparty_bitrix_id)
      VALUES ($1,$2,'https://example.invalid/E2E','active',$3,$4,'contact',$5)`, [String(orderId + 900000000), name, orderId, clientId, String(clientId + 900000000)]);
    // Exact active order<->Deal mapping + a complete-empty product reconcile:
    // conversion gates reject 'pending' and missing mappings since migration 186.
    await client.query(`INSERT INTO crm_sync_mapping (entity_type,erp_id,bitrix_object,bitrix_id,status,source_system)
      VALUES ('order',$1,'deal',$2,'active','bitrix24') ON CONFLICT DO NOTHING`, [String(orderId), String(orderId + 900000000)]);
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    {
      const dealId = String(orderId + 900000000);
      const productFence = await repository.getProductSyncFence(dealId);
      const applied = await repository.applyDealProductSnapshot({
        dealId, rows: [], invalid: [],
        rowsHash: productRowsHash([]),
        opportunity: null, expectedCurrencyId: 'KZT', currencyId: 'KZT',
        auditRequestId: name, actorUserId: actorId, fence: productFence,
        remoteUpdatedAt: '2026-09-25T10:00:00+03:00',
      });
      expect(applied.status).toBe('ready');
    }
    await client.query(`INSERT INTO order_details (order_id,detail_number,height,width,quantity,area,milling_type_id,edge_type_id,sheet_material_type_id,created_by,detail_cost)
      SELECT $1,1,500,300,1,0.15,(SELECT min(milling_type_id) FROM milling_types),(SELECT min(edge_type_id) FROM edge_types),(SELECT min(sheet_material_type_id) FROM sheet_material_types),$2,1000`, [orderId, actorId]);
    const version = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    input = {
      orderId, expectedVersion: version, orderName: name + '-production', projectId: null, createProject: true,
      idempotencyKey: name, actorUserId: actorId, actorUsername: name, actorRole: 'admin',
      requestId: name, scope: { mode: 'all' }, initialOrderStatusCode: 'legacy_1', initialProductionStatusCode: 'drawn',
    };
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
  });
  afterEach(async () => {
    if (client) { await client.query('ROLLBACK'); client.release(); }
    await pool?.end();
  });

  async function conversionState() {
    return (await client.query(`SELECT order_kind,project_id,version,
      (SELECT state FROM bitrix24_incoming_request WHERE linked_order_id=$1) AS request_state,
      (SELECT count(*)::int FROM deadline_instances WHERE order_id=$1) AS deadlines,
      (SELECT count(*)::int FROM deadline_events WHERE order_id=$1) AS events,
      (SELECT count(*)::int FROM order_kind_conversion_command WHERE order_id=$1) AS commands,
      (SELECT json_agg(production_status_id ORDER BY detail_id) FROM order_details WHERE order_id=$1) AS detail_statuses,
      (SELECT count(*)::int FROM production_status_events WHERE order_id=$1 OR detail_id IN (SELECT detail_id FROM order_details WHERE order_id=$1)) AS production_events,
      (SELECT count(*)::int FROM audit_log WHERE request_id=$2) AS audit,
      (SELECT count(*)::int FROM outbox_events WHERE payload_json->>'requestId'=$2) AS outbox,
      (SELECT count(*)::int FROM projects WHERE created_by=$3) AS projects
      FROM orders WHERE order_id=$1`, [orderId, input.requestId, actorId])).rows[0];
  }

  async function seedPayment() {
    const request = (await client.query('SELECT request_id,bitrix_deal_id FROM bitrix24_incoming_request WHERE linked_order_id=$1', [orderId])).rows[0];
    await client.query("INSERT INTO crm_sync_mapping (entity_type,erp_id,bitrix_object,bitrix_id,status,source_system) VALUES ('order',$1,'deal',$2,'active','bitrix24') ON CONFLICT DO NOTHING", [String(orderId), request.bitrix_deal_id]);
    await client.query('INSERT INTO bitrix24_payment_type_mapping (pay_system_id,type_paid_id,active) SELECT $1,min(type_paid_id),true FROM payment_types', [orderId + 900000000]);
    const payment: ReversePaymentSnapshot = {
      bitrixPaymentId: String(orderId + 900000000), paySystemId: orderId + 900000000,
      paySystemName: 'E2E-cash', amount: 500, currencyId: 'KZT', paid: true,
      paymentDate: new Date('2026-09-09T10:00:00+05:00'), normalizedHash: 'E2E-payment',
      bitrixCreatedAt: null, bitrixUpdatedAt: null,
    };
    await repository.replaceRequestPaymentSnapshots(Number(request.request_id), [payment], input.requestId, undefined, await repository.getPaymentSyncFence(String(request.bitrix_deal_id)));
    return { payment, requestId: Number(request.request_id), dealId: String(request.bitrix_deal_id) };
  }

  async function importPayment(paymentId: string) {
    const version = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    return repository.materializeMappedOrderPayments({ orderId, bitrixPaymentIds: [paymentId], expectedOrderVersion: version,
      actorUserId: String(actorId), auditRequestId: input.requestId, scope: { mode: 'all' } });
  }

  async function autoInput(dealId: string) {
    const service = (await client.query(`INSERT INTO users(username,email,password_hash,role_id,is_service_account)
      SELECT $1::text,$1::text || '@example.invalid','E2E-NO-LOGIN',role_id,true FROM roles WHERE role_code='integration_service' RETURNING user_id`,
    ['E2E-auto-service-' + randomUUID()])).rows[0];
    return { dealId, actorUserId: Number(service.user_id), requestId: input.requestId,
      initialOrderStatusCode: input.initialOrderStatusCode, initialProductionStatusCode: input.initialProductionStatusCode };
  }

  it('automatically converts a paid CRM request and imports its partial prepayment exactly once', async () => {
    const { payment, dealId } = await seedPayment();
    await client.query("UPDATE bitrix24_incoming_request_payment SET paid_by_id='17',paid_by_name='E2E-cashier' WHERE bitrix_payment_id=$1", [payment.bitrixPaymentId]);
    const auto = await autoInput(dealId);
    const result = await repository.autoConvertPaidCrmRequest(auto);
    expect(result.status).toBe('converted');
    expect((await conversionState()).order_kind).toBe('production_order');
    expect((await client.query('SELECT amount,created_by FROM payments WHERE order_id=$1', [orderId])).rows)
      .toEqual([{ amount: '500.00', created_by: String(auto.actorUserId) }]);
    const after = await conversionState();
    expect(await repository.autoConvertPaidCrmRequest(auto)).toMatchObject({ status: 'unchanged' });
    expect(await conversionState()).toEqual(after);
    expect((await client.query('SELECT erp_payment_id FROM bitrix24_incoming_request_payment WHERE bitrix_payment_id=$1', [payment.bitrixPaymentId])).rows[0].erp_payment_id).not.toBeNull();
    const transition = (await client.query("SELECT payload_json FROM outbox_events WHERE event_type='bitrix24.request_auto_conversion.completed' AND aggregate_id=$1", [String(orderId)])).rows;
    expect(transition).toHaveLength(1);
    expect(transition[0].payload_json).toMatchObject({ orderId, paidByBitrix: { bitrixUserId: '17', displayName: 'E2E-cashier' } });
    expect(transition[0].payload_json.paymentId).toBeGreaterThan(0);
  });

  it('runs migration end-state probes on real PostgreSQL and detects a disabled retry trigger', async () => {
    const source = readFileSync(new URL('../../../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
    const helpers = source.slice(source.indexOf('q_col()'), source.indexOf('# These migrations contain conditional'));
    const queries = execFileSync('bash', ['-s'], { input: helpers + '\nprobe_all() { printf "%s\\n" "$@"; }\nprobe_file 172_bitrix_paid_request_conversion.sql', encoding: 'utf8' }).trim().split('\n');
    const present = async () => { const checks = []; for (const sql of queries) checks.push(Object.values((await client.query(sql)).rows[0])[0]); return checks.every(v => v === true); };
    expect(await present()).toBe(true);
    await client.query('ALTER TABLE orders DISABLE TRIGGER bitrix_paid_request_recheck');
    expect(await present()).toBe(false);
    await client.query('ALTER TABLE orders ENABLE TRIGGER bitrix_paid_request_recheck');
  });

  it('waits without positions, records the reason once, and retries after positions return', async () => {
    const { dealId } = await seedPayment();
    const auto = await autoInput(dealId);
    await client.query('UPDATE order_details SET delete_flag=true WHERE order_id=$1', [orderId]);
    expect(await repository.autoConvertPaidCrmRequest(auto)).toMatchObject({ status: 'waiting', reason: 'POSITIONS_REQUIRED' });
    const state = await conversionState();
    expect(state.order_kind).toBe('crm_request');
    expect(state.commands).toBe(0);
    await repository.autoConvertPaidCrmRequest(auto);
    expect(await conversionState()).toEqual(state);
    await client.query('UPDATE order_details SET delete_flag=false WHERE order_id=$1', [orderId]);
    expect(await repository.autoConvertPaidCrmRequest(auto)).toMatchObject({ status: 'converted' });
  });

  it('clears obsolete automatic waiting state when a human converts the request', async () => {
    await client.query("UPDATE bitrix24_incoming_request SET auto_conversion_status='waiting',auto_conversion_reason='CONVERSION_BLOCKED' WHERE linked_order_id=$1", [orderId]);
    // Waiting was committed by an earlier command in production. Flush its
    // deferred link constraint before simulating the next command in this fixture.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await repository.convertCrmRequestToProduction(input);
    expect((await client.query('SELECT auto_conversion_status,auto_conversion_reason FROM bitrix24_incoming_request WHERE linked_order_id=$1', [orderId])).rows[0])
      .toEqual({ auto_conversion_status: 'idle', auto_conversion_reason: null });
  });

  it.each(['unpaid', 'zero', 'currency', 'mapping', 'actor', 'sync', 'foreign-map'])('does not convert invalid input: %s', async (reason) => {
    const { dealId, payment } = await seedPayment();
    const auto = await autoInput(dealId);
    if (reason === 'unpaid') await client.query('UPDATE bitrix24_incoming_request_payment SET paid=false WHERE bitrix_payment_id=$1', [payment.bitrixPaymentId]);
    if (reason === 'zero') await client.query('UPDATE bitrix24_incoming_request_payment SET amount=0 WHERE bitrix_payment_id=$1', [payment.bitrixPaymentId]);
    if (reason === 'currency') await client.query("UPDATE bitrix24_incoming_request_payment SET currency_id='USD' WHERE bitrix_payment_id=$1", [payment.bitrixPaymentId]);
    if (reason === 'mapping') await client.query('UPDATE bitrix24_payment_type_mapping SET active=false WHERE pay_system_id=$1', [payment.paySystemId]);
    if (reason === 'actor') await client.query('UPDATE users SET is_active=false WHERE user_id=$1', [auto.actorUserId]);
    if (reason === 'sync') await client.query("UPDATE bitrix24_incoming_request SET sync_status='blocked' WHERE bitrix_deal_id=$1", [dealId]);
    if (reason === 'foreign-map') await client.query("UPDATE crm_sync_mapping SET bitrix_id=(bitrix_id::bigint+1)::text WHERE entity_type='order' AND erp_id=$1", [String(orderId)]);
    expect((await repository.autoConvertPaidCrmRequest(auto)).status).not.toBe('converted');
    expect((await conversionState()).order_kind).toBe('crm_request');
    expect((await client.query('SELECT count(*)::int AS n FROM payments WHERE order_id=$1', [orderId])).rows[0].n).toBe(0);
  });

  it('rolls automatic project, conversion and money back on SQL failure; later retry succeeds', async () => {
    const { dealId } = await seedPayment();
    const auto = await autoInput(dealId);
    const before = await conversionState();
    db.failDeadline = true;
    await expect(repository.autoConvertPaidCrmRequest(auto)).rejects.toThrow();
    expect(await conversionState()).toEqual(before);
    db.failDeadline = false;
    expect((await repository.autoConvertPaidCrmRequest(auto)).status).toBe('converted');
  });

  async function widgetAutoInput() {
    const { dealId, requestId, payment } = await seedPayment();
    const auto = await autoInput(dealId);
    const member = 'E2E-' + randomUUID();
    await client.query(`INSERT INTO bitrix24_app_installation(member_id,domain,access_token_ciphertext,refresh_token_ciphertext,access_token_expires_at,application_token_hash)
      VALUES ($1,'example.invalid','E2E-not-a-token','E2E-not-a-token',now(),repeat('a',64))`, [member]);
    await client.query(`INSERT INTO bitrix24_user_mapping(bitrix_user_id,erp_user_id,is_active) VALUES ($1,$2,true)`, [String(actorId + 900000000), actorId]);
    const commandId = randomUUID(), leaseToken = randomUUID();
    await client.query(`INSERT INTO bitrix24_manual_payment_command(command_id,idempotency_key,request_hash,member_id,domain,bitrix_deal_id,
      bitrix_actor_user_id,erp_actor_user_id,bitrix_executor_user_id,originating_request_id,request_id,erp_order_id,bitrix_payment_id,
      amount,currency_id,payment_date,pay_system_id,type_paid_id,status,lease_token,lease_expires_at)
      SELECT $1,$1,repeat('a',64),$2,'example.invalid',$3,$4,$5,'1',$6,$7,$8,$9,500,'KZT','2026-09-09',$10,type_paid_id,'snapshot_saved',$11,now()+interval '3 minutes'
      FROM bitrix24_payment_type_mapping WHERE pay_system_id=$10`, [commandId,member,dealId,String(actorId+900000000),actorId,input.requestId,requestId,orderId,payment.bitrixPaymentId,payment.paySystemId,leaseToken]);
    await client.query('UPDATE bitrix24_payment_type_mapping SET widget_enabled=true WHERE pay_system_id=$1', [payment.paySystemId]);
    await client.query('UPDATE bitrix24_incoming_request_payment SET manual_command_id=$2 WHERE bitrix_payment_id=$1', [payment.bitrixPaymentId,commandId]);
    const widgetRepo = new Bitrix24PaymentWidgetRepository(db, new AuditService());
    return { ...auto, widget: { commandId,leaseToken,materialize: widgetRepo.materializeCommandInTransaction.bind(widgetRepo),
      awaitConfirmation: widgetRepo.awaitOverpaymentConfirmationInTransaction.bind(widgetRepo) } };
  }

  it('converts widget payment atomically using its original human actor, not the service executor', async () => {
    const auto = await widgetAutoInput();
    expect(await repository.autoConvertPaidCrmRequest(auto)).toMatchObject({ status: 'converted' });
    expect((await client.query('SELECT created_by FROM payments WHERE order_id=$1', [orderId])).rows).toEqual([{ created_by: String(actorId) }]);
    expect((await client.query('SELECT status FROM bitrix24_manual_payment_command WHERE command_id=$1', [auto.widget.commandId])).rows[0].status).toBe('completed');
  });

  it('never bypasses widget ownership or revoked human permission', async () => {
    const auto = await widgetAutoInput();
    expect(await repository.autoConvertPaidCrmRequest({ ...auto, widget: undefined })).toMatchObject({ status: 'waiting', reason: 'WIDGET_PENDING' });
    expect(await repository.autoConvertPaidCrmRequest({ ...auto, widget: { ...auto.widget, leaseToken: randomUUID() } })).toMatchObject({ status: 'unchanged' });
    await client.query('UPDATE bitrix24_user_mapping SET is_active=false WHERE erp_user_id=$1', [actorId]);
    expect(await repository.autoConvertPaidCrmRequest(auto)).toMatchObject({ status: 'waiting', reason: 'PAYMENT_PERMISSION_REQUIRED' });
    expect((await conversionState()).order_kind).toBe('crm_request');
    expect((await conversionState()).commands).toBe(0);
  });

  it('keeps overpayment confirmation visible without half-converting, then converts after confirmation', async () => {
    const auto = await widgetAutoInput();
    await client.query('UPDATE order_details SET detail_cost=100 WHERE order_id=$1', [orderId]);
    expect(await repository.autoConvertPaidCrmRequest(auto)).toMatchObject({ status: 'waiting', reason: 'PAYMENT_REQUIRES_CONFIRMATION' });
    expect((await conversionState()).order_kind).toBe('crm_request');
    const widgetRepo = new Bitrix24PaymentWidgetRepository(db, new AuditService());
    expect((await widgetRepo.getCommand(auto.widget.commandId))?.status).toBe('awaiting_overpayment_confirmation');
    await widgetRepo.confirmOverpayment({ commandId: auto.widget.commandId, actorUserId: actorId });
    expect(await repository.autoConvertPaidCrmRequest(auto)).toMatchObject({ status: 'converted' });
  });

  it('enqueues one targeted retry when a waiting paid request is edited; financial reasons stay private', async () => {
    const auto = await widgetAutoInput();
    await client.query('UPDATE order_details SET delete_flag=true WHERE order_id=$1', [orderId]);
    await repository.autoConvertPaidCrmRequest(auto);
    await client.query('UPDATE orders SET version=version+1 WHERE order_id=$1', [orderId]);
    await client.query('UPDATE orders SET version=version+1 WHERE order_id=$1', [orderId]);
    expect((await client.query("SELECT count(*)::int AS n FROM bitrix24_inbound_event WHERE bitrix_id=$1 AND fingerprint LIKE 'paid-request-edit:%'", [auto.dealId])).rows[0].n).toBe(1);
    const id = Number((await client.query('SELECT request_id FROM bitrix24_incoming_request WHERE linked_order_id=$1', [orderId])).rows[0].request_id);
    expect(await repository.getIncomingRequest(id, { mode: 'all' }, false)).not.toHaveProperty('autoConversionReason');
    expect(await repository.getIncomingRequest(id, { mode: 'all' }, true)).toHaveProperty('autoConversionReason', 'POSITIONS_REQUIRED');
  });

  it('refreshes a converted request payment through order finances without changing ownership', async () => {
    const { payment, requestId, dealId } = await seedPayment();
    await repository.convertCrmRequestToProduction(input);
    await repository.replaceMappedOrderPaymentSnapshots(orderId, [payment], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId));
    const listed = await repository.getMappedOrderPayments(orderId, { mode: 'all' });
    expect(listed.payments).toEqual([expect.objectContaining({ bitrixPaymentId: payment.bitrixPaymentId, amount: 500, erpPaymentId: null })]);
    expect((await client.query('SELECT request_id,erp_order_id FROM bitrix24_incoming_request_payment WHERE bitrix_payment_id=$1', [payment.bitrixPaymentId])).rows[0]).toEqual({ request_id: String(requestId), erp_order_id: null });
    expect((await client.query('SELECT count(*)::int AS n FROM payments WHERE order_id=$1', [orderId])).rows[0].n).toBe(0);
    expect(await importPayment(payment.bitrixPaymentId)).toMatchObject({ changedPaymentCount: 1 });
    await repository.replaceRequestPaymentSnapshots(requestId, [payment], input.requestId, undefined, await repository.getPaymentSyncFence(dealId));
    await repository.replaceMappedOrderPaymentSnapshots(orderId, [payment], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId));
    expect(await importPayment(payment.bitrixPaymentId)).toMatchObject({ changedPaymentCount: 0 });
    const erp = (await client.query('SELECT amount,payment_date::text,created_by FROM payments WHERE order_id=$1', [orderId])).rows;
    expect(erp).toEqual([{ amount: '500.00', payment_date: '2026-09-09', created_by: String(actorId) }]);
    expect((await client.query('SELECT paid_amount FROM orders WHERE order_id=$1', [orderId])).rows[0].paid_amount).toBe('500.00');
    expect((await client.query("SELECT count(*)::int AS n FROM audit_log WHERE request_id=$1 AND event='bitrix24_reverse.mapped_order_payments_materialize'", [input.requestId])).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='bitrix24.payment.materialized' AND payload_json->>'orderId'=$1", [String(orderId)])).rows[0].n).toBe(1);
  });

  it('retains source authors through conversion, lookup failure and payment materialization', async () => {
    const { payment, requestId, dealId } = await seedPayment();
    const authored = { ...payment, paidById: '700000001', paidByName: 'Native status actor' };
    await repository.replaceRequestPaymentSnapshots(requestId, [authored], input.requestId, undefined, await repository.getPaymentSyncFence(dealId));
    await client.query("INSERT INTO bitrix24_remote_state (object_type,bitrix_id,normalized_hash,raw_snapshot) VALUES ('deal',$1,'E2E',$2::jsonb)", [dealId, JSON.stringify({ createdBy: '700000002', createdByName: 'Request creator', assignedById: '700000003' })]);
    expect((await repository.getIncomingRequest(requestId, { mode: 'all' }, true)).createdByBitrix).toMatchObject({ bitrixUserId: '700000002', displayName: 'Request creator' });
    expect((await repository.getIncomingRequest(requestId, { mode: 'all' }, false)).payments).toEqual([]);
    await repository.convertCrmRequestToProduction(input);
    await repository.replaceMappedOrderPaymentSnapshots(orderId, [{ ...authored, paidByName: null }], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId));
    const view = await repository.getMappedOrderPayments(orderId, { mode: 'all' }, true);
    const redacted = await repository.getMappedOrderPayments(orderId, { mode: 'all' });
    expect(redacted).not.toHaveProperty('createdByBitrix');
    expect((redacted.payments as Record<string, unknown>[])[0]).not.toHaveProperty('authorship');
    expect(view.createdByBitrix).toMatchObject({ bitrixUserId: '700000002' });
    expect(view.payments).toEqual([expect.objectContaining({ authorship: { createdBy: null, paidBy: expect.objectContaining({ bitrixUserId: '700000001', displayName: 'Native status actor' }) } })]);
    await importPayment(payment.bitrixPaymentId);
    expect(await importPayment(payment.bitrixPaymentId)).toMatchObject({ changedPaymentCount: 0 });
    expect((await client.query('SELECT created_by FROM payments WHERE order_id=$1', [orderId])).rows[0].created_by).toBe(String(actorId));
    await repository.replaceMappedOrderPaymentSnapshots(orderId, [{ ...authored, paidById: '700000004', paidByName: null }], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId));
    expect((await client.query('SELECT paid_by_name FROM bitrix24_incoming_request_payment WHERE bitrix_payment_id=$1', [payment.bitrixPaymentId])).rows[0].paid_by_name).toBeNull();
    expect(await repository.getMappedOrderPayments(orderId, { mode: 'assigned', userId: actorId + 999999 })).toEqual({ linked: false, orderId });
  });

  it('reads minimal technical audit labels without exposing Bitrix provenance in general orders', async () => {
    await repository.convertCrmRequestToProduction(input);
    const reader = new PgOrderReadRepository(db);
    const view = await reader.getOrderById({ orderId, currentUser: { id: String(actorId), username: input.actorUsername, role: 'admin', roleId: 1, permissions: ['orders.view'] } });
    expect(view?.header.createdByLabel).toBe(input.actorUsername);
    expect(view?.header).not.toHaveProperty('createdByBitrix');
    expect(view?.header).not.toHaveProperty('email');
  });

  it('enriches unchanged Deal metadata without business versions or events and rejects stale authors', async () => {
    const { dealId } = await seedPayment();
    const snapshot = normalizeBitrixDeal(dealId, { title: 'E2E', createdBy: 700000002, updatedTime: '2026-09-10T00:00:00Z' }, { clientId: null, portalDomain: 'example.invalid', portalTimezone: 'Asia/Almaty', counterparty: null });
    snapshot.rawSnapshot.createdByName = 'Creator';
    await client.query("UPDATE crm_sync_mapping SET last_bitrix_hash=$2,last_bitrix_updated_at=$3 WHERE entity_type='order' AND erp_id=$1", [String(orderId), snapshot.normalizedHash, snapshot.bitrixUpdatedAt]);
    await client.query("INSERT INTO bitrix24_remote_state (object_type,bitrix_id,normalized_hash,raw_snapshot,bitrix_updated_at) VALUES ('deal',$1,$2,'{}',$3)", [dealId, snapshot.normalizedHash, snapshot.bitrixUpdatedAt]);
    const before = await conversionState();
    await repository.upsertDeal(snapshot, input.requestId);
    await repository.upsertDeal({ ...snapshot, rawSnapshot: { ...snapshot.rawSnapshot, createdByName: null } }, input.requestId);
    await repository.upsertDeal({ ...snapshot, bitrixUpdatedAt: new Date('2020-01-01'), rawSnapshot: { ...snapshot.rawSnapshot, createdBy: '999' } }, input.requestId);
    expect(await conversionState()).toEqual(before);
    expect((await client.query("SELECT raw_snapshot FROM bitrix24_remote_state WHERE object_type='deal' AND bitrix_id=$1", [dealId])).rows[0].raw_snapshot).toMatchObject({ createdBy: '700000002', createdByName: 'Creator' });
  });

  it.each(['unpaid', 'deleted'])('keeps %s request snapshots explicit and applies selected changes once', async (mode) => {
    const { payment, dealId } = await seedPayment();
    await repository.convertCrmRequestToProduction(input);
    await repository.replaceMappedOrderPaymentSnapshots(orderId, [payment], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId));
    await importPayment(payment.bitrixPaymentId);
    await repository.replaceMappedOrderPaymentSnapshots(orderId, mode === 'deleted' ? [] : [{ ...payment, paid: false }], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId));
    expect((await client.query('SELECT delete_flag FROM payments WHERE order_id=$1', [orderId])).rows[0].delete_flag).toBe(false);
    expect(await importPayment(payment.bitrixPaymentId)).toMatchObject({ deletedPaymentCount: 1 });
    expect(await importPayment(payment.bitrixPaymentId)).toMatchObject({ changedPaymentCount: 0, deletedPaymentCount: 0 });
    expect((await client.query('SELECT paid_amount FROM orders WHERE order_id=$1', [orderId])).rows[0].paid_amount).toBe('0.00');
  });

  it('rejects a different Deal and foreign scope without snapshot or money changes', async () => {
    const { payment, dealId } = await seedPayment();
    await repository.convertCrmRequestToProduction(input);
    await client.query('UPDATE crm_sync_mapping SET bitrix_id=$2 WHERE entity_type=\'order\' AND erp_id=$1', [String(orderId), String(Number(dealId) + 1)]);
    await expect(repository.replaceMappedOrderPaymentSnapshots(orderId, [payment], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId))).rejects.toThrow('Deal mapping changed');
    await expect(repository.replaceMappedOrderPaymentSnapshots(orderId, [payment], input.requestId, undefined, String(Number(dealId) + 1), await repository.getPaymentSyncFence(String(Number(dealId) + 1)))).rejects.toThrow('linked to another Deal');
    await expect(importPayment(payment.bitrixPaymentId)).rejects.toThrow('absent or belong to another target');
    expect(await repository.getMappedOrderPayments(orderId, { mode: 'assigned', userId: actorId + 999999 })).toEqual({ linked: false, orderId });
    expect((await client.query('SELECT count(*)::int AS n FROM payments WHERE order_id=$1', [orderId])).rows[0].n).toBe(0);
  });

  it('supports new post-conversion payments and still denies stale or foreign materialization', async () => {
    const { payment, requestId, dealId } = await seedPayment();
    await repository.convertCrmRequestToProduction(input);
    const added = { ...payment, bitrixPaymentId: String(Number(payment.bitrixPaymentId) + 1000000) };
    await repository.replaceMappedOrderPaymentSnapshots(orderId, [payment, added], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId));
    await repository.replaceRequestPaymentSnapshots(requestId, [payment, added], input.requestId, undefined, await repository.getPaymentSyncFence(dealId));
    const version = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    const args = { orderId, bitrixPaymentIds: [added.bitrixPaymentId], expectedOrderVersion: version,
      actorUserId: String(actorId), auditRequestId: input.requestId, scope: { mode: 'all' as const } };
    await expect(repository.materializeMappedOrderPayments({ ...args, expectedOrderVersion: version + 1 })).rejects.toThrow('required for payments');
    await expect(repository.materializeMappedOrderPayments({ ...args, scope: { mode: 'assigned', userId: actorId + 999999 } })).rejects.toThrow('Mapped production order not found');
    expect(await repository.materializeMappedOrderPayments(args)).toMatchObject({ changedPaymentCount: 1 });
    expect((await client.query('SELECT request_id,erp_order_id FROM bitrix24_incoming_request_payment WHERE bitrix_payment_id=$1', [added.bitrixPaymentId])).rows[0]).toEqual({ request_id: String(requestId), erp_order_id: null });
  });

  it('keeps native mapped orders on direct order ownership', async () => {
    const { payment, requestId, dealId } = await seedPayment();
    await repository.convertCrmRequestToProduction(input);
    // Model a normal ERP-origin production order with no incoming CRM request.
    await client.query('DELETE FROM bitrix24_incoming_request_payment WHERE request_id=$1', [requestId]);
    await client.query('DELETE FROM bitrix24_incoming_request WHERE request_id=$1', [requestId]);
    await repository.replaceMappedOrderPaymentSnapshots(orderId, [payment], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId));
    expect((await repository.getMappedOrderPayments(orderId, { mode: 'all' })).payments).toEqual([expect.objectContaining({ bitrixPaymentId: payment.bitrixPaymentId })]);
    expect(await importPayment(payment.bitrixPaymentId)).toMatchObject({ changedPaymentCount: 1 });
    expect(await importPayment(payment.bitrixPaymentId)).toMatchObject({ changedPaymentCount: 0 });
    expect((await client.query('SELECT request_id,erp_order_id FROM bitrix24_incoming_request_payment WHERE bitrix_payment_id=$1', [payment.bitrixPaymentId])).rows[0]).toEqual({ request_id: null, erp_order_id: String(orderId) });
  });

  it('preserves payment identity and original author when another actor updates through request finances', async () => {
    const { payment, requestId, dealId } = await seedPayment();
    await repository.convertCrmRequestToProduction(input);
    await repository.replaceMappedOrderPaymentSnapshots(orderId, [payment], input.requestId, undefined, dealId, await repository.getPaymentSyncFence(dealId));
    await importPayment(payment.bitrixPaymentId);
    const before = (await client.query('SELECT payment_id,created_by FROM payments WHERE order_id=$1', [orderId])).rows[0];
    const name = 'E2E-conversion-editor-' + randomUUID();
    const editor = String((await client.query("INSERT INTO users (username,email,password_hash,role_id) VALUES ($1,$2,'E2E-NO-LOGIN',1) RETURNING user_id", [name, name + '@example.invalid'])).rows[0].user_id);
    await repository.replaceRequestPaymentSnapshots(requestId, [{ ...payment, amount: 600 }], input.requestId, undefined, await repository.getPaymentSyncFence(dealId));
    const version = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    await repository.materializeRequestPayments({ requestId, bitrixPaymentIds: [payment.bitrixPaymentId], expectedOrderVersion: version,
      actorUserId: editor, auditRequestId: input.requestId, scope: { mode: 'all' } });
    expect((await client.query('SELECT payment_id,created_by,edited_by,amount FROM payments WHERE order_id=$1', [orderId])).rows).toEqual([{ ...before, edited_by: editor, amount: '600.00' }]);
    expect((await repository.getMappedOrderPayments(orderId, { mode: 'all' })).payments).toEqual([expect.objectContaining({ erpPaymentId: Number(before.payment_id), amount: 600 })]);
  });

  it('registers deadline, audit and outbox before success; replay creates nothing twice', async () => {
    const result = await repository.convertCrmRequestToProduction(input);
    expect(result.orderKind).toBe('production_order');
    const deadline = (await client.query('SELECT deadline_id,deadline_at,created_by_user_id,responsible_user_id FROM deadline_instances WHERE order_id=$1', [orderId])).rows;
    expect(deadline).toHaveLength(1);
    expect(deadline[0].deadline_at.toISOString()).toBe('2099-09-20T23:59:59.000Z');
    expect(Number(deadline[0].created_by_user_id)).toBe(actorId);
    expect(Number(deadline[0].responsible_user_id)).toBe(actorId);
    const events = (await client.query("SELECT event_type,payload_json FROM outbox_events WHERE aggregate_id=$1 AND event_type='orders.production_initialized'", [String(orderId)])).rows;
    expect(events).toHaveLength(1);
    expect(events[0].payload_json.deadlineInitialization).toBe('transactional_v1');
    expect((await client.query("SELECT count(*)::int AS n FROM audit_log WHERE request_id=$1 AND event='orders.converted_to_production'", [input.requestId])).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::int AS n FROM deadline_events WHERE order_id=$1 AND event_type='DEADLINE_CREATED' AND payload_json->>'requestId'=$2", [orderId, input.requestId])).rows[0].n).toBe(1);
    expect((await client.query("SELECT count(*)::int AS n FROM outbox_events WHERE event_type='deadline.event.created' AND payload_json->>'orderId'=$1", [String(orderId)])).rows[0].n).toBe(1);
    const before = await conversionState();
    expect(Number(before.version)).toBe(result.version);
    expect(await repository.convertCrmRequestToProduction(input)).toEqual(result);
    expect(await conversionState()).toEqual(before);
  });
  it('rejects a reused key with changed payload and denies a foreign manager scope', async () => {
    const before = await conversionState();
    await expect(repository.convertCrmRequestToProduction({ ...input, scope: { mode: 'assigned', userId: actorId + 999999 } })).rejects.toThrow('Order not found');
    expect(await conversionState()).toEqual(before);
    await repository.convertCrmRequestToProduction(input);
    const converted = await conversionState();
    await expect(repository.convertCrmRequestToProduction({ ...input, orderName: input.orderName + '-other' })).rejects.toThrow('Idempotency key was used for another conversion');
    expect(await conversionState()).toEqual(converted);
  });
  it('does not invent a deadline when no planned date exists', async () => {
    await client.query('UPDATE orders SET planned_completion_date=NULL WHERE order_id=$1', [orderId]);
    input.expectedVersion = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    await repository.convertCrmRequestToProduction(input);
    expect((await conversionState()).deadlines).toBe(0);
  });
  it('rolls back project, order, request, audit, outbox and command on deadline SQL failure', async () => {
    const before = await conversionState();
    db.failDeadline = true;
    await expect(repository.convertCrmRequestToProduction(input)).rejects.toThrow('division by zero');
    expect(await conversionState()).toEqual(before);
    db.failDeadline = false;
    await repository.convertCrmRequestToProduction(input);
    expect((await conversionState()).deadlines).toBe(1);
  });
  it('keeps stale version and no-detail guards', async () => {
    const before = await conversionState();
    await expect(repository.convertCrmRequestToProduction({ ...input, expectedVersion: input.expectedVersion + 10 })).rejects.toThrow('Order version conflict');
    expect(await conversionState()).toEqual(before);
    await client.query('UPDATE order_details SET delete_flag=true WHERE order_id=$1', [orderId]);
    input.expectedVersion = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    await expect(repository.convertCrmRequestToProduction(input)).rejects.toMatchObject({ code: 'ORDER_POSITIONS_REQUIRED' });
  });

  it.each([false, true])('converts a goods-only request and materializes its payment without manufacturing details; automatic=%s', async (automatic) => {
    await client.query('DELETE FROM order_details WHERE order_id=$1', [orderId]);
    const unit = (await client.query('SELECT min(unit_id) AS id FROM units')).rows[0].id;
    const catalogId = (await client.query(`INSERT INTO catalog_items(name,kind,unit_id,base_price,created_by,edited_by) VALUES($1,'service',$2,1000,$3,$3) RETURNING id`, [input.orderName, unit, actorId])).rows[0].id;
    await client.query(`INSERT INTO order_catalog_lines(order_id,catalog_item_id,line_number,name,kind,unit_id,unit_name,catalog_version,quantity,unit_price,created_by,edited_by)
      VALUES($1,$2,1,'E2E-service','service',$3,'unit',1,2,1000,$4,$4)`, [orderId, catalogId, unit, actorId]);
    input.expectedVersion = Number((await client.query('SELECT version FROM orders WHERE order_id=$1', [orderId])).rows[0].version);
    const { payment, dealId } = await seedPayment();
    if (automatic) expect((await repository.autoConvertPaidCrmRequest(await autoInput(dealId))).status).toBe('converted');
    else await repository.convertCrmRequestToProduction(input);
    expect(await conversionState()).toMatchObject({ order_kind: 'production_order', request_state: 'converted', deadlines: 1, detail_statuses: null, production_events: 0 });
    expect((await client.query('SELECT total_amount,parts_count,production_status_id FROM orders WHERE order_id=$1', [orderId])).rows[0]).toMatchObject({ total_amount: '2000.00', parts_count: 0, production_status_id: null });
    expect(await importPayment(payment.bitrixPaymentId)).toMatchObject({ changedPaymentCount: automatic ? 0 : 1 });
  });
  it('imports a mapped product row, reaches final 10000, and accepts/blocks widget commands (real PG)', async () => {
    const request = (await client.query('SELECT request_id,bitrix_deal_id FROM bitrix24_incoming_request WHERE linked_order_id=$1', [orderId])).rows[0];
    const dealId = String(request.bitrix_deal_id);
    await client.query('DELETE FROM order_details WHERE order_id=$1', [orderId]);
    // Catalog default deliberately differs from the Bitrix price so the test
    // proves the effective remote price wins; ref_key_1c must propagate.
    const unit = (await client.query('SELECT min(unit_id) AS id FROM units')).rows[0].id;
    const catalogId = Number((await client.query(
      `INSERT INTO catalog_items(name,kind,unit_id,base_price,ref_key_1c,created_by,edited_by)
       VALUES($1,'service',$2,25,'4f1b2c3d-4242-4000-8000-000000004242',$3,$3) RETURNING id`,
      ['E2E-imported-service', unit, actorId],
    )).rows[0].id);
    await repository.upsertProductMapping({
      bitrixProductId: '4242', catalogItemId: catalogId, active: true,
      expectedVersion: 0, actorUserId: actorId, actorUsername: 'E2E',
      actorRole: 'admin', auditRequestId: input.requestId,
    });
    const normalized = normalizeBitrixProductRow({
      id: '101', productId: '4242', productName: 'Service 4242', sort: '10',
      quantity: '1', price: '10000', discountTypeId: '1', discountRate: '10',
      discountSum: '9090.90909091', taxRate: '12', taxIncluded: 'Y',
      measureCode: '4', measureName: 'шт',
    });
    if (!('row' in normalized)) throw new Error('fixture row must normalize');
    const imported = await repository.applyDealProductSnapshot({
      dealId, rows: [normalized.row], invalid: [],
      rowsHash: productRowsHash([normalized.row]),
      opportunity: '10000.00', expectedCurrencyId: 'KZT', currencyId: 'KZT',
      auditRequestId: input.requestId, actorUserId: actorId,
      fence: await repository.getProductSyncFence(dealId),
      remoteUpdatedAt: '2026-09-25T10:00:00+03:00',
    });
    expect(imported.status).toBe('ready');
    const line = (await client.query(
      `SELECT name, catalog_item_id, ref_key_1c, quantity::text, unit_price::text
         FROM order_catalog_lines WHERE order_id=$1 AND delete_flag=false`,
      [orderId],
    )).rows[0];
    expect(line).toMatchObject({
      catalog_item_id: String(catalogId), ref_key_1c: '4f1b2c3d-4242-4000-8000-000000004242',
      quantity: '1.000', unit_price: '10000.00',
    });
    // No-op reapply must not churn versions or duplicate the line.
    const noop = await repository.applyDealProductSnapshot({
      dealId, rows: [normalized.row], invalid: [],
      rowsHash: productRowsHash([normalized.row]),
      opportunity: '10000.00', expectedCurrencyId: 'KZT', currencyId: 'KZT',
      auditRequestId: input.requestId, actorUserId: actorId,
      fence: await repository.getProductSyncFence(dealId),
      remoteUpdatedAt: '2026-09-25T10:00:00+03:00',
    });
    expect(noop.status).toBe('unchanged');
    expect((await client.query(
      'SELECT final_amount::text AS f FROM orders WHERE order_id=$1', [orderId],
    )).rows[0].f).toBe('10000.00');

    const widget = new Bitrix24PaymentWidgetRepository(db, new AuditService());
    const deal = await widget.getDealContext(dealId);
    expect(deal).toMatchObject({
      requestId: Number(request.request_id), requestState: 'active',
      requestSyncStatus: 'ok', orderKind: 'crm_request',
      finalAmount: '10000.00', paidAmount: '0.00', snapshotPaidAmount: '0.00',
      commandReservedAmount: '0.00',
    });
    await client.query(
      `INSERT INTO bitrix24_app_installation
         (member_id, domain, access_token_ciphertext, refresh_token_ciphertext,
          access_token_expires_at, application_token_hash)
       VALUES ('E2E-member','mebelkz.bitrix24.kz','synthetic','synthetic','2030-01-01',$1)`,
      ['c'.repeat(64)],
    );
    const session = {
      sessionId: 'E2E-session', memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
      dealId, bitrixUserId: '17', erpUserId: actorId,
      accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
      accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
    };
    const installation = {
      memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
      applicationTokenHash: 'c'.repeat(64), executorBitrixUserId: '1',
      accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
      accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
    };
    await client.query(
      'INSERT INTO bitrix24_payment_type_mapping (pay_system_id,type_paid_id,active,widget_enabled) SELECT $1,min(type_paid_id),true,true FROM payment_types',
      [orderId + 900000001],
    );
    const paySystem = { paySystemId: orderId + 900000001, name: 'E2E-cash', typePaidId: 1, isDefault: true };
    const commandInput = (key: string, hash: string, amount: string) => ({
      idempotencyKey: key, requestHash: hash,
      session, installation, deal,
      amount, currencyId: 'KZT', paymentDate: '2026-09-25',
      paySystem, comment: null, confirmOverpayment: false,
      callerAccessTokenCiphertext: 'synthetic',
      callerRefreshTokenCiphertext: 'synthetic',
      callerAccessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      originatingRequestId: input.requestId,
      actorDisplayName: 'E2E widget actor',
    });
    // final 10000, paid 0: first 5000 accepted and reserved.
    const firstKey = randomUUID();
    const first = await widget.createCommand(commandInput(firstKey, 'b'.repeat(64), '5000.00'));
    expect(first.created).toBe(true);
    // A second NEW command on the same Deal is guarded while the first is
    // in-flight — serial continuation happens only after completion.
    await expect(widget.createCommand(commandInput(randomUUID(), 'c'.repeat(64), '5000.00')))
      .rejects.toMatchObject({ code: 'BITRIX24_PAYMENT_CREATE_IN_PROGRESS' });
    // Replaying the first accepted key returns the stored command, never a
    // duplicate.
    const replayed = await widget.createCommand(commandInput(firstKey, 'b'.repeat(64), '5000.00'));
    expect(replayed.created).toBe(false);
    expect(replayed.command.commandId).toBe(first.command.commandId);
  });

  it('rejects a new widget command on an archived request (real PG)', async () => {
    const { payment, dealId } = await seedPayment();
    await client.query(
      `INSERT INTO bitrix24_app_installation
         (member_id, domain, access_token_ciphertext, refresh_token_ciphertext,
          access_token_expires_at, application_token_hash)
       VALUES ('E2E-member','mebelkz.bitrix24.kz','synthetic','synthetic','2030-01-01',$1)`,
      ['c'.repeat(64)],
    );
    await client.query(
      `UPDATE orders SET delete_flag=true WHERE order_id=$1`,
      [orderId],
    );
    await client.query(
      `UPDATE bitrix24_incoming_request SET state='archived' WHERE request_id=$1`,
      [(await client.query('SELECT request_id FROM bitrix24_incoming_request WHERE linked_order_id=$1', [orderId])).rows[0].request_id],
    );
    const widget = new Bitrix24PaymentWidgetRepository(db, new AuditService());
    const deal = await widget.getDealContext(dealId);
    expect(deal.requestState).toBe('archived');
    await expect(widget.createCommand({
      idempotencyKey: randomUUID(), requestHash: 'e'.repeat(64),
      session: {
        sessionId: 'E2E-session', memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
        dealId, bitrixUserId: '17', erpUserId: actorId,
        accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
        accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      },
      installation: {
        memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
        applicationTokenHash: 'c'.repeat(64), executorBitrixUserId: '1',
        accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
        accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      },
      deal,
      amount: '5000.00', currencyId: 'KZT', paymentDate: '2026-09-25',
      paySystem: { paySystemId: payment.paySystemId, name: 'E2E-cash', typePaidId: 1, isDefault: true },
      comment: null, confirmOverpayment: false,
      callerAccessTokenCiphertext: 'synthetic',
      callerRefreshTokenCiphertext: 'synthetic',
      callerAccessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      originatingRequestId: input.requestId,
      actorDisplayName: 'E2E widget actor',
    })).rejects.toMatchObject({ code: 'BITRIX24_REQUEST_NOT_ACTIVE' });
    expect((await client.query(
      'SELECT count(*)::int AS n FROM bitrix24_manual_payment_command WHERE bitrix_deal_id=$1',
      [dealId],
    )).rows[0].n).toBe(0);
  });

  it('rejects a payment reconcile fetched before a newer snapshot write (generation fence)', async () => {
    const { payment, requestId, dealId } = await seedPayment();
    // The first successful apply advanced the generation; a reconcile that
    // captured the fence before it must not overwrite newer state.
    const stale = await repository.getPaymentSyncFence(dealId);
    const newer = await repository.replaceRequestPaymentSnapshots(
      requestId, [{ ...payment, amount: 600 }], input.requestId, undefined, stale);
    expect(newer.applied).toBe(true);
    const delayed = await repository.replaceRequestPaymentSnapshots(
      requestId, [{ ...payment, amount: 500 }], input.requestId, undefined, stale);
    expect(delayed.applied).toBe(false);
    expect((await client.query(
      'SELECT amount FROM bitrix24_incoming_request_payment WHERE bitrix_payment_id=$1',
      [payment.bitrixPaymentId],
    )).rows[0].amount).toBe('600.00');
    // A fresh fence + refetch applies normally — no permanent wedging.
    const fresh = await repository.getPaymentSyncFence(dealId);
    const retried = await repository.replaceRequestPaymentSnapshots(
      requestId, [payment], input.requestId, undefined, fresh);
    expect(retried.applied).toBe(true);
  });

  it('service.create(5000) traverses remote create, snapshot, auto-conversion and ERP payment (real PG)', async () => {
    const request = (await client.query('SELECT request_id,bitrix_deal_id FROM bitrix24_incoming_request WHERE linked_order_id=$1', [orderId])).rows[0];
    const dealId = String(request.bitrix_deal_id);
    // final_amount=10000 comes ONLY from the imported mapped product row.
    await client.query('DELETE FROM order_details WHERE order_id=$1', [orderId]);
    const unit = (await client.query('SELECT min(unit_id) AS id FROM units')).rows[0].id;
    const catalogId = Number((await client.query(
      `INSERT INTO catalog_items(name,kind,unit_id,base_price,ref_key_1c,created_by,edited_by)
       VALUES($1,'service',$2,25,'4f1b2c3d-4242-4000-8000-000000004242',$3,$3) RETURNING id`,
      ['E2E-fullflow-service', unit, actorId],
    )).rows[0].id);
    await repository.upsertProductMapping({
      bitrixProductId: '4242', catalogItemId: catalogId, active: true,
      expectedVersion: 0, actorUserId: actorId, actorUsername: 'E2E',
      actorRole: 'admin', auditRequestId: input.requestId,
    });
    const rawRow = {
      id: '101', productId: '4242', productName: 'Service 4242', sort: '10',
      quantity: '1', price: '10000', discountTypeId: '1', discountRate: '10',
      discountSum: '9090.90909091', taxRate: '12', taxIncluded: 'Y',
      measureCode: '4', measureName: 'шт',
    };
    const paySystemId = orderId + 900000001;
    await client.query(
      `INSERT INTO bitrix24_pay_system_catalog
         (pay_system_id, name, active, is_cash, allow_edit_payment, have_payment,
          entity_registry_type, raw_hash, last_fetched_at)
       VALUES ($1,'E2E-cash',true,true,false,true,'ORDER',$2,now())`,
      [paySystemId, 'b'.repeat(64)],
    );
    await client.query(
      `INSERT INTO bitrix24_payment_type_mapping (pay_system_id,type_paid_id,active,widget_enabled)
       SELECT $1,min(type_paid_id),true,true FROM payment_types`,
      [paySystemId],
    );
    await client.query(
      `INSERT INTO bitrix24_app_installation
         (member_id, domain, access_token_ciphertext, refresh_token_ciphertext,
          access_token_expires_at, application_token_hash)
       VALUES ('E2E-member','mebelkz.bitrix24.kz','synthetic','synthetic','2030-01-01',$1)`,
      ['c'.repeat(64)],
    );
    // Widget actor mapping required by materializeCommandInTransaction.
    await client.query(
      `INSERT INTO bitrix24_user_mapping (bitrix_user_id, erp_user_id, is_active)
       VALUES ('17', $1, true) ON CONFLICT DO NOTHING`,
      [actorId],
    );
    // Fake remote portal — the only non-real boundary.
    const portalPayments = new Map<string, Record<string, unknown>>();
    const dealItem = {
      id: Number(dealId), title: 'E2E fullflow', opportunity: '10000',
      currencyId: 'KZT', updatedTime: '2026-09-25T10:00:00+03:00', contactId: 42,
    };
    const fakeBitrix = {
      getDeal: vi.fn(async () => dealItem),
      getCrmItem: vi.fn(async () => dealItem),
      listDealProductRows: vi.fn(async () => [rawRow]),
      listDealPaymentIds: vi.fn(async () => [...portalPayments.keys()]),
      createDealPayment: vi.fn(async () => {
        const paymentId = String(9100 + portalPayments.size + 1);
        portalPayments.set(paymentId, { id: paymentId });
        return paymentId;
      }),
      updatePayment: vi.fn(async (input: { paymentId: string; fields: Record<string, unknown> }) => {
        portalPayments.set(input.paymentId, {
          ...(portalPayments.get(input.paymentId) ?? {}),
          currency: 'KZT',
          ...input.fields,
          dateBill: input.fields.datePaid,
        });
      }),
      getPayment: vi.fn(async (arg: unknown) =>
        portalPayments.get(typeof arg === 'object' ? (arg as { paymentId: string }).paymentId : String(arg))),
      currentUser: vi.fn(async ({ accessToken }: { accessToken: string }) =>
        accessToken === 'executor-token'
          ? { id: '1', active: true, admin: true }
          : { id: '17', active: true, admin: false }),
      getUserDisplayName: vi.fn(async () => 'E2E cashier'),
      withRequestGuard: async (
        guard: () => Promise<void>,
        operation: () => Promise<unknown>,
      ) => { await guard(); return operation(); },
    };
    const serviceAccount = (await client.query(
      `INSERT INTO users(username,email,password_hash,role_id,is_service_account)
       SELECT $1::text,$1::text || '@example.invalid','E2E-NO-LOGIN',role_id,true
         FROM roles WHERE role_code='integration_service' RETURNING user_id`,
      ['E2E-flow-service-' + randomUUID()],
    )).rows[0];
    const CMD_KEY = Buffer.alloc(32, 9).toString('base64');
    const flags = {
      enabled: true, dryRun: false, autoConvertPaidRequests: true,
      relayOwner: 'worker', portalTimezone: 'Asia/Almaty',
      actorUserId: Number(serviceAccount.user_id),
      initialOrderStatusCode: 'legacy_1', initialProductionStatusCode: 'drawn',
    };
    const config = {
      getBitrix24: () => ({ currencyId: 'KZT', paySystemId: 12 }),
      getReverseSync: () => flags,
      getPaymentWidget: () => ({
        enabled: true, commandTokenEncryptionKey: CMD_KEY, commandLeaseMs: 60_000,
      }),
      isProductionInitializationReady: () => true,
    };
    const widget = new Bitrix24PaymentWidgetRepository(db, new AuditService());
    const productSync = new Bitrix24ProductSyncService(repository, fakeBitrix as never, config as never);
    const paidConversion = new Bitrix24PaidConversionService(repository, config as never);
    const processor = new Bitrix24ReverseProcessorService(
      repository, fakeBitrix as never, config as never, paidConversion, productSync,
    );
    const service = new Bitrix24ManualPaymentCommandService(
      widget,
      { requireCreateAccess: vi.fn().mockResolvedValue(undefined) } as never,
      fakeBitrix as never,
      { getAccessToken: vi.fn().mockResolvedValue('executor-token') } as never,
      config as never,
      { refreshIfStale: vi.fn().mockResolvedValue(undefined) } as never,
      paidConversion,
      productSync,
      processor,
    );
    // The real widget path opens the context first — this performs the
    // product-row import and returns the authoritative order version.
    const context = await service.getContext({
      session: {
        sessionId: 'E2E-session', memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
        dealId, bitrixUserId: '17', erpUserId: actorId,
        accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
        accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      },
      actor: { id: String(actorId), permissions: ['bitrix24.payments.create'] },
      actorDisplayName: 'E2E widget actor',
      accessToken: 'actor-token', refreshToken: 'refresh-token',
      installation: {
        memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
        applicationTokenHash: 'c'.repeat(64), executorBitrixUserId: '1',
        accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
        accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      },
    } as never);
    expect(context.canCreate).toBe(true);
    expect(context.blockReason).toBeNull();
    expect(context.erp).toMatchObject({
      linkState: 'crm_request', requestId: Number(request.request_id),
      orderId, finalAmount: '10000.00', paidAmount: '0.00', debtAmount: '10000.00',
    });
    const orderVersion = context.erp.orderVersion;
    const result = await service.create({
      authenticated: {
        session: {
          sessionId: 'E2E-session', memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
          dealId, bitrixUserId: '17', erpUserId: actorId,
          accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
          accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
        },
        actor: { id: String(actorId), permissions: ['bitrix24.payments.create'] },
        actorDisplayName: 'E2E widget actor',
        accessToken: 'actor-token', refreshToken: 'refresh-token',
        installation: {
          memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
          applicationTokenHash: 'c'.repeat(64), executorBitrixUserId: '1',
          accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
          accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
        },
      } as never,
      idempotencyKey: randomUUID(),
      body: {
        amount: '5000.00', paymentDate: '2026-09-25', paySystemId,
        comment: null, expectedOrderVersion: orderVersion, confirmOverpayment: false,
      },
      requestId: input.requestId,
    });
    expect(result.response.status).toBe('completed');
    expect(result.created).toBe(true);
    // Same production order: final 10000 (imported row), paid 5000, debt 5000.
    const state = await conversionState();
    expect(state).toMatchObject({ order_kind: 'production_order', request_state: 'converted' });
    expect((await client.query(
      'SELECT final_amount::text AS f, paid_amount::text AS p FROM orders WHERE order_id=$1', [orderId],
    )).rows[0]).toEqual({ f: '10000.00', p: '5000.00' });
    expect((await client.query(
      'SELECT amount::text AS a FROM payments WHERE order_id=$1 AND delete_flag=false', [orderId],
    )).rows).toEqual([{ a: '5000.00' }]);
    expect((await client.query(
      'SELECT count(*)::int AS n FROM bitrix24_manual_payment_command WHERE bitrix_deal_id=$1', [dealId],
    )).rows[0].n).toBe(1);
    expect((await client.query(
      `SELECT erp_payment_id FROM bitrix24_incoming_request_payment WHERE manual_command_id=(SELECT command_id FROM bitrix24_manual_payment_command WHERE bitrix_deal_id=$1)`,
      [dealId],
    )).rows[0].erp_payment_id).not.toBeNull();
    expect((await client.query(
      'SELECT count(*)::int AS n FROM projects WHERE project_id=(SELECT project_id FROM orders WHERE order_id=$1)', [orderId],
    )).rows[0].n).toBe(1);
    expect((await client.query(
      'SELECT count(*)::int AS n FROM order_details WHERE order_id=$1', [orderId],
    )).rows[0].n).toBe(0);
    // After the first command completed (paid 5000, remaining 5000), the
    // second NEW payment through the real service path is admitted.
    const authenticated = {
      session: {
        sessionId: 'E2E-session', memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
        dealId, bitrixUserId: '17', erpUserId: actorId,
        accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
        accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      },
      actor: { id: String(actorId), permissions: ['bitrix24.payments.create'] },
      actorDisplayName: 'E2E widget actor',
      accessToken: 'actor-token', refreshToken: 'refresh-token',
      installation: {
        memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
        applicationTokenHash: 'c'.repeat(64), executorBitrixUserId: '1',
        accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
        accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      },
    } as never;
    const secondOrderVersion = Number((await client.query(
      'SELECT version FROM orders WHERE order_id=$1', [orderId],
    )).rows[0].version);
    const second = await service.create({
      authenticated,
      idempotencyKey: randomUUID(),
      body: {
        amount: '5000.00', paymentDate: '2026-09-25', paySystemId,
        comment: null, expectedOrderVersion: secondOrderVersion, confirmOverpayment: false,
      },
      requestId: input.requestId,
    });
    expect(second.created).toBe(true);
    expect(second.response.status).toBe('completed');
    expect((await client.query(
      'SELECT paid_amount::text AS p FROM orders WHERE order_id=$1', [orderId],
    )).rows[0].p).toBe('10000.00');
    // Fully paid now — a third NEW payment is an overpayment unless confirmed.
    // The second completion bumped the order version; the widget re-reads the
    // context, so use the version the context currently reports.
    const contextAfterSecond = await service.getContext(authenticated);
    expect(contextAfterSecond.erp.paidAmount).toBe('10000.00');
    await expect(service.create({
      authenticated,
      idempotencyKey: randomUUID(),
      body: {
        amount: '1.00', paymentDate: '2026-09-25', paySystemId,
        comment: null, expectedOrderVersion: contextAfterSecond.erp.orderVersion, confirmOverpayment: false,
      },
      requestId: input.requestId,
    })).rejects.toMatchObject({ code: 'PAYMENT_OVERPAYMENT_CONFIRMATION_REQUIRED' });
    expect((await client.query(
      'SELECT count(*)::int AS n FROM payments WHERE order_id=$1', [orderId],
    )).rows[0].n).toBe(2);
    expect(fakeBitrix.createDealPayment).toHaveBeenCalledTimes(2);
    // Exact replay: same key resumes to the same completed command.
    const replayed = await service.create({
      authenticated: {
        session: {
          sessionId: 'E2E-session', memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
          dealId, bitrixUserId: '17', erpUserId: actorId,
          accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
          accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
        },
        actor: { id: String(actorId), permissions: ['bitrix24.payments.create'] },
        actorDisplayName: 'E2E widget actor',
        accessToken: 'actor-token', refreshToken: 'refresh-token',
        installation: {
          memberId: 'E2E-member', domain: 'mebelkz.bitrix24.kz',
          applicationTokenHash: 'c'.repeat(64), executorBitrixUserId: '1',
          accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
          accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
        },
      } as never,
      idempotencyKey: result.response.commandId ? (await client.query('SELECT idempotency_key FROM bitrix24_manual_payment_command WHERE command_id=$1', [result.response.commandId])).rows[0].idempotency_key : 'none',
      body: {
        amount: '5000.00', paymentDate: '2026-09-25', paySystemId,
        comment: null, expectedOrderVersion: orderVersion, confirmOverpayment: false,
      },
      requestId: input.requestId,
    });
    expect(replayed.created).toBe(false);
    expect(replayed.response.status).toBe('completed');
    expect((await client.query(
      'SELECT count(*)::int AS n FROM payments WHERE order_id=$1', [orderId],
    )).rows[0].n).toBe(2);
  });

  it('retains stage deadline registration via the existing sync after stages exist', async () => {
    await repository.convertCrmRequestToProduction(input);
    const stage = (await client.query(`INSERT INTO order_workshops (order_id,workshop_id,production_status_id,created_by,planned_completion_date)
      SELECT $1,min(workshop_id),1,$2,'2099-09-15' FROM workshops RETURNING order_workshop_id`, [orderId, actorId])).rows[0];
    await new PgOrderDeadlineSync(db).syncOrderDeadlinesInTransaction(db.tx, {
      orderId, currentUser: { id: String(actorId), username: input.actorUsername, role: 'admin', roleId: 1, permissions: [] },
      eventType: 'ORDER_UPDATED', requestId: input.requestId,
    }, false);
    const deadlines = (await client.query("SELECT entity_id,deadline_at FROM deadline_instances WHERE order_id=$1 AND entity_type='order_stage'", [orderId])).rows;
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0].entity_id).toBe(String(stage.order_workshop_id));
    expect(deadlines[0].deadline_at.toISOString()).toBe('2099-09-15T23:59:59.000Z');
  });
});
