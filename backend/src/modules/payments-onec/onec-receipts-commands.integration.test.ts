import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { ROLE_POLICIES } from '../../permissions/policies/role-policies';
import { OnecDocumentConsumers } from '../onec-sync/application/onec-document-consumers';
import { PgAuditLogRepository } from '../audit/adapters/pg-audit-log-repository';
import { PgPaymentRepository } from '../payments/adapters/pg-payment-repository';
import { PgOnecReceiptsCommandRepository } from './adapters/pg-onec-receipts-command-repository';
import { PgOnecReceiptsReadRepository, type ReceiptsReadContext } from './adapters/pg-onec-receipts-read-repository';
import { configureOnecMatching } from './application/onec-match-transitions';
import { OnecReceiptsAutoMatcher } from './application/onec-receipts-auto-match.service';
import { OnecReceiptsLoaderConsumer } from './application/onec-receipts-loader-consumer';
import { OnecReceiptsService } from './application/onec-receipts.service';

// «Поступления 1С», срез B (план 2026-10-04-onec-incoming-payments): ручные команды, защита сверок у писателей
// платежей, обнаружение «изменилось» и потребитель загрузчика. Одноразовая БД film_catalog_it_* (schema-only копия
// erp_test с миграцией 240); фикстуры вставляются напрямую (session_replication_role=replica) только в этой БД.
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

describe.skipIf(!url)('1C incoming payments — slice B commands and guards, real PostgreSQL', { timeout: 180000 }, () => {
  let database: DatabaseService;
  let db: Client;
  let read: PgOnecReceiptsReadRepository;
  let service: OnecReceiptsService;
  let payments: PgPaymentRepository;
  let autoMatcher: OnecReceiptsAutoMatcher;
  let commandsRepo: PgOnecReceiptsCommandRepository;
  let commandsOn = true;
  let source = 0;
  const tag = `E2E-Тест-плB-${randomUUID().slice(0, 6)}`;
  const SERIES = `Т${randomUUID().replace(/\D/g, '').slice(0, 4).padEnd(4, '8')}`;
  let nextId = 810_000_000 + Math.floor(Math.random() * 80_000_000);
  const id = () => (nextId += 1);
  const OWNER = id();
  const STRANGER = id();
  const K = () => randomUUID();
  let orderNo = 70000 + Math.floor(Math.random() * 20000);
  const number = () => String((orderNo += 1));

  const replica = async (sql: string, params: unknown[] = []) => {
    await db.query('SET session_replication_role = replica');
    try {
      return await db.query(sql, params);
    } finally {
      await db.query('SET session_replication_role = origin');
    }
  };
  const erpOrder = async (name: string, createdBy = OWNER) => {
    const orderId = id();
    await replica(
      `INSERT INTO orders (order_id, order_name, client_id, order_status_id, payment_status_id, created_by, manager_id, project_id, order_date,
                           order_kind, delete_flag, final_amount, total_amount, legacy_duplicate_name_exempt, source_system)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, 1, 1, $3, NULL, 1, '2026-09-01', 'production_order', false, 1000, 1000, false, 'erp')`,
      [orderId, name, createdBy]);
    await replica(
      `INSERT INTO order_details (order_id, detail_number, height, width, area, milling_type_id, edge_type_id, created_by, sheet_material_type_id, delete_flag)
       VALUES ($1, 1, 1, 1, 1, 1, 1, $2, 1, false)`, [orderId, OWNER]);
    return orderId;
  };
  const erpPayment = async (orderId: number, amount: number, date: string) => {
    const paymentId = id();
    await replica(`INSERT INTO payments (payment_id, order_id, amount, payment_date, type_paid_id, created_by)
                   OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4::date, 1, $5)`, [paymentId, orderId, amount, date, OWNER]);
    return paymentId;
  };
  const onecDoc = async (kind: string, docNumber: string, date: string, ref = K()) => {
    const { rows } = await db.query(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, deleted_in_onec, currency, counterparty_name, applied_revision, amount)
       VALUES ($1, $2, $3, $4, $5::date, true, false, 'KZT', $6, 1, 0) RETURNING onec_document_id::int AS id`,
      [source, kind, ref, docNumber, date, `${tag} покупатель`]);
    return { id: rows[0].id as number, ref };
  };
  const payLine = async (docId: number, amount: number, orderRef: string) => (await db.query(
    `INSERT INTO onec_document_lines (onec_document_id, line_no, quantity, amount, line_section, onec_order_ref_key)
     VALUES ($1, 1, 0, $2, 'payment', $3) RETURNING onec_document_line_id::int AS id`, [docId, amount, orderRef])).rows[0].id as number;

  /** An ERP order with one payment and a 1C receipt line of the same amount/date, resolved by the series rule. */
  const scenario = async (options: { amount?: number; paymentAmount?: number; createdBy?: number; paymentDate?: string } = {}) => {
    const name = number();
    const orderId = await erpOrder(name, options.createdBy);
    const paymentId = await erpPayment(orderId, options.paymentAmount ?? options.amount ?? 500, options.paymentDate ?? '2026-09-05');
    const onecOrder = await onecDoc('customer_order', `${SERIES}-${name}`, '2026-09-02');
    const receipt = await onecDoc('bank_receipt', `${tag}-${name}`, '2026-09-05');
    const lineId = await payLine(receipt.id, options.amount ?? 500, onecOrder.ref);
    return { name, orderId, paymentId, onecOrder, receipt, lineId };
  };

  const user = (userId = OWNER, scope = 'all', extra: string[] = []): CurrentUser => ({
    id: String(userId), username: `${tag}-${userId}`, role: 'manager', roleId: 10,
    permissions: ['payments.onec.view', 'payments.onec.manage', 'payments.view', 'payments.update', 'payments.create', 'payments.delete',
      'orders.view_financials', ...extra] as never,
    policyScopes: { ...ROLE_POLICIES.manager, payments: { view: 'all', create: scope, update: scope, delete: scope } } as never,
  });
  const ctx: ReceiptsReadContext = { userId: String(OWNER), scope: 'all', series: null, commands: true };
  const line = async (lineId: number) => {
    const row = await read.line({ ...ctx, series: SERIES }, lineId);
    if (!row) throw new Error(`line ${lineId} not visible`);
    return row;
  };
  const card = (lineId: number) => read.getCard({ ...ctx, series: SERIES }, lineId);
  const req = (suffix: string) => ({ requestId: `${tag}-${suffix}`, correlationId: null });
  const auditEvents = async (requestId: string) => (await db.query(
    `SELECT event FROM audit_log WHERE request_id = $1 ORDER BY created_at, audit_id`, [requestId])).rows.map((r) => r.event);
  const outbox = async (pattern: string) => (await db.query(
    `SELECT event_type, idempotency_key FROM outbox_events WHERE idempotency_key LIKE $1 ORDER BY idempotency_key`, [pattern])).rows;
  const match = async (s: { lineId: number; paymentId: number }, note?: string, suffix = 'm') => {
    const c = await card(s.lineId);
    const candidate = c.candidates.find((p) => p.paymentId === s.paymentId)!;
    return service.match(user(), s.lineId, {
      paymentId: s.paymentId, expectedStateToken: c.line.stateToken, expectedPaymentToken: candidate.paymentToken, note,
    }, req(`${suffix}-${s.lineId}`));
  };

  /** Observable synchronisation: wait until `count` backends of this DB wait on a lock while running a query like `pattern`. */
  const lockWaiters = async (pattern: string, count = 1) => {
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type IN ('Lock', 'LWLock') AND query ILIKE $1`, [pattern]);
      if (rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`no lock waiter for ${pattern}`);
  };
  const ORDER_LOCK = '%final_amount%FOR UPDATE%';

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    db = new Client({ connectionString: url });
    await db.connect();
    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 4, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 15000,
    } as Partial<BackendEnv>);
    database = new DatabaseService(config, { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
    read = new PgOnecReceiptsReadRepository(database);
    commandsRepo = new PgOnecReceiptsCommandRepository(database, () => SERIES);
    autoMatcher = new OnecReceiptsAutoMatcher({ database, commands: commandsRepo, settings: () => ({ enabled: true, actorUserId: OWNER }) });
    service = new OnecReceiptsService({
      read, commands: commandsRepo, autoMatcher,
      settings: () => ({ viewEnabled: true, commandsEnabled: commandsOn, series: SERIES }), auditClient: database,
    });
    payments = new PgPaymentRepository(database);
    source = Number((await db.query('INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id',
      [`it-${randomUUID().slice(0, 8)}`, `${tag} база`])).rows[0].source_id);
    for (const [userId, name] of [[OWNER, 'owner'], [STRANGER, 'stranger']] as const) {
      await replica(`INSERT INTO users (user_id, username, password_hash, email, role_id) OVERRIDING SYSTEM VALUE VALUES ($1, $2, 'x', $3, 1)`,
        [userId, `${tag}-${name}`, `${name}-${userId}@example.test`]);
    }
  });

  beforeEach(() => {
    commandsOn = true;
    configureOnecMatching({ series: SERIES, commandsEnabled: true });
  });

  afterAll(async () => {
    configureOnecMatching(null);
    await database?.onModuleDestroy();
    await db?.end();
  });

  it('match: manual match with audit and outbox; a repeat is no change; a stale token is refused', async () => {
    const s = await scenario();
    expect((await line(s.lineId)).state).toBe('review');
    const stale = (await card(s.lineId)).line.stateToken;
    const result = await match(s);
    expect(result).toMatchObject({ changed: true, line: { state: 'matched', match: { kind: 'matched', origin: 'manual' } } });
    expect(await auditEvents(`${tag}-m-${s.lineId}`)).toEqual(['payment.onec_matched']);
    expect(await outbox(`payment.onec_matched:${result.matchId}`)).toEqual([{ event_type: 'payment.onec_matched', idempotency_key: `payment.onec_matched:${result.matchId}` }]);
    // The same payment again → the existing match, nothing written.
    const repeat = await service.match(user(), s.lineId, {
      paymentId: s.paymentId, expectedStateToken: stale, expectedPaymentToken: 'any',
    }, req(`repeat-${s.lineId}`));
    expect(repeat).toMatchObject({ changed: false, matchId: result.matchId });
    expect(await auditEvents(`${tag}-repeat-${s.lineId}`)).toEqual([]);
    // A stale token on another line → 409, nothing written.
    const other = await scenario();
    const token = (await card(other.lineId)).line.stateToken;
    await db.query('UPDATE onec_documents SET applied_revision = applied_revision + 1 WHERE onec_document_id = $1', [other.receipt.id]);
    await expect(service.match(user(), other.lineId, {
      paymentId: other.paymentId, expectedStateToken: token,
      expectedPaymentToken: (await card(other.lineId)).candidates[0].paymentToken,
    }, req('stale'))).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_RECEIPT_STATE_CHANGED' });
    expect((await line(other.lineId)).state).toBe('review');
  });

  it('match: amount differs → comment required; payment of another order or already matched → 409', async () => {
    const s = await scenario({ amount: 500, paymentAmount: 450 });
    await expect(match(s)).rejects.toMatchObject({ statusCode: 422, code: 'ONEC_MATCH_NOTE_REQUIRED' });
    expect((await match(s, 'частичная оплата, остаток наличными')).line).toMatchObject({ state: 'matched' });

    const a = await scenario();
    const b = await scenario();
    const c = await card(a.lineId);
    const foreignPaymentToken = (await card(b.lineId)).candidates[0].paymentToken;
    await expect(service.match(user(), a.lineId, {
      paymentId: b.paymentId, expectedStateToken: c.line.stateToken, expectedPaymentToken: foreignPaymentToken,
    }, req('foreign'))).rejects.toMatchObject({ statusCode: 409, code: 'ONEC_PAYMENT_NOT_OF_ORDER' });

    // Second receipt line of the same order and the payment already taken.
    await match(a);
    const second = await payLine((await onecDoc('cash_receipt', `${tag}-${a.name}-2`, '2026-09-05')).id, 500, a.onecOrder.ref);
    const c2 = await card(second);
    expect(c2.candidates[0].matchedTo).toMatchObject({ lineId: a.lineId });
    await expect(service.match(user(), second, {
      paymentId: a.paymentId, expectedStateToken: c2.line.stateToken, expectedPaymentToken: c2.candidates[0].paymentToken,
    }, req('taken'))).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_ALREADY_MATCHED' });
  });

  it('unmatch and dismiss: records stay as history; repeats are no change', async () => {
    const s = await scenario();
    const matched = await match(s);
    const removed = await service.unmatch(user(), s.lineId, { expectedMatchId: matched.matchId!, reason: 'ошибка' }, req('u'));
    expect(removed).toMatchObject({ changed: true, line: { state: 'review', match: null } });
    expect(await auditEvents(`${tag}-u`)).toEqual(['payment.onec_unmatched']);
    expect(await service.unmatch(user(), s.lineId, { expectedMatchId: matched.matchId! }, req('u2'))).toMatchObject({ changed: false });

    await expect(service.dismiss(user(), s.lineId, { expectedStateToken: (await line(s.lineId)).stateToken, note: '  ' }, req('d0')))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_DISMISS_NOTE_REQUIRED' });
    const dismissed = await service.dismiss(user(), s.lineId, { expectedStateToken: (await line(s.lineId)).stateToken, note: 'дубль в 1С' }, req('d'));
    expect(dismissed).toMatchObject({ changed: true, line: { state: 'dismissed' } });
    expect(await auditEvents(`${tag}-d`)).toEqual(['payment.onec_dismissed']);
    const back = await service.unmatch(user(), s.lineId, { expectedMatchId: dismissed.matchId! }, req('d2'));
    expect(back.line).toMatchObject({ state: 'review' });
    expect(await auditEvents(`${tag}-d2`)).toEqual(['payment.onec_dismiss_removed']);
    const history = (await card(s.lineId)).history.map((h) => [h.kind, h.removedReason]);
    expect(history).toEqual([['dismissed', 'manual'], ['matched', 'manual']]);
  });

  it('scope: a user without access to the order gets 403 and a denial audit; nothing is written', async () => {
    const s = await scenario({ createdBy: OWNER });
    const c = await card(s.lineId);
    await expect(service.match(user(STRANGER, 'own'), s.lineId, {
      paymentId: s.paymentId, expectedStateToken: c.line.stateToken, expectedPaymentToken: c.candidates[0].paymentToken,
    }, req('scope'))).rejects.toMatchObject({ statusCode: 403 });
    const denied = (await db.query(`SELECT event, status_code FROM audit_log WHERE request_id = $1`, [`${tag}-scope`])).rows;
    expect(denied).toEqual([{ event: 'payments.onec_denied', status_code: 'scope' }]);
    expect((await line(s.lineId)).state).toBe('review');
    // Commands flag off → 503 before anything.
    commandsOn = false;
    await expect(service.dismiss(user(), s.lineId, { expectedStateToken: c.line.stateToken, note: 'x' }, req('off')))
      .rejects.toMatchObject({ statusCode: 503, code: 'ONEC_PAYMENT_MATCHING_COMMANDS_DISABLED' });
  });

  it('link: a manual link re-resolves the ERP order, the order is taken once; unlink returns to the rule', async () => {
    const s = await scenario();
    const target = await erpOrder(`${tag}-ручной`);
    const linked = await service.link(user(), s.lineId, { expectedStateToken: (await line(s.lineId)).stateToken, orderId: target, note: 'по звонку' }, req('l'));
    expect(linked.line).toMatchObject({ state: 'to_create', erpOrder: { orderId: target, linkOrigin: 'manual' } });
    expect(await auditEvents(`${tag}-l`)).toEqual(['order.onec_order_linked']);
    // The same ERP order for another 1C order → 409.
    const other = await scenario();
    await expect(service.link(user(), other.lineId, { expectedStateToken: (await line(other.lineId)).stateToken, orderId: target }, req('l2')))
      .rejects.toMatchObject({ statusCode: 409, code: 'ONEC_LINK_ORDER_TAKEN' });
    const unlinked = await service.unlink(user(), s.lineId, { expectedStateToken: (await line(s.lineId)).stateToken }, req('l3'));
    expect(unlinked.line).toMatchObject({ state: 'review', erpOrder: { orderId: s.orderId, linkOrigin: 'rule' } });
    expect(await auditEvents(`${tag}-l3`)).toEqual(['order.onec_order_unlinked']);
  });

  it('a link that moves a matched 1C order to another ERP order makes the match `changed` with a review event', async () => {
    const s = await scenario();
    const matched = await match(s);
    const target = await erpOrder(`${tag}-перенос`);
    const result = await service.link(user(), s.lineId, { expectedStateToken: (await line(s.lineId)).stateToken, orderId: target }, req('lm'));
    expect(result.line).toMatchObject({ state: 'changed', changes: ['erp_order'] });
    expect(await outbox(`payment_onec_review:${matched.matchId}:%`)).toEqual([
      { event_type: 'payment.onec_review_required', idempotency_key: `payment_onec_review:${matched.matchId}:1` },
    ]);
  });

  it('payment writer: an update of a matched payment → `changed` + one event per new drift; back to normal clears it', async () => {
    const s = await scenario();
    const matched = await match(s);
    const update = (amount: number, suffix: string) => payments.updatePayment({ currentUser: user(), paymentId: s.paymentId, dto: { amount }, requestId: `${tag}-${suffix}` });
    await update(400, 'p1');
    expect((await line(s.lineId))).toMatchObject({ state: 'changed', changes: ['payment_amount'] });
    const events = () => outbox(`payment_onec_review:${matched.matchId}:%`);
    expect(await events()).toHaveLength(1);
    await update(400, 'p2'); // same drift again — no new event
    expect(await events()).toHaveLength(1);
    await update(500, 'p3'); // back to the matched values
    expect((await line(s.lineId)).state).toBe('matched');
    expect((await db.query('SELECT changed_fingerprint, review_seq FROM payment_onec_matches WHERE match_id = $1', [matched.matchId])).rows[0])
      .toEqual({ changed_fingerprint: null, review_seq: 1 });
    await update(450, 'p4'); // a new drift → a new event
    expect((await events()).map((e) => e.idempotency_key)).toEqual([`payment_onec_review:${matched.matchId}:1`, `payment_onec_review:${matched.matchId}:2`]);
  });

  it('payment delete: commands on → 409 PAYMENT_HAS_ONEC_MATCH; commands off → the match is removed with the delete', async () => {
    const s = await scenario();
    const matched = await match(s);
    await expect(payments.deletePayment({ currentUser: user(), paymentId: s.paymentId, requestId: `${tag}-del1` }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_HAS_ONEC_MATCH' });
    expect((await db.query('SELECT count(*)::int AS n FROM payments WHERE payment_id = $1', [s.paymentId])).rows[0].n).toBe(1);

    configureOnecMatching({ series: SERIES, commandsEnabled: false });
    await payments.deletePayment({ currentUser: user(), paymentId: s.paymentId, requestId: `${tag}-del2` });
    expect((await db.query('SELECT payment_id, removed_reason FROM payment_onec_matches WHERE match_id = $1', [matched.matchId])).rows[0])
      .toEqual({ payment_id: null, removed_reason: 'payment_deleted_feature_off' });
    expect(await auditEvents(`${tag}-del2`)).toEqual(expect.arrayContaining(['payment.onec_unmatched', 'payments.delete']));
    expect(await outbox(`payment.onec_unmatched:${matched.matchId}:removed`)).toHaveLength(1);
  });

  it('loader consumer: lines with any match record are referenced; a 1C order renumbered → `changed` + event', async () => {
    const registry = new OnecDocumentConsumers();
    const consumer = new OnecReceiptsLoaderConsumer(registry);
    consumer.onModuleInit();
    const s = await scenario();
    const matched = await match(s);
    const plain = await payLine((await onecDoc('cash_receipt', `${tag}-plain`, '2026-09-05')).id, 10, K());
    const [byRegistry] = registry.forKind('bank_receipt');
    expect(byRegistry.name).toBe('payments-onec');
    expect(registry.forKind('customer_order').map((c) => c.name)).toEqual(['payments-onec']);
    const client = await database.transaction(async (tx) => byRegistry.referencedLineIds(tx, [s.lineId, plain]));
    expect([...client]).toEqual([s.lineId]);
    // The 1C order got another number (another ERP order by the rule, here none) → the match drifts.
    await db.query('UPDATE onec_documents SET number = $2 WHERE onec_document_id = $1', [s.onecOrder.id, `${SERIES}-0`]);
    await database.transaction(async (tx) => registry.forKind('customer_order')[0].afterDocumentLoaded(tx, {
      documentId: s.onecOrder.id, sourceId: source, requestId: `${tag}-load-renumber`, correlationId: `${tag}-corr-renumber`,
      docKind: 'customer_order', onecRefKey: s.onecOrder.ref, docDate: '2026-09-02',
      posted: true, deletedInOnec: false, supplierId: null, counterpartyRefKey: null, counterpartyName: null, amount: null,
      currency: 'KZT', previous: null,
    }, { appliedLines: [], conflictedLines: [], removedLines: [] }));
    expect((await line(s.lineId))).toMatchObject({ state: 'changed' });
    expect(await outbox(`payment_onec_review:${matched.matchId}:%`)).toHaveLength(1);
    // The review event carries the load's own request/correlation (code review R3-3).
    const review = (await db.query(`SELECT payload_json->>'requestId' AS r, payload_json->>'correlationId' AS c FROM outbox_events
                                       WHERE idempotency_key LIKE $1`, [`payment_onec_review:${matched.matchId}:%`])).rows[0];
    expect(review).toEqual({ r: `${tag}-load-renumber`, c: `${tag}-corr-renumber` });
    consumer.onModuleDestroy();
  });
  it('auto-match: exact pairs (same order and amount, dates ≤ 3 days, unique on both sides) are matched; payments untouched', async () => {
    const exact = await scenario();
    const near = await scenario({ paymentDate: '2026-09-08' });
    const far = await scenario({ paymentDate: '2026-09-09' }); // 4 days — manual
    const differs = await scenario({ paymentAmount: 499 });
    // Two identical free payments for one line → ambiguous, manual.
    const twoPayments = await scenario();
    await erpPayment(twoPayments.orderId, 500, '2026-09-05');
    // Two identical lines for one payment → ambiguous, manual.
    const twoLines = await scenario();
    await payLine((await onecDoc('cash_receipt', `${tag}-${twoLines.name}-dup`, '2026-09-05')).id, 500, twoLines.onecOrder.ref);
    const before = await db.query(`SELECT payment_id, version FROM payments WHERE order_id = ANY($1::bigint[]) ORDER BY payment_id`,
      [[exact.orderId, near.orderId]]);
    const orderVersions = async () => (await db.query(`SELECT order_id, version FROM orders WHERE order_id = ANY($1::bigint[]) ORDER BY order_id`, [[exact.orderId, near.orderId]])).rows;
    const versionsBefore = await orderVersions();

    const result = await autoMatcher.run({ actorUserId: String(OWNER), trigger: 'test' });
    expect(result.skipped).toBe(false);
    expect((await line(exact.lineId))).toMatchObject({ state: 'matched', match: { origin: 'auto' } });
    expect((await line(near.lineId))).toMatchObject({ state: 'matched', match: { origin: 'auto' } });
    for (const manual of [far, differs, twoPayments, twoLines]) expect((await line(manual.lineId)).state).toBe('review');
    // Only match records: payments and orders unchanged.
    expect((await db.query(`SELECT payment_id, version FROM payments WHERE order_id = ANY($1::bigint[]) ORDER BY payment_id`, [[exact.orderId, near.orderId]])).rows).toEqual(before.rows);
    expect(await orderVersions()).toEqual(versionsBefore);
    const audit = (await db.query(`SELECT event, metadata_json->>'auto' AS auto FROM audit_log WHERE request_id = $1 ORDER BY created_at`, [`onec-auto-match-${result.passId}`])).rows;
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.every((row) => row.event === 'payment.onec_matched' && row.auto === 'true')).toBe(true);
    // A second pass finds nothing new for these lines.
    const again = await autoMatcher.run({ actorUserId: String(OWNER), trigger: 'test' });
    expect((await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE request_id = $1`, [`onec-auto-match-${again.passId}`])).rows[0].n).toBe(0);
  });

  it('auto-match by the button: only orders in the initiator\'s payments.update scope; the initiator is the author', async () => {
    const mine = await scenario({ createdBy: STRANGER });
    const theirs = await scenario({ createdBy: OWNER });
    const result = await service.autoMatchNow(user(STRANGER, 'own'), req('button'));
    expect(result.skipped).toBe(false);
    expect((await line(mine.lineId))).toMatchObject({ state: 'matched', match: { origin: 'auto' } });
    expect((await line(theirs.lineId)).state).toBe('review');
    const author = (await db.query(`SELECT created_by::int AS by FROM payment_onec_matches WHERE onec_document_line_id = $1 AND removed_at IS NULL`, [mine.lineId])).rows[0].by;
    expect(author).toBe(STRANGER);
  });
  it('payment update: a payment moved between the pre-read and the lock is refused (no reversed lock order)', async () => {
    const s = await scenario();
    const target = await erpOrder(number());
    const blocker = new Client({ connectionString: url });
    const mover = new Client({ connectionString: url });
    await blocker.connect();
    await mover.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM orders WHERE order_id = $1 FOR UPDATE', [s.orderId]);
      const update = payments.updatePayment({ currentUser: user(), paymentId: s.paymentId, dto: { amount: 510 }, requestId: `${tag}-moved` });
      update.catch(() => undefined);
      await lockWaiters(ORDER_LOCK); // the update has read the payment's order and waits for the order lock
      await mover.query('SET session_replication_role = replica');
      await mover.query('UPDATE payments SET order_id = $2 WHERE payment_id = $1', [s.paymentId, target]);
      await blocker.query('COMMIT');
      await expect(update).rejects.toMatchObject({ statusCode: 409, code: 'PAYMENT_CONCURRENTLY_MOVED' });
      expect((await db.query('SELECT amount::int AS a FROM payments WHERE payment_id = $1', [s.paymentId])).rows[0].a).toBe(500);
    } finally {
      await blocker.query('ROLLBACK').catch(() => undefined);
      await blocker.end();
      await mover.end();
    }
  });

  it('auto-match waits for a loader transaction adding a competing line of the order and then refuses the pair', async () => {
    const s = await scenario();
    const consumer = new OnecReceiptsLoaderConsumer(new OnecDocumentConsumers());
    const loader = new Client({ connectionString: url });
    await loader.connect();
    try {
      await loader.query('BEGIN');
      const doc = (await loader.query(
        `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, deleted_in_onec, currency, counterparty_name, applied_revision, amount)
         VALUES ($1, 'cash_receipt', $2, $3, '2026-09-05', true, false, 'KZT', $4, 1, 0) RETURNING onec_document_id::int AS id`,
        [source, K(), `${tag}-${s.name}-competing`, `${tag} покупатель`])).rows[0].id as number;
      await loader.query(`INSERT INTO onec_document_lines (onec_document_id, line_no, quantity, amount, line_section, onec_order_ref_key)
                          VALUES ($1, 1, 0, 500, 'payment', $2)`, [doc, s.onecOrder.ref]);
      // The consumer's last step in the loader transaction: the shared candidate lock of the order.
      await consumer.afterDocumentLoaded({ query: (text: string, params?: unknown[]) => loader.query(text, params) } as never, {
        documentId: doc, sourceId: source, requestId: `${tag}-load-race`, correlationId: null, docKind: 'cash_receipt', onecRefKey: K(),
        docDate: '2026-09-05', posted: true, deletedInOnec: false,
        supplierId: null, counterpartyRefKey: null, counterpartyName: null, amount: null, currency: 'KZT', previous: null,
      }, { appliedLines: [], conflictedLines: [], removedLines: [] });
      const pair = commandsRepo.autoMatchPair(s.lineId, s.paymentId, { userId: String(OWNER), username: null, role: null, passId: 'race', requestId: `${tag}-race`, correlationId: null });
      pair.catch(() => undefined);
      await lockWaiters('%pg_advisory_xact_lock(hashtext%'); // the pair waits for the candidate lock
      await loader.query('COMMIT');
      expect(await pair).toBe(false); // two lines fit the payment now — manual review
      expect((await line(s.lineId)).state).toBe('review');
    } finally {
      await loader.query('ROLLBACK').catch(() => undefined);
      await loader.end();
    }
  });

  it('audit: 1C matching events carry the client and are hidden without the financial rights', async () => {
    const s = await scenario();
    const matched = await match(s);
    const row = (await db.query(`SELECT related_order_id::int AS o, related_client_id::int AS c, related_payment_id::int AS p
                                   FROM audit_log WHERE request_id = $1 AND event = 'payment.onec_matched'`, [`${tag}-m-${s.lineId}`])).rows[0];
    expect(row).toEqual({ o: s.orderId, c: 1, p: s.paymentId });
    const audit = new PgAuditLogRepository(database);
    const admin = { ...user(), role: 'admin' } as CurrentUser;
    const list = (hideFinancial: boolean) => audit.list({ currentUser: admin, filters: { requestId: `${tag}-m-${s.lineId}`, hideFinancial } as never, page: 1, pageSize: 20, requestId: `${tag}-audit` });
    expect((await list(false)).data.map((r) => r.event)).toEqual(['payment.onec_matched']);
    expect((await list(true)).data).toEqual([]);
    expect(matched.changed).toBe(true);
  });
  const actor = (suffix: string) => ({ userId: String(OWNER), username: null, role: null, passId: suffix, requestId: `${tag}-${suffix}`, correlationId: null });
  const holdOrder = async (orderId: number) => {
    const blocker = new Client({ connectionString: url });
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM orders WHERE order_id = $1 FOR UPDATE', [orderId]);
    return { release: async () => { await blocker.query('COMMIT'); await blocker.end(); } };
  };

  it('payment delete × auto-match of the same payment: one of the two consistent outcomes, never a match on a deleted payment', async () => {
    const s = await scenario();
    const hold = await holdOrder(s.orderId);
    const deleting = payments.deletePayment({ currentUser: user(), paymentId: s.paymentId, requestId: `${tag}-del-race` });
    deleting.catch(() => undefined);
    await lockWaiters(ORDER_LOCK, 1);
    const pair = commandsRepo.autoMatchPair(s.lineId, s.paymentId, actor('del-race'));
    pair.catch(() => undefined);
    await lockWaiters('%FROM orders%order_id = ANY%FOR UPDATE%', 2); // both wait for the order
    await hold.release();
    const [deleted, matched] = await Promise.allSettled([deleting, pair]);
    const payment = (await db.query('SELECT count(*)::int AS n FROM payments WHERE payment_id = $1', [s.paymentId])).rows[0].n;
    const active = (await db.query('SELECT count(*)::int AS n FROM payment_onec_matches WHERE onec_document_line_id = $1 AND removed_at IS NULL', [s.lineId])).rows[0].n;
    if (deleted.status === 'fulfilled') {
      // The delete went first: the pair found no payment.
      expect([payment, active, matched]).toEqual([0, 0, { status: 'fulfilled', value: false }]);
    } else {
      // The match went first: the delete is refused while commands are on.
      expect(deleted.reason).toMatchObject({ statusCode: 409, code: 'PAYMENT_HAS_ONEC_MATCH' });
      expect([payment, active, matched]).toEqual([1, 1, { status: 'fulfilled', value: true }]);
    }
  });

  it('unlink × auto-match: a receipt that joins the order through an unlink first makes the pair ambiguous', async () => {
    const s = await scenario();
    // A second 1C order with the same number, marked «not an ERP order» — its receipt is out of the candidates.
    const twin = await onecDoc('customer_order', `${SERIES}-${s.name}`, '2026-09-02');
    const twinLine = await payLine((await onecDoc('bank_receipt', `${tag}-${s.name}-twin`, '2026-09-05')).id, 500, twin.ref);
    await service.link(user(), twinLine, { expectedStateToken: (await line(twinLine)).stateToken, orderId: null }, req('twin-not-erp'));
    expect((await line(twinLine)).state).toBe('no_erp_order');
    const token = (await line(twinLine)).stateToken;
    const hold = await holdOrder(s.orderId);
    const unlink = service.unlink(user(), twinLine, { expectedStateToken: token }, req('twin-unlink'));
    unlink.catch(() => undefined);
    await lockWaiters(ORDER_LOCK.replace('final_amount', 'created_by, manager_id, client_id'), 1);
    const pair = commandsRepo.autoMatchPair(s.lineId, s.paymentId, actor('unlink-race'));
    pair.catch(() => undefined);
    await lockWaiters('%FOR UPDATE%', 2);
    await hold.release();
    expect((await unlink).line).toMatchObject({ state: 'review', erpOrder: { orderId: s.orderId, linkOrigin: 'rule' } });
    expect(await pair).toBe(false);
    expect((await line(s.lineId)).state).toBe('review');
    // Unlink audit and event name the order the receipt joined, with its client (code review R2-3).
    const audit = (await db.query(`SELECT related_order_id::int AS o, related_client_id::int AS c, after_json->>'orderId' AS after
                                     FROM audit_log WHERE request_id = $1 AND event = 'order.onec_order_unlinked'`, [`${tag}-twin-unlink`])).rows[0];
    expect(audit).toEqual({ o: s.orderId, c: 1, after: String(s.orderId) });
    const event = (await db.query(`SELECT payload_json->>'orderIdAfter' AS after FROM outbox_events WHERE event_type = 'order.onec_order_unlinked'
                                     AND payload_json->>'onecOrderRefKey' = $1`, [twin.ref])).rows[0];
    expect(event).toEqual({ after: String(s.orderId) });
  });
  /** A loader transaction on its own connection; `view` → the consumer's `afterDocumentLoaded` inside it. */
  const loaderTx = async () => {
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    const tx = { query: (text: string, params?: unknown[]) => client.query(text, params) } as never;
    const consumer = new OnecReceiptsLoaderConsumer(new OnecDocumentConsumers());
    return {
      client,
      receipt: async (docNumber: string, amount: number, orderRef: string) => {
        const doc = (await client.query(
          `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, deleted_in_onec, currency, counterparty_name, applied_revision, amount)
           VALUES ($1, 'cash_receipt', $2, $3, '2026-09-05', true, false, 'KZT', $4, 1, 0) RETURNING onec_document_id::int AS id`,
          [source, K(), docNumber, `${tag} покупатель`])).rows[0].id as number;
        await client.query(`INSERT INTO onec_document_lines (onec_document_id, line_no, quantity, amount, line_section, onec_order_ref_key)
                            VALUES ($1, 1, 0, $2, 'payment', $3)`, [doc, amount, orderRef]);
        return doc;
      },
      loaded: (documentId: number, docKind = 'cash_receipt', onecRefKey = K()) => consumer.afterDocumentLoaded(tx, {
        documentId, sourceId: source, requestId: `${tag}-load-${documentId}`, correlationId: null, docKind: docKind as never, onecRefKey,
        docDate: '2026-09-05', posted: true, deletedInOnec: false, supplierId: null, counterpartyRefKey: null, counterpartyName: null,
        amount: null, currency: 'KZT', previous: null,
      }, { appliedLines: [], conflictedLines: [], removedLines: [] }),
      end: async () => {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      },
    };
  };

  it('loader × unlink × auto-match: a receipt loaded for a 1C order marked «not ERP» is counted once the unlink brings the order back', async () => {
    const s = await scenario();
    await service.link(user(), s.lineId, { expectedStateToken: (await line(s.lineId)).stateToken, orderId: null }, req('nx-not-erp'));
    expect((await line(s.lineId)).state).toBe('no_erp_order');
    const loader = await loaderTx();
    try {
      // A new receipt of the same 1C order, resolving to no ERP order now: the loader holds only the 1C order lock.
      await loader.loaded(await loader.receipt(`${tag}-${s.name}-new`, 500, s.onecOrder.ref));
      const unlink = service.unlink(user(), s.lineId, { expectedStateToken: (await line(s.lineId)).stateToken }, req('nx-unlink'));
      unlink.catch(() => undefined);
      await lockWaiters('%pg_advisory_xact_lock(hashtext%'); // the unlink waits for the loader on the 1C order
      const pair = commandsRepo.autoMatchPair(s.lineId, s.paymentId, actor('nx-pair'));
      pair.catch(() => undefined);
      await lockWaiters('%FOR UPDATE%'); // the pair waits for the order the unlink holds
      await loader.client.query('COMMIT');
      expect((await unlink).line).toMatchObject({ state: 'review', erpOrder: { orderId: s.orderId, linkOrigin: 'rule' } });
      expect(await pair).toBe(false); // two receipts of the order fit the payment — manual review
      expect((await line(s.lineId)).state).toBe('review');
    } finally {
      await loader.end();
    }
  });

  it('loader × link on sibling receipts of one 1C order: the link locks the match rows before its advisory locks — no deadlock', async () => {
    const s = await scenario();
    const matched = await match(s, undefined, 'sib');
    const sibling = await payLine((await onecDoc('cash_receipt', `${tag}-${s.name}-sib`, '2026-09-05')).id, 200, s.onecOrder.ref);
    const target = await erpOrder(number());
    const loader = await loaderTx();
    try {
      // The loader is past its detector for the matched receipt (its match row locked), not yet at its advisory locks.
      await loader.client.query('SELECT 1 FROM payment_onec_matches WHERE match_id = $1 FOR UPDATE', [matched.matchId]);
      const link = service.link(user(), sibling, { expectedStateToken: (await line(sibling)).stateToken, orderId: target }, req('sib-link'));
      link.catch(() => undefined);
      await lockWaiters('%FOR UPDATE OF m%'); // the link waits for the match row, holding no advisory lock yet
      const held = (await db.query(`SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
         WHERE l.locktype = 'advisory' AND l.granted AND a.query ILIKE '%FOR UPDATE OF m%'`)).rows[0].n;
      expect(held).toBe(0);
      // The loader's own last steps (detector, 1C order and ERP order locks) go through, then it commits.
      await loader.loaded(s.receipt.id, 'bank_receipt');
      await loader.client.query('COMMIT');
      expect((await link).changed).toBe(true);
      expect((await line(s.lineId)).state).toBe('changed'); // its 1C order moved to another ERP order
    } finally {
      await loader.end();
    }
  });
  it('receipt load × customer-order renumber × auto-match: the renumber waits for the receipt load; the pair then counts both receipts', async () => {
    const s = await scenario();
    // A second 1C order, resolving to no ERP order yet; it will be renumbered to the same ERP order.
    const other = await onecDoc('customer_order', `${SERIES}-0`, '2026-09-02');
    const receipts = await loaderTx();
    const orders = await loaderTx();
    try {
      await receipts.loaded(await receipts.receipt(`${tag}-${s.name}-r2`, 500, other.ref)); // holds the 1C order shared
      await orders.client.query('UPDATE onec_documents SET number = $2 WHERE onec_document_id = $1', [other.id, `${SERIES}-${s.name}`]);
      const renumber = orders.loaded(other.id, 'customer_order', other.ref);
      renumber.catch(() => undefined);
      await lockWaiters('%pg_advisory_xact_lock(hashtext%'); // the renumber waits for the receipt load (exclusive)
      await receipts.client.query('COMMIT');
      await renumber;
      await orders.client.query('COMMIT');
      // Both receipts belong to the order now: the payment fits two → no automatic match.
      expect(await commandsRepo.autoMatchPair(s.lineId, s.paymentId, actor('renumber-pair'))).toBe(false);
      expect((await line(s.lineId)).state).toBe('review');
    } finally {
      await receipts.end();
      await orders.end();
    }
  });
  it('scope first: an out-of-scope user learns nothing about a matched or «разобрано» line — 403 and a denial audit', async () => {
    const s = await scenario({ createdBy: OWNER });
    const matched = await match(s, undefined, 'sf');
    const c = await card(s.lineId);
    const strangerMatch = service.match(user(STRANGER, 'own'), s.lineId, {
      paymentId: s.paymentId, expectedStateToken: c.line.stateToken, expectedPaymentToken: 'x',
    }, req('sf-match'));
    await expect(strangerMatch).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    // No match id or state in the refusal (before: 200 «no change» with matchId, or ONEC_RECEIPT_ALREADY_MATCHED).
    const error = await strangerMatch.catch((e: { details?: unknown }) => e);
    expect(JSON.stringify((error as { details?: unknown }).details ?? {})).not.toContain(String(matched.matchId));
    await expect(service.unmatch(user(STRANGER, 'own'), s.lineId, { expectedMatchId: matched.matchId! }, req('sf-unmatch')))
      .rejects.toMatchObject({ statusCode: 403 });
    const d = await scenario({ createdBy: OWNER });
    await service.dismiss(user(), d.lineId, { expectedStateToken: (await line(d.lineId)).stateToken, note: 'разобрано' }, req('sf-d'));
    await expect(service.dismiss(user(STRANGER, 'own'), d.lineId, { expectedStateToken: 'x', note: 'x' }, req('sf-dismiss')))
      .rejects.toMatchObject({ statusCode: 403 });
    for (const suffix of ['sf-match', 'sf-unmatch', 'sf-dismiss']) {
      expect((await db.query(`SELECT event, status_code FROM audit_log WHERE request_id = $1`, [`${tag}-${suffix}`])).rows)
        .toEqual([{ event: 'payments.onec_denied', status_code: 'scope' }]);
    }
    expect((await line(s.lineId)).state).toBe('matched');
    expect((await line(d.lineId)).state).toBe('dismissed');
  });

  it('unlink with scope «own»: back to an own order passes; back to a foreign one is denied', async () => {
    // own → own: the rule order and the linked order both belong to the stranger.
    const s = await scenario({ createdBy: STRANGER });
    const other = await erpOrder(number(), STRANGER);
    const stranger = user(STRANGER, 'own');
    await service.link(stranger, s.lineId, { expectedStateToken: (await line(s.lineId)).stateToken, orderId: other }, req('uo-link'));
    expect((await line(s.lineId)).erpOrder).toMatchObject({ orderId: other, linkOrigin: 'manual' });
    const back = await service.unlink(stranger, s.lineId, { expectedStateToken: (await line(s.lineId)).stateToken }, req('uo-unlink'));
    expect(back.line).toMatchObject({ erpOrder: { orderId: s.orderId, linkOrigin: 'rule' } });
    // own → foreign: the rule order is the owner's; the stranger may not move the receipt there.
    const f = await scenario({ createdBy: OWNER });
    const mine = await erpOrder(number(), STRANGER);
    await service.link(user(), f.lineId, { expectedStateToken: (await line(f.lineId)).stateToken, orderId: mine }, req('uf-link'));
    await expect(service.unlink(stranger, f.lineId, { expectedStateToken: (await line(f.lineId)).stateToken }, req('uf-unlink')))
      .rejects.toMatchObject({ statusCode: 403 });
    expect((await line(f.lineId)).erpOrder).toMatchObject({ orderId: mine, linkOrigin: 'manual' });
  });
  it('unmatch on a foreign line: a right, a wrong and a missing match id all get the same 403 with a denial audit', async () => {
    const s = await scenario({ createdBy: OWNER });
    const matched = await match(s, undefined, 'um');
    const other = await scenario({ createdBy: OWNER });
    const otherMatch = await match(other, undefined, 'um2');
    const stranger = user(STRANGER, 'own');
    const cases: Array<[string, number]> = [['um-right', matched.matchId!], ['um-wrong', otherMatch.matchId!], ['um-missing', 2_000_000_000]];
    for (const [suffix, matchId] of cases) {
      await expect(service.unmatch(stranger, s.lineId, { expectedMatchId: matchId }, req(suffix)))
        .rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
      expect((await db.query(`SELECT event, status_code FROM audit_log WHERE request_id = $1`, [`${tag}-${suffix}`])).rows)
        .toEqual([{ event: 'payments.onec_denied', status_code: 'scope' }]);
    }
    expect((await line(s.lineId)).state).toBe('matched');
  });

  it('match: a payment moved to a foreign order while the command waits is authorised by its locked order → 403', async () => {
    const s = await scenario({ createdBy: STRANGER });
    const foreign = await erpOrder(number(), OWNER);
    const c = await card(s.lineId);
    const hold = await holdOrder(s.orderId);
    const pending = service.match(user(STRANGER, 'own'), s.lineId, {
      paymentId: s.paymentId, expectedStateToken: c.line.stateToken, expectedPaymentToken: c.candidates[0].paymentToken,
    }, req('mv-match'));
    pending.catch(() => undefined);
    await lockWaiters(ORDER_LOCK.replace('final_amount', 'created_by, manager_id, client_id')); // the command waits for the order
    // The payment moves to the owner's order (no triggers: the order rows are not touched by the move itself here).
    await replica('UPDATE payments SET order_id = $2 WHERE payment_id = $1', [s.paymentId, foreign]);
    await hold.release();
    await expect(pending).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect((await db.query(`SELECT event, status_code FROM audit_log WHERE request_id = $1`, [`${tag}-mv-match`])).rows)
      .toEqual([{ event: 'payments.onec_denied', status_code: 'scope' }]);
    expect((await db.query('SELECT count(*)::int AS n FROM payment_onec_matches WHERE onec_document_line_id = $1', [s.lineId])).rows[0].n).toBe(0);
  });
});
