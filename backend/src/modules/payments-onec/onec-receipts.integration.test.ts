import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseService } from '../../database/database.service';
import type { CurrentUser } from '../../permissions/current-user';
import { OnecRuntimeConfigService } from '../onec-agent/onec-runtime-config.service';
import { OnecCustomerDocumentsReadService } from '../onec-sync/application/onec-customer-documents-read.service';
import { PgOnecReceiptsReadRepository, type ReceiptsReadContext } from './adapters/pg-onec-receipts-read-repository';
import { OnecReceiptsService } from './application/onec-receipts.service';

// «Поступления 1С» (план 2026-10-04-onec-incoming-payments, срез A — чтение). Одноразовая БД film_catalog_it_*
// (schema-only erp_test + миграция 240). Документы 1С, заказы и платежи вставляются напрямую
// (session_replication_role=replica — без цепочек справочников), только в этой БД.
const url = process.env.FILM_CATALOG_TEST_DATABASE_URL;

describe.skipIf(!url)('1C incoming payments — read model, real PostgreSQL', { timeout: 120000 }, () => {
  let database: DatabaseService;
  let db: Client;
  let repo: PgOnecReceiptsReadRepository;
  let source = 0;
  let otherSource = 0;
  const tag = `E2E-Тест-пл-${randomUUID().slice(0, 6)}`;
  const SERIES = `Т${randomUUID().replace(/\D/g, '').slice(0, 4).padEnd(4, '7')}`;
  const base = 800_000_000 + Math.floor(Math.random() * 90_000_000);
  let nextId = base;
  const id = () => (nextId += 1);
  const OWNER = id();
  const MANAGER = id();
  const STRANGER = id();
  const K = () => randomUUID();

  const replica = async (sql: string, params: unknown[] = []) => {
    await db.query('SET session_replication_role = replica');
    try {
      return await db.query(sql, params);
    } finally {
      await db.query('SET session_replication_role = origin');
    }
  };
  const erpOrder = async (name: string, options: { date?: string; createdBy?: number; managerId?: number | null; kind?: string; deleted?: boolean; positions?: boolean; legacyExempt?: boolean } = {}) => {
    const orderId = id();
    await replica(
      `INSERT INTO orders (order_id, order_name, client_id, order_status_id, payment_status_id, created_by, manager_id, project_id, order_date,
                           order_kind, delete_flag, final_amount, total_amount, legacy_duplicate_name_exempt, source_system)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, 1, 1, 1, $3, $4, 1, $5::date, $6, $7, 1000, 1000, $9, $8)`,
      [orderId, name, options.createdBy ?? OWNER, options.managerId ?? null, options.date ?? '2026-09-01', options.kind ?? 'production_order', options.deleted ?? false,
        options.kind === 'crm_request' ? 'bitrix24' : 'erp', options.legacyExempt ?? false]);
    if (options.positions !== false) {
      // Любая активная позиция делает заказ готовым к платежам (то же условие, что у команды платежей).
      await replica(
        `INSERT INTO order_details (order_id, detail_number, height, width, area, milling_type_id, edge_type_id, created_by, sheet_material_type_id, delete_flag)
         VALUES ($1, 1, 1, 1, 1, 1, 1, $2, 1, false)`, [orderId, OWNER]);
    }
    return orderId;
  };
  const erpPayment = async (orderId: number, amount: number, date: string) => {
    const paymentId = id();
    await replica(`INSERT INTO payments (payment_id, order_id, amount, payment_date, type_paid_id, created_by)
                   OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4::date, 1, $5)`, [paymentId, orderId, amount, date, OWNER]);
    return paymentId;
  };
  const onecDoc = async (kind: string, number: string, date: string, options: { posted?: boolean; deleted?: boolean; missing?: boolean; currency?: string | null; sourceId?: number; ref?: string } = {}) => {
    const ref = options.ref ?? K();
    const { rows } = await db.query(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, deleted_in_onec, currency, counterparty_name,
                                   applied_revision, missing_in_source_at, amount)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, 1, CASE WHEN $10 THEN now() END, 0) RETURNING onec_document_id::int AS id`,
      [options.sourceId ?? source, kind, ref, number, date, options.posted ?? true, options.deleted ?? false,
        options.currency === undefined ? 'KZT' : options.currency, `${tag} покупатель`, options.missing ?? false]);
    return { id: rows[0].id as number, ref };
  };
  const payLine = async (docId: number, lineNo: number, amount: number, options: { orderRef?: string | null; settlementRef?: string | null; removed?: boolean } = {}) => {
    const { rows } = await db.query(
      `INSERT INTO onec_document_lines (onec_document_id, line_no, quantity, amount, line_section, onec_order_ref_key, settlement_doc_ref_key, removed_in_onec_at)
       VALUES ($1, $2, 0, $3, 'payment', $4, $5, CASE WHEN $6 THEN now() END) RETURNING onec_document_line_id::int AS id`,
      [docId, lineNo, amount, options.orderRef ?? null, options.settlementRef ?? null, options.removed ?? false]);
    return rows[0].id as number;
  };
  const onecOrder = (number: string, date = '2026-09-02', sourceId = source) => onecDoc('customer_order', number, date, { sourceId });
  const ctx = (userId: number, scope: ReceiptsReadContext['scope'], series: string | null = SERIES): ReceiptsReadContext => ({ userId: String(userId), scope, series });
  const all = ctx(OWNER, 'all');
  const find = async (context: ReceiptsReadContext, lineId: number) =>
    (await repo.list(context, { page: 1, pageSize: 100, search: tag })).data.find((row) => row.lineId === lineId);
  const state = async (lineId: number, context = all) => {
    const row = await find(context, lineId);
    return row ? [row.state, row.reason] : null;
  };
  const insertMatch = async (lineId: number, paymentId: number, orderId: number, values: { onecAmount: number; date: string; orderRef: string; paymentAmount: number; paymentDate: string }) =>
    (await replica(
      `INSERT INTO payment_onec_matches (onec_document_line_id, kind, origin, payment_id, payment_id_at_match, order_id_at_match, source_id,
                                         onec_order_ref_key, onec_amount, onec_currency, onec_doc_date, payment_amount, payment_date, created_by)
       VALUES ($1, 'matched', 'manual', $2, $2, $3, $4, $5, $6, 'KZT', $7::date, $8, $9::date, $10) RETURNING match_id::int AS id`,
      [lineId, paymentId, orderId, source, values.orderRef, values.onecAmount, values.date, values.paymentAmount, values.paymentDate, OWNER])).rows[0].id as number;

  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(url!).pathname.replace(/^\//, ''));
    if (!dbName.startsWith('film_catalog_it_')) throw new Error(`owned film_catalog_it_* database required (got ${dbName})`);
    db = new Client({ connectionString: url });
    await db.connect();
    const config = new ConfigService<BackendEnv, true>({
      DATABASE_URL: url, DATABASE_POOL_MIN: 1, DATABASE_POOL_MAX: 3, DATABASE_SSL: false, DATABASE_QUERY_TIMEOUT_MS: 15000,
    } as Partial<BackendEnv>);
    database = new DatabaseService(config, { measure: (_text: string, run: () => Promise<unknown>) => run() } as never);
    repo = new PgOnecReceiptsReadRepository(database);
    const newSource = async () => Number((await db.query('INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id',
      [`it-${randomUUID().slice(0, 8)}`, `${tag} база`])).rows[0].source_id);
    source = await newSource();
    otherSource = await newSource();
    for (const [userId, name] of [[OWNER, 'owner'], [MANAGER, 'manager'], [STRANGER, 'stranger']] as const) {
      await replica(`INSERT INTO users (user_id, username, password_hash, email, role_id) OVERRIDING SYSTEM VALUE VALUES ($1, $2, 'x', $3, 1)`,
        [userId, `${tag}-${name}`, `${name}-${userId}@example.test`]);
    }
  });

  afterAll(async () => {
    await database?.onModuleDestroy();
    await db?.end();
  });

  it('migration 240 is in place: tables, the active-match guard and the permissions', async () => {
    const tables = (await db.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'
        AND table_name IN ('order_onec_order_links', 'payment_onec_matches', 'payment_onec_commands', 'onec_account_payment_types')`)).rows[0].n;
    expect(tables).toBe(4);
    expect((await db.query(`SELECT count(*)::int AS n FROM permissions_catalog WHERE permission_name IN ('payments.onec.view', 'payments.onec.manage')`)).rows[0].n).toBe(2);
    // Физическое удаление платежа с активной сверкой отклоняет сама БД; со снятой — проходит, история остаётся.
    const orderId = await erpOrder(`${tag}-guard`);
    const paymentId = await erpPayment(orderId, 100, '2026-09-03');
    const receipt = await onecDoc('cash_receipt', `${tag}-guard`, '2026-09-03');
    const lineId = await payLine(receipt.id, 1, 100, { orderRef: K() });
    const matchId = await insertMatch(lineId, paymentId, orderId, { onecAmount: 100, date: '2026-09-03', orderRef: K(), paymentAmount: 100, paymentDate: '2026-09-03' });
    await expect(db.query('DELETE FROM payments WHERE payment_id = $1', [paymentId])).rejects.toMatchObject({ constraint: 'chk_pom_active_payment' });
    await db.query(`UPDATE payment_onec_matches SET removed_at = now(), removed_by = $2 WHERE match_id = $1`, [matchId, OWNER]);
    await db.query('DELETE FROM payments WHERE payment_id = $1', [paymentId]);
    expect((await db.query('SELECT payment_id, payment_id_at_match::int AS at FROM payment_onec_matches WHERE match_id = $1', [matchId])).rows[0])
      .toEqual({ payment_id: null, at: paymentId });
  });

  it('order link rule: series + number, exactly one live production order in the date window; otherwise «заказ ERP не определён»', async () => {
    const good = await erpOrder('9101');
    const oGood = await onecOrder(`${SERIES}-9101`);
    const lGood = await payLine((await onecDoc('bank_receipt', `${tag}-good`, '2026-09-05')).id, 1, 500, { orderRef: oGood.ref });
    expect(await state(lGood)).toEqual(['to_create', null]);
    expect((await find(all, lGood))!.erpOrder).toMatchObject({ orderId: good, orderName: '9101', linkOrigin: 'rule', paymentsCount: 0 });

    // Другая серия, заказ 1С не загружен, строка без заказа.
    const oOther = await onecOrder(`ДР-9101`);
    const receipt = await onecDoc('bank_receipt', `${tag}-misc`, '2026-09-05');
    expect(await state(await payLine(receipt.id, 1, 10, { orderRef: oOther.ref }))).toEqual(['no_erp_order', 'erp_order_not_found']);
    expect(await state(await payLine(receipt.id, 2, 10, { orderRef: K() }))).toEqual(['no_erp_order', 'onec_order_not_loaded']);
    expect(await state(await payLine(receipt.id, 3, 10))).toEqual(['no_erp_order', 'no_onec_order']);

    // Вне окна дат; удалённый заказ; заказы-исключения.
    await erpOrder('9102', { date: '2026-01-01' });
    expect(await state(await payLine(receipt.id, 4, 10, { orderRef: (await onecOrder(`${SERIES}-9102`)).ref }))).toEqual(['no_erp_order', 'erp_order_not_found']);
    await erpOrder('9103', { deleted: true });
    expect(await state(await payLine(receipt.id, 5, 10, { orderRef: (await onecOrder(`${SERIES}-9103`)).ref }))).toEqual(['no_erp_order', 'erp_order_not_found']);
    // Заказ-исключение из уникальности номеров (старые дубли) правилом не подбирается: однозначность даёт только
    // уникальный индекс действующих производственных заказов.
    await erpOrder('9105', { legacyExempt: true });
    await erpOrder('9105', { legacyExempt: true });
    expect(await state(await payLine(receipt.id, 7, 10, { orderRef: (await onecOrder(`${SERIES}-9105`)).ref }))).toEqual(['no_erp_order', 'erp_order_not_found']);
    // Номер сравнивается так же, как в индексе уникальности (нормализованно).
    const spaced = await erpOrder(' 9107 ');
    expect((await find(all, await payLine(receipt.id, 10, 10, { orderRef: (await onecOrder(`${SERIES}-9107`)).ref })))?.erpOrder?.orderId)
      .toBe((await db.query(`SELECT normalize_order_name(' 9107 ') = normalize_order_name('9107') AS same`)).rows[0].same ? spaced : undefined);
    // Заказ без активных позиций не готов к платежам.
    await erpOrder('9106', { positions: false });
    expect(await state(await payLine(receipt.id, 8, 10, { orderRef: (await onecOrder(`${SERIES}-9106`)).ref }))).toEqual(['no_erp_order', 'erp_order_not_ready']);
    // Правило выключено (серия не задана): заказ не определяется.
    expect(await state(lGood, ctx(OWNER, 'all', null))).toEqual(['no_erp_order', 'erp_order_not_found']);
    // Серия — буквальный префикс: похожая более длинная серия не подходит.
    expect(await state(await payLine(receipt.id, 9, 10, { orderRef: (await onecOrder(`X${SERIES}-9101`)).ref }))).toEqual(['no_erp_order', 'erp_order_not_found']);
  });

  it('a manual link wins over the rule; a link with no order forbids the rule', async () => {
    const byRule = await erpOrder('9201');
    const manual = await erpOrder(`${tag}-ручной`);
    const o = await onecOrder(`${SERIES}-9201`);
    const lineId = await payLine((await onecDoc('cash_receipt', `${tag}-link`, '2026-09-05')).id, 1, 300, { orderRef: o.ref });
    expect((await find(all, lineId))!.erpOrder).toMatchObject({ orderId: byRule, linkOrigin: 'rule' });
    const token = (await find(all, lineId))!.stateToken;
    const link = (await replica(`INSERT INTO order_onec_order_links (source_id, onec_order_ref_key, order_id, created_by) VALUES ($1, $2, $3, $4) RETURNING link_id::int AS id`,
      [source, o.ref, manual, OWNER])).rows[0].id;
    const linked = (await find(all, lineId))!;
    expect(linked.erpOrder).toMatchObject({ orderId: manual, linkOrigin: 'manual' });
    expect(linked.stateToken).not.toBe(token); // связь заказа входит в токен состояния
    await db.query('UPDATE order_onec_order_links SET order_id = NULL WHERE link_id = $1', [link]);
    expect(await state(lineId)).toEqual(['no_erp_order', 'not_erp_order_manual']);
    await db.query('UPDATE order_onec_order_links SET removed_at = now(), removed_by = $2 WHERE link_id = $1', [link, OWNER]);
    expect((await find(all, lineId))!.erpOrder).toMatchObject({ orderId: byRule, linkOrigin: 'rule' });
  });

  it('states of an unmatched receipt line: review, to_create, inactive, foreign currency', async () => {
    const orderId = await erpOrder('9301');
    const o = await onecOrder(`${SERIES}-9301`);
    const live = await payLine((await onecDoc('bank_receipt', `${tag}-s1`, '2026-09-05')).id, 1, 400, { orderRef: o.ref });
    expect(await state(live)).toEqual(['to_create', null]);
    await erpPayment(orderId, 400, '2026-09-05');
    expect(await state(live)).toEqual(['review', null]);
    expect((await find(all, live))!.erpOrder).toMatchObject({ paymentsCount: 1 });
    expect(await state(await payLine((await onecDoc('bank_receipt', `${tag}-s2`, '2026-09-05', { posted: false })).id, 1, 400, { orderRef: o.ref }))).toEqual(['inactive', 'not_posted']);
    expect(await state(await payLine((await onecDoc('bank_receipt', `${tag}-s3`, '2026-09-05', { deleted: true })).id, 1, 400, { orderRef: o.ref }))).toEqual(['inactive', 'deleted_in_onec']);
    expect(await state(await payLine((await onecDoc('bank_receipt', `${tag}-s4`, '2026-09-05', { missing: true })).id, 1, 400, { orderRef: o.ref }))).toEqual(['inactive', 'missing_in_source']);
    expect(await state(await payLine((await onecDoc('bank_receipt', `${tag}-s5`, '2026-09-05')).id, 1, 400, { orderRef: o.ref, removed: true }))).toEqual(['inactive', 'line_removed']);
    expect(await state(await payLine((await onecDoc('bank_receipt', `${tag}-s6`, '2026-09-05', { currency: 'USD' })).id, 1, 400, { orderRef: o.ref }))).toEqual(['foreign_currency', 'foreign_currency']);
  });

  it('matched vs changed: any difference from what the match stored sends the line to manual review', async () => {
    const orderId = await erpOrder('9401');
    const other = await erpOrder(`${tag}-другой`);
    const o = await onecOrder(`${SERIES}-9401`);
    const receipt = await onecDoc('bank_receipt', `${tag}-m`, '2026-09-05');
    const lineId = await payLine(receipt.id, 1, 700, { orderRef: o.ref });
    const paymentId = await erpPayment(orderId, 700, '2026-09-06');
    await insertMatch(lineId, paymentId, orderId, { onecAmount: 700, date: '2026-09-05', orderRef: o.ref, paymentAmount: 700, paymentDate: '2026-09-06' });
    const matched = (await find(all, lineId))!;
    expect(matched.state).toBe('matched');
    expect(matched.payment).toEqual({ hidden: false, paymentId, amount: '700.00', paymentDate: '2026-09-06', typeName: null, orderId, orderName: '9401' });

    const flip = async (sql: string, undo: string, params: unknown[]) => {
      await replica(sql, params);
      const changed = await state(lineId);
      await replica(undo, params);
      return changed?.[0];
    };
    // Изменилась сумма платежа, дата платежа, платёж перенесён в другой заказ.
    expect(await flip('UPDATE payments SET amount = 701 WHERE payment_id = $1', 'UPDATE payments SET amount = 700 WHERE payment_id = $1', [paymentId])).toBe('changed');
    expect(await flip(`UPDATE payments SET payment_date = '2026-09-07' WHERE payment_id = $1`, `UPDATE payments SET payment_date = '2026-09-06' WHERE payment_id = $1`, [paymentId])).toBe('changed');
    expect(await flip(`UPDATE payments SET order_id = ${other} WHERE payment_id = $1`, `UPDATE payments SET order_id = ${orderId} WHERE payment_id = $1`, [paymentId])).toBe('changed');
    // Изменилась строка 1С: сумма, заказ, проведённость документа, дата.
    expect(await flip('UPDATE onec_document_lines SET amount = 699 WHERE onec_document_line_id = $1', 'UPDATE onec_document_lines SET amount = 700 WHERE onec_document_line_id = $1', [lineId])).toBe('changed');
    expect(await flip(`UPDATE onec_document_lines SET onec_order_ref_key = '${K()}' WHERE onec_document_line_id = $1`, `UPDATE onec_document_lines SET onec_order_ref_key = '${o.ref}' WHERE onec_document_line_id = $1`, [lineId])).toBe('changed');
    expect(await flip('UPDATE onec_documents SET posted = false WHERE onec_document_id = $1', 'UPDATE onec_documents SET posted = true WHERE onec_document_id = $1', [receipt.id])).toBe('changed');
    expect(await flip(`UPDATE onec_documents SET doc_date = '2026-09-04' WHERE onec_document_id = $1`, `UPDATE onec_documents SET doc_date = '2026-09-05' WHERE onec_document_id = $1`, [receipt.id])).toBe('changed');
    // Заказ ERP удалён (soft-delete).
    expect(await flip('UPDATE orders SET delete_flag = true WHERE order_id = $1', 'UPDATE orders SET delete_flag = false WHERE order_id = $1', [orderId])).toBe('changed');
    expect((await state(lineId))?.[0]).toBe('matched');
  });

  it('scope is the PAYMENT scope: own = orders the user created or manages; rows without an ERP order only for «all»', async () => {
    const mine = await erpOrder('9501', { createdBy: MANAGER });
    const managed = await erpOrder('9502', { createdBy: OWNER, managerId: MANAGER });
    const foreign = await erpOrder('9503', { createdBy: OWNER });
    const receipt = await onecDoc('bank_receipt', `${tag}-scope`, '2026-09-05');
    const lMine = await payLine(receipt.id, 1, 11, { orderRef: (await onecOrder(`${SERIES}-9501`)).ref });
    const lManaged = await payLine(receipt.id, 2, 12, { orderRef: (await onecOrder(`${SERIES}-9502`)).ref });
    const lForeign = await payLine(receipt.id, 3, 13, { orderRef: (await onecOrder(`${SERIES}-9503`)).ref });
    const lNoOrder = await payLine(receipt.id, 4, 14);
    const own = ctx(MANAGER, 'own');
    const visible = async (context: ReceiptsReadContext) => {
      const ids = new Set((await repo.list(context, { page: 1, pageSize: 100, search: `${tag}-scope` })).data.map((row) => row.lineId));
      return [lMine, lManaged, lForeign, lNoOrder].map((line) => ids.has(line));
    };
    expect(await visible(all)).toEqual([true, true, true, true]);
    expect(await visible(own)).toEqual([true, true, false, false]);
    expect(await visible(ctx(MANAGER, 'none'))).toEqual([false, false, false, false]);
    // Счётчики считают только видимое; карточка чужой строки неотличима от несуществующей.
    const counters = (await repo.list(own, { page: 1, pageSize: 100, search: `${tag}-scope` })).counters;
    expect(Object.values(counters).reduce((sum, n) => sum + n, 0)).toBe(2);
    await expect(repo.getCard(own, lForeign)).rejects.toMatchObject({ statusCode: 404, code: 'ONEC_RECEIPT_NOT_FOUND' });
    await expect(repo.getCard(own, lNoOrder)).rejects.toMatchObject({ statusCode: 404 });
    expect((await repo.getCard(own, lMine)).line.erpOrder).toMatchObject({ orderId: mine });
    expect((await repo.getCard(own, lManaged)).line.erpOrder).toMatchObject({ orderId: managed });
    void foreign;
  });

  it('a matched payment moved to an order outside the scope: the line stays visible, the payment attributes do not leak', async () => {
    const mine = await erpOrder('9601', { createdBy: MANAGER });
    const foreign = await erpOrder(`${tag}-чужой`, { createdBy: OWNER });
    const o = await onecOrder(`${SERIES}-9601`);
    const lineId = await payLine((await onecDoc('bank_receipt', `${tag}-moved`, '2026-09-05')).id, 1, 900, { orderRef: o.ref });
    const paymentId = await erpPayment(mine, 900, '2026-09-05');
    await insertMatch(lineId, paymentId, mine, { onecAmount: 900, date: '2026-09-05', orderRef: o.ref, paymentAmount: 900, paymentDate: '2026-09-05' });
    const own = ctx(MANAGER, 'own');
    expect((await find(own, lineId))!.payment).toMatchObject({ hidden: false, paymentId });
    await replica('UPDATE payments SET order_id = $2 WHERE payment_id = $1', [paymentId, foreign]);
    const moved = (await find(own, lineId))!;
    expect(moved.state).toBe('changed');
    expect(moved.payment).toEqual({ hidden: true });
    expect(JSON.stringify(moved)).not.toContain(`${tag}-чужой`);
    const card = await repo.getCard(own, lineId);
    expect(card.history).toEqual([expect.objectContaining({ kind: 'matched', payment: { hidden: true } })]);
    // Кандидаты — только платежи заказа строки (перенесённого платежа среди них уже нет).
    expect(card.candidates).toEqual([]);
    expect((await find(all, lineId))!.payment).toMatchObject({ hidden: false, orderId: foreign });
  });

  it('refunds: the order comes through the refunded receipt; subtracted once per order; a multi-order receipt is not attributed', async () => {
    const orderId = await erpOrder('9701');
    const o = await onecOrder(`${SERIES}-9701`);
    const o2 = await onecOrder(`${SERIES}-9702`);
    await erpOrder('9702');
    // Поступление двумя строками на один заказ + возврат по документу.
    const receipt = await onecDoc('bank_receipt', `${tag}-rf`, '2026-09-05');
    const l1 = await payLine(receipt.id, 1, 100, { orderRef: o.ref });
    const l2 = await payLine(receipt.id, 2, 100, { orderRef: o.ref });
    const refundDoc = await onecDoc('cash_refund', `${tag}-rf-возврат`, '2026-09-08');
    const refund = await payLine(refundDoc.id, 1, 50, { settlementRef: receipt.ref });
    const refundRow = (await find(all, refund))!;
    expect([refundRow.state, refundRow.isRefund, refundRow.erpOrder?.orderId, refundRow.refundOf]).toEqual(['refund_info', true, orderId, { documentId: receipt.id, number: `${tag}-rf` }]);
    const card = await repo.getCard(all, l1);
    expect(card.onecPaid).toBe('150.00'); // 100 + 100 − 50, возврат вычтен один раз
    expect(card.refunds).toEqual([{ lineId: refund, documentId: refundDoc.id, kind: 'cash_refund', number: `${tag}-rf-возврат`, date: '2026-09-08', amount: '50.00', currency: 'KZT', live: true }]);
    expect((await find(all, l1))!.refundedAmount).toBe('50.00');
    expect((await find(all, l2))!.refundedAmount).toBe('50.00');
    // Возврат меняет токен строки поступления.
    const token = (await find(all, l1))!.stateToken;
    await db.query('UPDATE onec_document_lines SET amount = 60 WHERE onec_document_line_id = $1', [refund]);
    expect((await find(all, l1))!.stateToken).not.toBe(token);
    // Поступление на два заказа: возврат к заказу не относится.
    const mixed = await onecDoc('bank_receipt', `${tag}-rf-mixed`, '2026-09-05');
    await payLine(mixed.id, 1, 100, { orderRef: o.ref });
    await payLine(mixed.id, 2, 100, { orderRef: o2.ref });
    const refundMixed = await payLine((await onecDoc('bank_refund', `${tag}-rf-mixed-возврат`, '2026-09-08')).id, 1, 30, { settlementRef: mixed.ref });
    expect(await state(refundMixed)).toEqual(['no_erp_order', 'refund_order_unknown']);
    // Поступление не загружено.
    expect(await state(await payLine((await onecDoc('bank_refund', `${tag}-rf-нет`, '2026-09-08')).id, 1, 30, { settlementRef: K() }))).toEqual(['no_erp_order', 'refund_order_unknown']);
    // Возврат в другой валюте не складывается с суммой в тенге; в карточке он показан со своей валютой.
    const usdRefund = await payLine((await onecDoc('bank_refund', `${tag}-rf-usd`, '2026-09-09', { currency: 'USD' })).id, 1, 7, { settlementRef: receipt.ref });
    expect((await find(all, l1))!.refundedAmount).toBe('60.00');
    expect((await repo.getCard(all, l1)).refunds.map((r) => [r.lineId, r.amount, r.currency])).toEqual([[refund, '60.00', 'KZT'], [usdRefund, '7.00', 'USD']]);
    // Поступление сверено с платежом → возврат на ручной разбор.
    const paymentId = await erpPayment(orderId, 100, '2026-09-05');
    await insertMatch(l1, paymentId, orderId, { onecAmount: 100, date: '2026-09-05', orderRef: o.ref, paymentAmount: 100, paymentDate: '2026-09-05' });
    expect((await state(refund))?.[0]).toBe('refund_review');
    const list = await repo.list(all, { page: 1, pageSize: 100, search: `${tag}-rf`, group: 'review' });
    expect(list.data.map((row) => row.lineId)).toContain(refund);
    expect(list.counters.review).toBeGreaterThanOrEqual(1);
  });

  it('a refund of a receipt that covers a foreign order too is not shown to a user with the «own» scope — in no response', async () => {
    const mine = await erpOrder('9651', { createdBy: MANAGER });
    await erpOrder('9652', { createdBy: OWNER });
    const oMine = await onecOrder(`${SERIES}-9651`);
    const oForeign = await onecOrder(`${SERIES}-9652`);
    const receipt = await onecDoc('bank_receipt', `${tag}-rfscope`, '2026-09-05');
    const myLine = await payLine(receipt.id, 1, 100, { orderRef: oMine.ref });
    await payLine(receipt.id, 2, 200, { orderRef: oForeign.ref });
    const refundDoc = await onecDoc('bank_refund', `${tag}-rfscope-возврат`, '2026-09-08');
    const refundLine = await payLine(refundDoc.id, 1, 150, { settlementRef: receipt.ref });
    const own = ctx(MANAGER, 'own');
    // Заказ возврата не определён (поступление на два заказа): в списке и напрямую он пользователю недоступен…
    expect(await find(own, refundLine)).toBeUndefined();
    await expect(repo.getCard(own, refundLine)).rejects.toMatchObject({ statusCode: 404 });
    // …и через карточку и строку своего поступления тоже: ни номера, ни суммы.
    const ownRow = (await find(own, myLine))!;
    expect(ownRow.refundedAmount).toBe('0.00');
    const ownCard = await repo.getCard(own, myLine);
    expect(ownCard.refunds).toEqual([]);
    expect(ownCard.onecPaid).toBe('100.00');
    expect(JSON.stringify([ownRow, ownCard])).not.toContain('rfscope-возврат');
    expect(JSON.stringify([ownRow, ownCard])).not.toContain('150.00');
    // При области «все» возврат виден.
    expect((await find(all, myLine))!.refundedAmount).toBe('150.00');
    expect((await repo.getCard(all, myLine)).refunds.map((r) => r.lineId)).toEqual([refundLine]);
    // Возврат с собственным заказом пользователя (или поступление целиком на его заказ) виден и при «own».
    const single = await onecDoc('bank_receipt', `${tag}-rfscope-один`, '2026-09-05');
    const singleLine = await payLine(single.id, 1, 300, { orderRef: oMine.ref });
    const visibleRefund = await payLine((await onecDoc('cash_refund', `${tag}-rfscope-один-возврат`, '2026-09-08')).id, 1, 40, { settlementRef: single.ref });
    expect((await find(own, singleLine))!.refundedAmount).toBe('40.00');
    expect((await repo.getCard(own, singleLine)).refunds.map((r) => r.lineId)).toEqual([visibleRefund]);
    expect((await find(own, visibleRefund))!.erpOrder?.orderId).toBe(mine);
  });

  it('card: candidate payments of the order with amount/date hints; another source never mixes in', async () => {
    const orderId = await erpOrder('9801');
    const o = await onecOrder(`${SERIES}-9801`);
    const lineId = await payLine((await onecDoc('bank_receipt', `${tag}-card`, '2026-09-05')).id, 1, 250, { orderRef: o.ref });
    const same = await erpPayment(orderId, 250, '2026-09-07');
    const diff = await erpPayment(orderId, 300, '2026-09-05');
    const card = await repo.getCard(all, lineId);
    expect(card.candidates.map((c) => [c.paymentId, c.sameAmount, c.daysApart, c.matchedTo])).toEqual([[diff, false, 0, null], [same, true, 2, null]]);
    expect(new Set(card.candidates.map((c) => c.paymentToken)).size).toBe(2);
    expect(card.capabilities).toEqual({ commands: false });
    // Заказ 1С с тем же ключом в другом источнике не связывает строку с заказом.
    const foreignOrder = await onecDoc('customer_order', `${SERIES}-9801`, '2026-09-02', { sourceId: otherSource });
    const foreignLine = await payLine((await onecDoc('bank_receipt', `${tag}-card-src`, '2026-09-05')).id, 1, 5, { orderRef: foreignOrder.ref });
    expect(await state(foreignLine)).toEqual(['no_erp_order', 'onec_order_not_loaded']);
  });

  it('list: filters by group, kind and period; pagination total; search is literal', async () => {
    const o = await onecOrder(`${SERIES}-9901`);
    await erpOrder('9901');
    const receipt = await onecDoc('cash_receipt', `${tag}-list_%`, '2026-08-10');
    const lineId = await payLine(receipt.id, 1, 5, { orderRef: o.ref });
    const q = { page: 1, pageSize: 100, search: `${tag}-list_%` };
    expect((await repo.list(all, q)).data.map((row) => row.lineId)).toEqual([lineId]);
    expect((await repo.list(all, { ...q, search: `${tag}-listX%` })).data).toEqual([]); // «_» и «%» — не шаблон
    expect((await repo.list(all, { ...q, group: 'to_create' })).pagination.total).toBe(1);
    expect((await repo.list(all, { ...q, group: 'matched' })).pagination.total).toBe(0);
    expect((await repo.list(all, { ...q, kind: 'refunds' })).data).toEqual([]);
    expect((await repo.list(all, { ...q, dateFrom: '2026-08-11' })).data).toEqual([]);
    expect((await repo.list(all, { ...q, dateTo: '2026-08-10' })).data).toHaveLength(1);
    // Страница за концом списка: строк нет, но итог и число страниц остаются настоящими.
    const beyond = await repo.list(all, { ...q, pageSize: 1, page: 2 });
    expect([beyond.data, beyond.pagination.total, beyond.pagination.totalPages]).toEqual([[], 1, 1]);
  });

  it('service: flag off → 503; missing permission or scope none → 403 with a denial audit; allowed → rows by scope', async () => {
    const user = (permissions: string[], view: string): CurrentUser => ({
      id: String(MANAGER), username: `${tag}-manager`, role: 'manager', roleId: 10, permissions: permissions as never,
      policyScopes: { payments: { view, create: 'own', update: 'own', delete: 'own' } } as never,
    });
    const service = (viewEnabled: boolean) => new OnecReceiptsService({ read: repo, settings: () => ({ viewEnabled, series: SERIES }), auditClient: database });
    const full = ['payments.onec.view', 'payments.view'];
    await expect(service(false).list(user(full, 'own'), { page: 1, pageSize: 10 }, 'req-off')).rejects.toMatchObject({ statusCode: 503, code: 'ONEC_PAYMENT_MATCHING_DISABLED' });
    const denied = async (requestId: string) => (await db.query(
      `SELECT event, status_code, metadata_json->>'action' AS action FROM audit_log WHERE request_id = $1`, [requestId])).rows;
    await expect(service(true).list(user(['payments.view'], 'own'), { page: 1, pageSize: 10 }, `${tag}-d1`)).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
    expect(await denied(`${tag}-d1`)).toEqual([{ event: 'payments.onec_denied', status_code: 'missing_permission', action: 'list' }]);
    await expect(service(true).getCard(user(full, 'none'), 1, `${tag}-d2`)).rejects.toMatchObject({ statusCode: 403 });
    expect(await denied(`${tag}-d2`)).toEqual([{ event: 'payments.onec_denied', status_code: 'scope_none', action: 'card' }]);
    const allowed = await service(true).list(user(full, 'own'), { page: 1, pageSize: 100, search: `${tag}-scope` }, `${tag}-ok`);
    expect(allowed.data).toHaveLength(2);
    expect(await denied(`${tag}-ok`)).toEqual([]);
  });

  it('«Заказы 1С»: refunds through the receipt reduce «Оплачено» only when the view flag is on', async () => {
    const o = await onecDoc('customer_order', `${tag}-заказ`, '2026-09-02');
    await db.query(`UPDATE onec_documents SET amount = 1000 WHERE onec_document_id = $1`, [o.id]);
    const receipt = await onecDoc('bank_receipt', `${tag}-oz`, '2026-09-05');
    await payLine(receipt.id, 1, 600, { orderRef: o.ref });
    await payLine((await onecDoc('cash_refund', `${tag}-oz-возврат`, '2026-09-08')).id, 1, 150, { settlementRef: receipt.ref });
    const read = (flag: boolean) => {
      const config = new ConfigService<BackendEnv, true>({
        BACKEND_ENABLE_ONEC_AGENT: true, ONEC_CLIENT_CERT_HEADER: 'x-client-cert', BACKEND_ONEC_PAYMENT_MATCHING_VIEW: flag,
      } as Partial<BackendEnv>);
      return new OnecCustomerDocumentsReadService(database, new OnecRuntimeConfigService(config), config);
    };
    const off = await read(false).getOrder(o.id);
    expect([off.paid, off.payments.map((p) => p.docKind)]).toEqual(['600.00', ['bank_receipt']]);
    const on = await read(true).getOrder(o.id);
    expect([on.paid, on.payments.map((p) => [p.docKind, p.amount])]).toEqual(['450.00', [['bank_receipt', '600.00'], ['cash_refund', '150.00']]]);
    expect((await read(true).listOrders({ search: `${tag}-заказ` })).items[0]).toMatchObject({ paid: '450.00' });
    expect((await read(false).listOrders({ search: `${tag}-заказ` })).items[0]).toMatchObject({ paid: '600.00' });
  });
});
