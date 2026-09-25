import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../../../common/audit/audit.service';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import { PgBitrix24ReverseRepository, type ReversePaymentSnapshot } from './pg-bitrix24-reverse-repository';
import { Bitrix24PaymentWidgetRepository } from '../widget/bitrix24-payment-widget.repository';
import { normalizeBitrixProductRow } from './bitrix24-product-rows';
import { productRowsHash } from './bitrix24-product-rows';

// Separate-connection races need COMMITTED fixtures — an uncommitted seed is
// invisible to the second connection. This suite runs ONLY against an owned
// disposable database: the URL must opt in via ERP_BITRIX_RACE_DATABASE_URL,
// the database name must start with "bitrix_race_", and the runner owns the
// DB drop afterwards. Nothing here must ever point at a shared stage DB.
const url = process.env.ERP_BITRIX_RACE_DATABASE_URL;
const targetEnv = process.env.ERP_BITRIX_RACE_TARGET_ENV;

function assertRaceTarget(): void {
  expect(targetEnv).toBe('backend-test');
  const parsed = new URL(url!);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!dbName.startsWith('bitrix_race_')) {
    throw new Error(
      `ERP_BITRIX_RACE_DATABASE_URL must point at an owned disposable "bitrix_race_*" database (got "${dbName}")`,
    );
  }
}

/** Real BEGIN/COMMIT transactions — one per call, on the caller's connection. */
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
    await this.client.query("SET LOCAL lock_timeout='10s'");
    await this.client.query("SET LOCAL statement_timeout='15s'");
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

describe.skipIf(!url)('Bitrix24 payment/product races on an owned disposable PostgreSQL', () => {
  let pool: Pool;
  let connA: PoolClient | undefined;
  let connB: PoolClient | undefined;
  let repoA: PgBitrix24ReverseRepository;
  let repoB: PgBitrix24ReverseRepository;
  let widgetA: Bitrix24PaymentWidgetRepository;
  let widgetB: Bitrix24PaymentWidgetRepository;
  let actorId: number;
  let orderId: number;
  let requestId: number;
  const tag = 'E2E-race-' + randomUUID();
  let dealId: string;
  const seededCatalogIds: number[] = [];

  beforeAll(async () => {
    assertRaceTarget();
    pool = new Pool({
      connectionString: url, max: 2, connectionTimeoutMillis: 5000,
      statement_timeout: 15000, lock_timeout: '10s' as unknown as number,
    });
    connA = await pool.connect();
    connB = await pool.connect();
    repoA = new PgBitrix24ReverseRepository(new CommittedDatabase(connA), new AuditService());
    repoB = new PgBitrix24ReverseRepository(new CommittedDatabase(connB), new AuditService());
    widgetA = new Bitrix24PaymentWidgetRepository(new CommittedDatabase(connA), new AuditService());
    widgetB = new Bitrix24PaymentWidgetRepository(new CommittedDatabase(connB), new AuditService());

    actorId = Number((await connA.query(
      `INSERT INTO users (username,email,password_hash,role_id) VALUES ($1,$2,'E2E-NO-LOGIN',1) RETURNING user_id`,
      [tag, tag + '@example.invalid'],
    )).rows[0].user_id);
    // Audit/created_by triggers read the session user from both app.user_id
    // and hasura.user — set them on EVERY connection the fixture uses.
    for (const conn of [connA, connB]) {
      await conn.query('SELECT set_config($1,$2,false)', ['app.user_id', String(actorId)]);
      await conn.query('SELECT set_config($1,$2,false)', [
        'hasura.user',
        JSON.stringify({ 'x-hasura-user-id': String(actorId), 'x-hasura-role': 'admin' }),
      ]);
    }
    const clientId = Number((await connA.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    orderId = Number((await connA.query(
      `INSERT INTO orders (order_name,client_id,order_kind,source_system,order_status_id,payment_status_id,created_by,manager_id,production_status_from_details_enabled,planned_completion_date)
       VALUES ($1,$2,'crm_request','bitrix24',1,1,$3,$3,false,'2099-09-20') RETURNING order_id`,
      [tag, clientId, actorId],
    )).rows[0].order_id);
    dealId = String(orderId + 900000000);
    // Exact counterparty mapping — same shape as the rollback fixture.
    const contactBitrixId = String(clientId + 900000000);
    await connA.query(
      `INSERT INTO crm_sync_mapping (entity_type,erp_id,bitrix_object,bitrix_id,status,source_system)
       VALUES ('client',$1,'contact',$2,'active','bitrix24'),('order',$3,'deal',$4,'active','bitrix24')`,
      [String(clientId), contactBitrixId, String(orderId), dealId],
    );
    requestId = Number((await connA.query(
      `INSERT INTO bitrix24_incoming_request (bitrix_deal_id,title,bitrix_url,state,linked_order_id,client_id,counterparty_object_type,counterparty_bitrix_id)
       VALUES ($1,$2,'https://example.invalid/E2E','active',$3,$4,'contact',$5) RETURNING request_id`,
      [dealId, tag, orderId, clientId, contactBitrixId],
    )).rows[0].request_id);
    const unit = (await connA.query('SELECT min(unit_id) AS id FROM units')).rows[0].id;
    const catalogItemId = Number((await connA.query(
      `INSERT INTO catalog_items(name,kind,unit_id,base_price,created_by,edited_by)
       VALUES($1,'service',$2,5000,$3,$3) RETURNING id`,
      [tag, unit, actorId],
    )).rows[0].id);
    seededCatalogIds.push(catalogItemId);
    const paySystemId = orderId + 900000001;
    await connA.query(
      `INSERT INTO bitrix24_pay_system_catalog
         (pay_system_id, name, active, is_cash, allow_edit_payment, have_payment,
          entity_registry_type, raw_hash, last_fetched_at)
       VALUES ($1,'E2E-race-cash',true,true,false,true,'ORDER',$2,now())`,
      [paySystemId, 'b'.repeat(64)],
    );
    await connA.query(
      `INSERT INTO bitrix24_payment_type_mapping (pay_system_id,type_paid_id,active,widget_enabled)
       SELECT $1,min(type_paid_id),true,true FROM payment_types`,
      [paySystemId],
    );
    await connA.query(
      `INSERT INTO bitrix24_app_installation
         (member_id, domain, access_token_ciphertext, refresh_token_ciphertext,
          access_token_expires_at, application_token_hash)
       VALUES ($1,'mebelkz.bitrix24.kz','synthetic','synthetic','2030-01-01',$2)`,
      [tag, 'c'.repeat(64)],
    );
    // One product mapping + a product row import so the request is 'ready'
    // with a real 10000-total catalog line.
    await repoA.upsertProductMapping({
      bitrixProductId: '4242', catalogItemId, active: true,
      expectedVersion: 0, actorUserId: actorId, actorUsername: tag,
      actorRole: 'admin', auditRequestId: tag,
    });
    const normalized = normalizeBitrixProductRow({
      id: '101', productId: '4242', productName: 'Race product', sort: '10',
      quantity: '1', price: '10000', discountTypeId: '1', discountRate: '10',
      discountSum: '9090.90909091', taxRate: '12', taxIncluded: 'Y',
      measureCode: '4', measureName: 'шт',
    });
    if (!('row' in normalized)) throw new Error('fixture row must normalize');
    const applied = await repoA.applyDealProductSnapshot({
      dealId, rows: [normalized.row], invalid: [],
      rowsHash: productRowsHash([normalized.row]),
      opportunity: '10000.00', expectedCurrencyId: 'KZT', currencyId: 'KZT',
      auditRequestId: tag, actorUserId: actorId,
      fence: await repoA.getProductSyncFence(dealId),
      remoteUpdatedAt: '2026-09-25T10:00:00+03:00',
    });
    expect(applied.status).toBe('ready');
  });

  afterAll(async () => {
    // The disposable database is dropped by the runner; just release the
    // connections — always, even when beforeAll failed halfway.
    try { connA?.release(); } catch { /* already released */ }
    try { connB?.release(); } catch { /* already released */ }
    await pool?.end().catch(() => undefined);
  });

  const snapshot = (suffix: string): ReversePaymentSnapshot => ({
    bitrixPaymentId: String(orderId + 900000000 + Number(suffix)),
    paySystemId: orderId + 900000001, paySystemName: 'E2E-race',
    amount: 500, currencyId: 'KZT', paid: true,
    paymentDate: new Date('2026-09-25T12:00:00+05:00'),
    bitrixCreatedAt: new Date('2026-09-25T10:00:00+03:00'),
    bitrixUpdatedAt: new Date('2026-09-25T12:00:00+03:00'),
    normalizedHash: randomUUID(),
  });

  it('first-use payment generation CAS: exactly one concurrent apply wins', async () => {
    // No generation row exists yet — both connections fence at 0.
    expect(await repoA.getPaymentSyncFence(dealId)).toBe(0);
    const [a, b] = await Promise.all([
      repoA.replaceRequestPaymentSnapshots(requestId, [snapshot('101')], tag, undefined, 0),
      repoB.replaceRequestPaymentSnapshots(requestId, [snapshot('102')], tag, undefined, 0),
    ]);
    expect([a.applied, b.applied].sort()).toEqual([false, true]);
    // Only the winner's snapshot exists; the generation advanced once.
    const rows = (await connA!.query(
      'SELECT bitrix_payment_id FROM bitrix24_incoming_request_payment WHERE request_id=$1',
      [requestId],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(await repoA.getPaymentSyncFence(dealId)).toBe(1);
  });

  it('stale payment fetch from the loser generation is rejected; a fresh fetch applies', async () => {
    const staleGen = await repoA.getPaymentSyncFence(dealId);
    // Newer apply advances the generation.
    const p1 = snapshot('111');
    const p2 = snapshot('112');
    const newer = await repoA.replaceRequestPaymentSnapshots(requestId, [p1, p2], tag, undefined, staleGen);
    expect(newer.applied).toBe(true);
    // A delayed fetch captured at the older generation must not overwrite it.
    const delayed = await repoB.replaceRequestPaymentSnapshots(requestId, [p1], tag, undefined, staleGen);
    expect(delayed.applied).toBe(false);
    const count = (await connA!.query(
      "SELECT count(*)::int AS n FROM bitrix24_incoming_request_payment WHERE request_id=$1 AND state<>'deleted'",
      [requestId],
    )).rows[0].n;
    expect(count).toBe(2);
    // A fresh fence + refetch applies normally.
    const fresh = await repoB.getPaymentSyncFence(dealId);
    expect((await repoB.replaceRequestPaymentSnapshots(requestId, [p1], tag, undefined, fresh)).applied).toBe(true);
  });

  it('same-key concurrent createCommand yields exactly one reservation', async () => {
    const session = (connTag: string) => ({
      sessionId: `${connTag}`, memberId: tag, domain: 'mebelkz.bitrix24.kz',
      dealId, bitrixUserId: '17', erpUserId: actorId,
      accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
      accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    const installation = {
      memberId: tag, domain: 'mebelkz.bitrix24.kz',
      applicationTokenHash: 'c'.repeat(64), executorBitrixUserId: '1',
      accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
      accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
    };
    const key = randomUUID();
    const hash = 'f'.repeat(64);
    const dealA = await widgetA.getDealContext(dealId);
    const dealB = await widgetB.getDealContext(dealId);
    const inputFor = (deal: typeof dealA, connTag: string) => ({
      idempotencyKey: key, requestHash: hash,
      session: session(connTag), installation, deal,
      amount: '5000.00', currencyId: 'KZT', paymentDate: '2026-09-25',
      paySystem: { paySystemId: orderId + 900000001, name: 'E2E-race', typePaidId: 1, isDefault: true },
      comment: null, confirmOverpayment: false,
      callerAccessTokenCiphertext: 'synthetic',
      callerRefreshTokenCiphertext: 'synthetic',
      callerAccessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      originatingRequestId: tag,
      actorDisplayName: 'E2E race actor',
    });
    const [a, b] = await Promise.all([
      widgetA.createCommand(inputFor(dealA, 'A')),
      widgetB.createCommand(inputFor(dealB, 'B')),
    ]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.command.commandId).toBe(b.command.commandId);
    const rows = (await connA!.query(
      'SELECT count(*)::int AS n FROM bitrix24_manual_payment_command WHERE idempotency_key=$1',
      [key],
    )).rows;
    expect(rows[0].n).toBe(1);
    // Leave the deal's in-flight-create slot free for later tests: the stored
    // command served its purpose — terminate it like a failed remote call.
    await connA!.query(
      `UPDATE bitrix24_manual_payment_command SET status='failed_terminal'
        WHERE member_id=$1`,
      [tag],
    );
  });

  it('concurrent product mapping upserts serialize on the expectedVersion CAS', async () => {
    const second = Number((await connA!.query(
      `INSERT INTO catalog_items(name,kind,unit_id,base_price,created_by,edited_by)
       SELECT $1,'service',min(unit_id),1000,$2,$2 FROM units RETURNING id`,
      [tag + '-b', actorId],
    )).rows[0].id);
    seededCatalogIds.push(second);
    const [a, b] = await Promise.allSettled([
      repoA.upsertProductMapping({
        bitrixProductId: '4242', catalogItemId: second, active: true,
        expectedVersion: 1, actorUserId: actorId, actorUsername: tag,
        actorRole: 'admin', auditRequestId: tag,
      }),
      repoB.upsertProductMapping({
        bitrixProductId: '4242', catalogItemId: second, active: true,
        expectedVersion: 1, actorUserId: actorId, actorUsername: tag,
        actorRole: 'admin', auditRequestId: tag,
      }),
    ]);
    const ok = [a, b].filter((r) => r.status === 'fulfilled').length;
    const conflicted = [a, b].filter((r) => r.status === 'rejected').length;
    // One writer advances the version; the loser gets the version conflict.
    expect(ok).toBe(1);
    expect(conflicted).toBe(1);
    const loser = a.status === 'rejected' ? a.reason
      : b.status === 'rejected' ? b.reason : null;
    expect(loser).toMatchObject({ statusCode: 409 });
    // The remap changed the product fingerprint — reconcile the product
    // snapshot back to 'ready' under the CURRENT mapping before later tests
    // open widget commands.
    const normalized = normalizeBitrixProductRow({
      id: '101', productId: '4242', productName: 'Race product', sort: '10',
      quantity: '1', price: '10000', discountTypeId: '1', discountRate: '10',
      discountSum: '9090.90909091', taxRate: '12', taxIncluded: 'Y',
      measureCode: '4', measureName: 'шт',
    });
    if (!('row' in normalized)) throw new Error('fixture row must normalize');
    const reconciled = await repoA.applyDealProductSnapshot({
      dealId, rows: [normalized.row], invalid: [],
      rowsHash: productRowsHash([normalized.row]),
      opportunity: '10000.00', expectedCurrencyId: 'KZT', currencyId: 'KZT',
      auditRequestId: tag, actorUserId: actorId,
      fence: await repoA.getProductSyncFence(dealId),
      remoteUpdatedAt: '2026-09-25T10:02:00+03:00',
    });
    expect(['ready', 'unchanged']).toContain(reconciled.status);
  });

  it('concurrent first mapping creation accepts one target and rejects the other', async () => {
    const productId = '4243';
    expect(seededCatalogIds).toHaveLength(2);
    const write = (repository: PgBitrix24ReverseRepository, catalogItemId: number) =>
      repository.upsertProductMapping({
        bitrixProductId: productId, catalogItemId, active: true,
        expectedVersion: 0, actorUserId: actorId, actorUsername: tag,
        actorRole: 'admin', auditRequestId: tag,
      });
    const results = await Promise.allSettled([
      write(repoA, seededCatalogIds[0]), write(repoB, seededCatalogIds[1]),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 });
    const rows = (await connA!.query(
      'SELECT catalog_item_id, version FROM bitrix24_product_mapping WHERE bitrix_product_id=$1',
      [productId],
    )).rows;
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].version)).toBe(1);
    expect(seededCatalogIds).toContain(Number(rows[0].catalog_item_id));
  });

  it('widget verification save fenced against a concurrent reverse reconcile', async () => {
    // A completed remote create leaves a 'remote_created' command waiting for
    // the verification snapshot save — with the fence captured BEFORE the
    // remote GET, a newer reconcile in between must make the save stale.
    const session = {
      sessionId: 'race-save', memberId: tag, domain: 'mebelkz.bitrix24.kz',
      dealId, bitrixUserId: '17', erpUserId: actorId,
      accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
      accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
    };
    const installation = {
      memberId: tag, domain: 'mebelkz.bitrix24.kz',
      applicationTokenHash: 'c'.repeat(64), executorBitrixUserId: '1',
      accessTokenCiphertext: 'synthetic', refreshTokenCiphertext: 'synthetic',
      accessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
    };
    const deal = await widgetA.getDealContext(dealId);
    const created = await widgetA.createCommand({
      idempotencyKey: randomUUID(), requestHash: 'a'.repeat(64),
      session, installation, deal,
      amount: '5000.00', currencyId: 'KZT', paymentDate: '2026-09-25',
      paySystem: { paySystemId: orderId + 900000001, name: 'E2E-race', typePaidId: 1, isDefault: true },
      comment: null, confirmOverpayment: false,
      callerAccessTokenCiphertext: 'synthetic',
      callerRefreshTokenCiphertext: 'synthetic',
      callerAccessTokenExpiresAt: new Date('2030-01-01T00:00:00Z'),
      originatingRequestId: tag,
      actorDisplayName: 'E2E race actor',
    });
    expect(created.created).toBe(true);
    // Walk the real create lifecycle: processing → pre_create_saved →
    // remote_create_started → remote_created — transition() only persists
    // bitrix_payment_id when each status guard matches.
    await widgetA.savePreCreate(created.command.commandId, []);
    await widgetA.markRemoteCreateStarted(created.command.commandId);
    await widgetA.markRemoteCreated(created.command.commandId, '9101');
    const staleGen = await widgetA.getPaymentSyncFence(dealId);
    // A newer reverse reconcile commits in between.
    const payment = snapshot('201');
    const newer = await repoB.replaceRequestPaymentSnapshots(
      requestId, [payment], tag, undefined, staleGen);
    expect(newer.applied).toBe(true);
    // The delayed verification save is rejected — it must re-verify with a
    // fresh generation, never overwrite the newer state.
    const stale = await widgetA.saveVerifiedSnapshot({
      command: created.command, paymentName: 'E2E-race',
      paidAt: new Date('2026-09-25T12:00:00+05:00'),
      normalizedHash: randomUUID(), rawAmount: '5000.00', rawCurrency: 'KZT',
      expectedGen: staleGen,
    });
    expect(stale.applied).toBe(false);
    const fresh = await widgetA.getPaymentSyncFence(dealId);
    const saved = await widgetA.saveVerifiedSnapshot({
      command: created.command, paymentName: 'E2E-race',
      paidAt: new Date('2026-09-25T12:00:00+05:00'),
      normalizedHash: randomUUID(), rawAmount: '5000.00', rawCurrency: 'KZT',
      expectedGen: fresh,
    });
    expect(saved.applied).toBe(true);
  });

  it('product import and conversion serialize on the Deal; winner converted', async () => {
    // Convert and apply concurrently on separate connections — whichever
    // orders first wins the lock; the loser must observe the post-commit
    // state (converted request → skipped) rather than writing into a
    // half-converted request.
    const version = Number((await connA!.query(
      'SELECT version FROM orders WHERE order_id=$1', [orderId],
    )).rows[0].version);
    const conversion = repoB.convertCrmRequestToProduction({
      orderId, expectedVersion: version, orderName: tag + '-production',
      projectId: null, createProject: true,
      idempotencyKey: tag + '-convert', actorUserId: actorId,
      actorUsername: tag, actorRole: 'admin', requestId: tag,
      scope: { mode: 'all' },
      initialOrderStatusCode: 'legacy_1', initialProductionStatusCode: 'drawn',
    });
    const normalized = normalizeBitrixProductRow({
      id: '101', productId: '4242', productName: 'Race product', sort: '10',
      quantity: '1', price: '10000', discountTypeId: '1', discountRate: '10',
      discountSum: '9090.90909091', taxRate: '12', taxIncluded: 'Y',
      measureCode: '4', measureName: 'шт',
    });
    if (!('row' in normalized)) throw new Error('fixture row must normalize');
    const apply = repoA.applyDealProductSnapshot({
      dealId, rows: [normalized.row], invalid: [],
      rowsHash: productRowsHash([normalized.row]),
      opportunity: '10000.00', expectedCurrencyId: 'KZT', currencyId: 'KZT',
      auditRequestId: tag, actorUserId: actorId,
      fence: await repoA.getProductSyncFence(dealId),
      remoteUpdatedAt: '2026-09-25T10:05:00+03:00',
    });
    const [conv, applied] = await Promise.allSettled([conversion, apply]);
    // Exactly one of the two serialized outcomes: apply committed before
    // conversion (ready/unchanged + converted), or the refresh arrived after
    // conversion (skipped). Never a torn write.
    if (conv.status === 'rejected') throw conv.reason;
    if (applied.status === 'rejected') throw applied.reason;
    if (applied.status === 'fulfilled') {
      expect(['ready', 'unchanged', 'skipped']).toContain(
        (applied as PromiseFulfilledResult<{ status: string }>).value.status,
      );
    }
    const state = (await connA!.query(
      `SELECT r.state, o.order_kind FROM bitrix24_incoming_request r
        JOIN orders o ON o.order_id=r.linked_order_id WHERE r.request_id=$1`,
      [requestId],
    )).rows[0];
    expect(state).toEqual({ state: 'converted', order_kind: 'production_order' });
  });
});
