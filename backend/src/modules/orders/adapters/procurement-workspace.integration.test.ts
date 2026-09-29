import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackendEnv } from '../../../config/env.validation';
import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { ProcurementWorklistLineDto, ProcurementWorklistQuery } from '../application/procurement-workspace.types';
import { addDays, subtractWorkingDays, todayInAlmaty } from '../domain/procurement-worklist';
import { PgOnecDocumentsRepository } from './pg-onec-documents-repository';
import { PgOrderResourceDemandRepository } from './pg-order-resource-demand-repository';
import { PgOrderResourceProcurementRepository } from './pg-order-resource-procurement-repository';
import { PgProcurementWorkspaceRepository } from './pg-procurement-workspace-repository';

// Committed fixtures in an OWNED disposable database only (run-races.cjs):
// the URL must opt in via ERP_PROCUREMENT_RACE_DATABASE_URL and name a "procurement_race_*" database.
const url = process.env.ERP_PROCUREMENT_RACE_DATABASE_URL;
const targetEnv = process.env.ERP_PROCUREMENT_RACE_TARGET_ENV;
const nameKey = (name: string) => `n:${createHash('md5').update(name.replace(/^ +| +$/g, '').toLowerCase(), 'utf8').digest('hex')}`;
const migration204 = readFileSync(new URL('../../../../db/migrations/204_procurement_workspace.sql', import.meta.url), 'utf8');

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

describe.skipIf(!url)('procurement workspace — real PostgreSQL, committed fixtures', { timeout: 30000 }, () => {
  let pool: Pool;
  let conn: PoolClient;
  let docs: PgOnecDocumentsRepository;
  let commands: PgOrderResourceProcurementRepository;
  let reads: PgOrderResourceDemandRepository;
  let workspace: PgProcurementWorkspaceRepository;
  const tag = 'E2E-Тест-СН-' + randomUUID().slice(0, 8);
  let admin: CurrentUser;
  let manager: CurrentUser;
  let orderIds: number[] = [];
  let sheetMaterialTypeId: number;
  let sourceId: number;
  const today = todayInAlmaty();
  const sheetKey = () => `sheet_material:${sheetMaterialTypeId}`;
  const options = { procurementEnabled: true, supplyWorkspaceEnabled: true };
  const allQuery: ProcurementWorklistQuery = { preset: 'all', groupBy: 'none', sort: 'due' };

  async function worklistLine(orderId: number, user: CurrentUser = admin): Promise<ProcurementWorklistLineDto | undefined> {
    const result = await workspace.listWorklist(user, allQuery, options);
    return result.lines.find((line) => line.orderId === orderId && line.resourceKey === sheetKey());
  }

  async function demandLine(orderId: number) {
    const card = await reads.getCard({ currentUser: admin, orderId }, { procurementEnabled: true, canSeeAmounts: true });
    return card.data.lines.find((candidate) => candidate.resourceKey === sheetKey())!;
  }

  async function receipt(counterparty: string, quantity: number): Promise<{ documentId: number; lineId: number }> {
    const documentId = Number((await conn.query(
      `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, amount)
       VALUES ($1, 'purchase_receipt', $2, $3, $4, true, $5, 1000) RETURNING onec_document_id`,
      [sourceId, randomUUID(), `${tag.slice(-8)}-${randomUUID().slice(0, 6)}`, today, counterparty])).rows[0].onec_document_id);
    const lineId = Number((await conn.query(
      `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_name, quantity, unit_code, sheet_material_type_id)
       VALUES ($1, 1, $2, $3, 'm2', $4) RETURNING onec_document_line_id`,
      [documentId, `${tag} лист`, quantity, sheetMaterialTypeId])).rows[0].onec_document_line_id);
    return { documentId, lineId };
  }

  async function allocate(orderId: number, doc: { documentId: number; lineId: number }, quantity: number, suffix: string) {
    const current = await demandLine(orderId);
    return docs.addAllocation({
      currentUser: admin, documentId: doc.documentId, lineId: doc.lineId, orderId, resourceKey: sheetKey(), quantity,
      expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint, requestId: `${tag}-${suffix}`,
    });
  }

  beforeAll(async () => {
    expect(targetEnv).toBe('backend-test');
    expect(decodeURIComponent(new URL(url!).pathname.slice(1)).startsWith('procurement_race_')).toBe(true);
    pool = new Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
    conn = await pool.connect();
    const db = new CommittedDatabase(conn);
    docs = new PgOnecDocumentsRepository(db);
    commands = new PgOrderResourceProcurementRepository(db);
    reads = new PgOrderResourceDemandRepository(db);
    workspace = new PgProcurementWorkspaceRepository(db);

    const adminId = Number((await conn.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 1) RETURNING user_id`,
      [tag + '-admin', tag + '-admin@example.invalid'])).rows[0].user_id);
    const managerId = Number((await conn.query(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 10) RETURNING user_id`,
      [tag + '-manager', tag + '-manager@example.invalid'])).rows[0].user_id);
    await conn.query('SELECT set_config($1, $2, false)', ['app.user_id', String(adminId)]);
    await conn.query('SELECT set_config($1, $2, false)', ['hasura.user',
      JSON.stringify({ 'x-hasura-user-id': String(adminId), 'x-hasura-role': 'admin' })]);
    const perms = ['orders.view', 'procurement.view', 'procurement.manage', 'finance.view', 'settings.manage'];
    admin = { id: String(adminId), username: tag + '-admin', role: 'admin', roleId: 1, permissions: perms };
    manager = { id: String(managerId), username: tag + '-manager', role: 'manager', roleId: 10, permissions: perms };

    sheetMaterialTypeId = Number((await conn.query(
      // Материал, которого не касаются остальные интеграционные тесты этого прогона (они берут первые два),
      // иначе «первый поставщик» уже записан их приходами — и это правильное поведение.
      'SELECT sheet_material_type_id FROM sheet_material_types ORDER BY sheet_material_type_id DESC LIMIT 1')).rows[0].sheet_material_type_id);
    const millingTypeId = Number((await conn.query('SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1')).rows[0].milling_type_id);
    const edgeTypeId = Number((await conn.query('SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1')).rows[0].edge_type_id);
    const clientId = Number((await conn.query('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    const projectId = Number((await conn.query(
      'INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id',
      [('E2E-' + randomUUID().slice(0, 8)).toUpperCase(), tag, clientId, adminId])).rows[0].project_id);
    orderIds = [];
    for (let index = 0; index < 5; index += 1) {
      await conn.query('BEGIN');
      const orderId = Number((await conn.query(
        `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, planned_completion_date)
         VALUES ($1, $2, $3, 1, 1, $4, $5::date) RETURNING order_id`,
        [`${tag}-${index}`, clientId, projectId, adminId, addDays(today, 2 + index)])).rows[0].order_id);
      // Потребность 2 м² (1000×1000×2).
      await conn.query(
        `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area,
            sheet_material_type_id, milling_type_id, edge_type_id, created_by)
         VALUES ($1, 1, 1000, 1000, 2, 2, $2, $3, $4, $5)`,
        [orderId, sheetMaterialTypeId, millingTypeId, edgeTypeId, adminId]);
      await conn.query('COMMIT');
      orderIds.push(orderId);
    }
    sourceId = Number((await conn.query(
      `INSERT INTO onec_sources (code, display_name) VALUES ($1, $2) RETURNING source_id`,
      [('e2e-' + randomUUID().slice(0, 8)), tag])).rows[0].source_id);
  }, 30000);

  afterAll(async () => {
    try { conn?.release(); } catch { /* released */ }
    await pool?.end().catch(() => undefined);
  });

  it('shows need, deficit, due date and urgency for an unmarked material', async () => {
    const line = await worklistLine(orderIds[0]);
    expect(line).toMatchObject({
      need: 2, received: 0, covered: 0, deficit: 2, coverage: 'none', needsAction: true, purchased: false,
      plannedCompletionDate: addDays(today, 2),
      dueDate: subtractWorkingDays(addDays(today, 2), 2),
      supplier: { key: 'none', source: 'none' },
    });
    expect(['overdue', 'critical']).toContain(line!.urgency);
  });

  it('a receipt covers by quantity, marks with origin onec and records the first supplier', async () => {
    const orderId = orderIds[0];
    const doc = await receipt(`${tag} Поставщик А`, 5);
    const result = await allocate(orderId, doc, 1.5, 'rcv-a');
    expect(result.line.procurement).toMatchObject({ purchased: true, origin: 'onec' });
    expect(await worklistLine(orderId)).toMatchObject({
      received: 1.5, covered: 1.5, deficit: 0.5, coverage: 'partial', purchaseOrigin: 'onec', lockedByOnec: true,
      supplier: { key: nameKey(`${tag} Поставщик А`), source: 'first_receipt', others: [] },
    });
  });

  it('a later supplier never overwrites the first one — it is added to «others»', async () => {
    const orderId = orderIds[1];
    const doc = await receipt(`${tag} Поставщик Б`, 5);
    await allocate(orderId, doc, 2, 'rcv-b');
    const line = await worklistLine(orderId);
    expect(line?.supplier.name).toBe(`${tag} Поставщик А`);
    expect(line?.supplier.others).toEqual([{ key: nameKey(`${tag} Поставщик Б`), name: `${tag} Поставщик Б` }]);
    expect(line).toMatchObject({ coverage: 'covered', deficit: 0 });
    const rows = (await conn.query(
      `SELECT supplier_key FROM resource_suppliers WHERE resource_kind = 'sheet_material' AND sheet_material_type_id = $1
        AND counterparty_name LIKE $2 ORDER BY first_seen_at, resource_supplier_id`,
      [sheetMaterialTypeId, `${tag}%`])).rows;
    expect(rows).toHaveLength(2);
  });

  it('CR2-2: a 1C counterparty name of any length does not break the allocation (fixed-length key)', async () => {
    const orderId = orderIds[1];
    const longName = `${tag} ${'Очень длинное наименование контрагента '.repeat(12)}`;
    expect(longName.length).toBeGreaterThan(300);
    const doc = await receipt(longName, 1);
    const result = await allocate(orderId, doc, 0.5, 'rcv-long');
    expect(result.changed).toBe(true);
    const row = (await conn.query(`SELECT supplier_key FROM resource_suppliers WHERE counterparty_name = $1`, [longName.trim()])).rows[0];
    expect(row.supplier_key).toBe(nameKey(longName));
    expect(row.supplier_key).toHaveLength(34);
  });

  it('R4-3: removing the only receipt of a receipt-set mark brings the deficit back', async () => {
    const orderId = orderIds[2];
    const doc = await receipt(`${tag} Поставщик А`, 5);
    const added = await allocate(orderId, doc, 2, 'rcv-c');
    expect(await worklistLine(orderId)).toMatchObject({ coverage: 'covered', deficit: 0 });
    await docs.removeAllocation({
      currentUser: admin, documentId: doc.documentId, lineId: doc.lineId, allocationId: added.allocationId,
      expectedVersion: added.line.procurement.version, requestId: `${tag}-rm-c`,
    });
    expect(await worklistLine(orderId)).toMatchObject({ purchased: true, purchaseOrigin: 'onec', received: 0, deficit: 2, needsAction: true });
  });

  it('a manual mark without receipts covers the need', async () => {
    const orderId = orderIds[3];
    const current = await demandLine(orderId);
    await commands.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: true,
      expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint, requestId: `${tag}-manual`,
    });
    expect(await worklistLine(orderId)).toMatchObject({ purchaseOrigin: 'manual', covered: 2, deficit: 0, coverage: 'covered', needsAction: false });
  });

  it('migration 204 re-classifies old «manual» receipt marks by the audit event that set the current mark (R7-1)', async () => {
    // Старый писатель: авто-отметка приходом записывалась как 'manual'.
    await conn.query(`UPDATE order_resource_procurement SET origin = 'manual' WHERE order_id = ANY($1::bigint[]) AND purchased`, [orderIds]);
    // Заказ 4: приход → снятие → снятие отметки → ручная отметка ⇒ должен остаться manual.
    const orderId = orderIds[4];
    const doc = await receipt(`${tag} Поставщик А`, 5);
    const added = await allocate(orderId, doc, 1, 'rcv-e');
    await conn.query(`UPDATE order_resource_procurement SET origin = 'manual' WHERE order_id = $1`, [orderId]);
    const removed = await docs.removeAllocation({
      currentUser: admin, documentId: doc.documentId, lineId: doc.lineId, allocationId: added.allocationId,
      expectedVersion: added.line.procurement.version, requestId: `${tag}-rm-e`,
    });
    const unmarked = await commands.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: false,
      expectedVersion: removed.line.procurement.version, expectedDemandFingerprint: removed.line.demandFingerprint, requestId: `${tag}-unmark-e`,
    });
    // Отметки различаются по времени создания событий аудита.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await commands.set({
      currentUser: admin, orderId, resourceKey: sheetKey(), purchased: true,
      expectedVersion: unmarked.line.procurement.version, expectedDemandFingerprint: unmarked.line.demandFingerprint, requestId: `${tag}-remark-e`,
    });

    await conn.query(migration204);
    await conn.query(migration204); // повторное применение — no-op

    const origins = new Map((await conn.query<{ order_id: string; origin: string }>(
      `SELECT order_id::text, origin FROM order_resource_procurement WHERE order_id = ANY($1::bigint[]) AND purchased`,
      [orderIds])).rows.map((row) => [Number(row.order_id), row.origin]));
    expect(origins.get(orderIds[0])).toBe('onec'); // первый приход создал запись закупа (before_json NULL)
    expect(origins.get(orderIds[1])).toBe('onec');
    expect(origins.get(orderIds[2])).toBe('onec'); // приход снят, отметка осталась от прихода
    expect(origins.get(orderIds[3])).toBe('manual');
    expect(origins.get(orderIds[4])).toBe('manual'); // текущую отметку поставила ручная команда
  });

  it('counts, presets and groups by supplier; out-of-scope orders are invisible', async () => {
    const all = await workspace.listWorklist(admin, { ...allQuery, groupBy: 'supplier' }, options);
    const mine = all.lines.filter((line) => orderIds.includes(line.orderId));
    expect(mine).toHaveLength(5);
    expect(all.counts.all).toBeGreaterThanOrEqual(5);
    const action = await workspace.listWorklist(admin, { ...allQuery, preset: 'action' }, options);
    expect(action.lines.every((line) => line.needsAction)).toBe(true);
    expect(all.groups.some((group) => group.label === `${tag} Поставщик А`)).toBe(true);
    const managerView = await workspace.listWorklist(manager, allQuery, options);
    expect(managerView.lines.filter((line) => orderIds.includes(line.orderId))).toEqual([]);
  });

  it('settings: versioned update with one audit row, no-op repeat, stale version → 409', async () => {
    const current = await workspace.getSettings();
    const next = { leadDays: current.leadDays + 1, criticalDays: 2, soonDays: 6, wastePercent: 7.5, digestTime: '09:15', unallocatedAlertDays: 3, overdueWindowDays: 45 };
    const auditBefore = Number((await conn.query(`SELECT count(*)::int AS c FROM audit_log WHERE event = 'procurement.settings_updated'`)).rows[0].c);
    const updated = await workspace.updateSettings({ currentUser: admin, requestId: `${tag}-set`, settings: next, expectedVersion: current.version });
    expect(updated).toMatchObject({ changed: true, settings: { ...next, version: current.version + 1 } });
    const repeat = await workspace.updateSettings({ currentUser: admin, requestId: `${tag}-set2`, settings: next, expectedVersion: current.version });
    expect(repeat.changed).toBe(false);
    await expect(workspace.updateSettings({
      currentUser: admin, requestId: `${tag}-set3`, settings: { ...next, leadDays: 0 }, expectedVersion: current.version,
    })).rejects.toMatchObject({ statusCode: 409, code: 'PROCUREMENT_SETTINGS_VERSION_CONFLICT' });
    const auditAfter = Number((await conn.query(`SELECT count(*)::int AS c FROM audit_log WHERE event = 'procurement.settings_updated'`)).rows[0].c);
    expect(auditAfter).toBe(auditBefore + 1);
    // Новый lead_days сдвигает срок в рабочем списке.
    const line = await worklistLine(orderIds[0]);
    expect(line?.dueDate).toBe(subtractWorkingDays(addDays(today, 2), current.leadDays + 1));
    await workspace.updateSettings({
      currentUser: admin, requestId: `${tag}-restore`, settings: {
        leadDays: current.leadDays, criticalDays: current.criticalDays, soonDays: current.soonDays,
        wastePercent: current.wastePercent, digestTime: current.digestTime, unallocatedAlertDays: current.unallocatedAlertDays,
        overdueWindowDays: current.overdueWindowDays,
      }, expectedVersion: current.version + 1,
    });
  });

  it('CR1-2: more than 500 eligible orders — narrow filters still work, unfiltered request is a clear 422', async () => {
    const adminId = Number(admin.id);
    const clientId = Number((await conn.query('SELECT client_id FROM orders WHERE order_id = $1', [orderIds[0]])).rows[0].client_id);
    const projectId = Number((await conn.query('SELECT project_id FROM orders WHERE order_id = $1', [orderIds[0]])).rows[0].project_id);
    const millingTypeId = Number((await conn.query('SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1')).rows[0].milling_type_id);
    const edgeTypeId = Number((await conn.query('SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1')).rows[0].edge_type_id);
    const fillerMaterial = Number((await conn.query(
      'SELECT sheet_material_type_id FROM sheet_material_types WHERE sheet_material_type_id <> $1 ORDER BY sheet_material_type_id DESC LIMIT 1',
      [sheetMaterialTypeId])).rows[0].sheet_material_type_id);
    await conn.query('BEGIN');
    await conn.query(
      `WITH o AS (
         INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, planned_completion_date)
         SELECT $1 || '-fill-' || g, $2, $3, 1, 1, $4, $5::date FROM generate_series(1, 500) g
         RETURNING order_id)
       INSERT INTO order_details (order_id, detail_number, height, width, quantity, area, sheet_material_type_id, milling_type_id, edge_type_id, created_by)
       SELECT order_id, 1, 100, 100, 1, 0.01, $6, $7, $8, $4 FROM o`,
      [tag, clientId, projectId, adminId, addDays(today, 20), fillerMaterial, millingTypeId, edgeTypeId]);
    await conn.query('COMMIT');
    await expect(workspace.listWorklist(admin, allQuery, options)).rejects.toMatchObject({ statusCode: 422, code: 'PROCUREMENT_WORKLIST_TOO_MANY' });
    const narrowed = await workspace.listWorklist(admin, { ...allQuery, search: `${tag}-0` }, options);
    expect(narrowed.lines.map((line) => line.orderId)).toContain(orderIds[0]);
    const byDue = await workspace.listWorklist(admin, { ...allQuery, dueTo: addDays(today, 3) }, options);
    expect(byDue.lines.every((line) => line.dueDate !== null && line.dueDate <= addDays(today, 3))).toBe(true);
    expect(byDue.lines.some((line) => line.orderId === orderIds[0])).toBe(true);
    // CR2-3: фильтр основного поставщика сужает выборку до лимита.
    const bySupplier = await workspace.listWorklist(admin, { ...allQuery, supplierKey: nameKey(`${tag} Поставщик А`) }, options);
    expect(bySupplier.lines.length).toBeGreaterThan(0);
    expect(bySupplier.lines.every((line) => line.supplier.key === nameKey(`${tag} Поставщик А`))).toBe(true);
    // Убираем наполнитель, чтобы следующие проверки видели прежний объём.
    await conn.query('BEGIN');
    await conn.query(`UPDATE orders SET completion_date = order_date WHERE order_name LIKE $1`, [`${tag}-fill-%`]);
    await conn.query('COMMIT');
  });

  it('CR2-1: window — old overdue orders via search or a wider setting; orders without a date always', async () => {
    const adminId = Number(admin.id);
    const base = (await conn.query('SELECT client_id, project_id FROM orders WHERE order_id = $1', [orderIds[0]])).rows[0];
    const millingTypeId = Number((await conn.query('SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1')).rows[0].milling_type_id);
    const edgeTypeId = Number((await conn.query('SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1')).rows[0].edge_type_id);
    const make = async (suffix: string, orderDate: string, planned: string | null) => {
      await conn.query('BEGIN');
      const id = Number((await conn.query(
        `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, order_date, planned_completion_date)
         VALUES ($1, $2, $3, 1, 1, $4, $5::date, $6::date) RETURNING order_id`,
        [`${tag}-${suffix}`, base.client_id, base.project_id, adminId, orderDate, planned])).rows[0].order_id);
      await conn.query(
        `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area, sheet_material_type_id, milling_type_id, edge_type_id, created_by)
         VALUES ($1, 1, 1000, 1000, 1, 1, $2, $3, $4, $5)`, [id, sheetMaterialTypeId, millingTypeId, edgeTypeId, adminId]);
      await conn.query('COMMIT');
      return id;
    };
    const oldOverdue = await make('old-overdue', addDays(today, -60), addDays(today, -40));
    const oldNoDate = await make('old-nodate', addDays(today, -200), null);
    const farFuture = await make('far-future', today, addDays(today, 90));
    const ids = async (query: ProcurementWorklistQuery) =>
      new Set((await workspace.listWorklist(admin, query, options)).lines.map((line) => line.orderId));
    // Статусы «Готов к выдаче» / «Выдан» / «Завершен»: материал не нужен, даже если даты выдачи/завершения пусты (CR8-2).
    const statusIds = new Map((await conn.query<{ order_status_code: string; order_status_id: string }>(
      `SELECT order_status_code, order_status_id FROM order_statuses WHERE order_status_code = ANY($1::text[])`,
      [['legacy_2', 'legacy_6', 'legacy_7', 'legacy_8']])).rows.map((row) => [row.order_status_code, Number(row.order_status_id)]));
    expect([...statusIds.keys()].sort()).toEqual(['legacy_2', 'legacy_6', 'legacy_7', 'legacy_8']);
    const byStatus = new Map<string, number>();
    for (const code of ['legacy_2', 'legacy_6', 'legacy_7', 'legacy_8']) {
      const id = await make(`status-${code}`, today, addDays(today, 2));
      await conn.query('BEGIN');
      await conn.query('UPDATE orders SET order_status_id = $2 WHERE order_id = $1', [id, statusIds.get(code)]);
      await conn.query('COMMIT');
      byStatus.set(code, id);
    }
    const byDefault = await ids(allQuery);
    expect(byDefault.has(byStatus.get('legacy_2')!)).toBe(true); // «Оформлен» — контроль: виден
    for (const code of ['legacy_6', 'legacy_7', 'legacy_8']) expect(byDefault.has(byStatus.get(code)!)).toBe(false);
    expect(byDefault.has(oldOverdue)).toBe(false);
    expect(byDefault.has(oldNoDate)).toBe(true);
    expect(byDefault.has(farFuture)).toBe(false);
    expect((await ids({ ...allQuery, search: `${tag}-old-overdue` })).has(oldOverdue)).toBe(true);
    expect((await ids({ ...allQuery, dueFrom: addDays(today, -50) })).has(oldOverdue)).toBe(true);
    const current = await workspace.getSettings();
    await workspace.updateSettings({ currentUser: admin, requestId: `${tag}-window`, expectedVersion: current.version, settings: {
      leadDays: current.leadDays, criticalDays: current.criticalDays, soonDays: current.soonDays, wastePercent: current.wastePercent,
      digestTime: current.digestTime, unallocatedAlertDays: current.unallocatedAlertDays, overdueWindowDays: 60,
    } });
    expect((await ids(allQuery)).has(oldOverdue)).toBe(true);
    await conn.query('BEGIN');
    await conn.query('UPDATE orders SET completion_date = order_date WHERE order_id = ANY($1::bigint[])', [[oldOverdue, oldNoDate, farFuture, ...byStatus.values()]]);
    await conn.query('COMMIT');
  });

  it('CR4-1: an old-writer allocation between migration and swap is repaired by re-running the 204 data blocks', async () => {
    const cut = (from: string, to: string) => {
      const start = migration204.indexOf(from);
      return migration204.slice(start, migration204.indexOf(to, start)).trim();
    };
    const originUpdate = cut('UPDATE public.order_resource_procurement orp', 'COMMENT ON TABLE public.procurement_settings');
    const suppliersBackfill = cut('INSERT INTO public.resource_suppliers', 'ALTER TABLE public.user_preferences');
    // Старый писатель: приход создаёт запись закупа с origin='manual' и не пишет resource_suppliers.
    const orderId = orderIds[3];
    const doc = await receipt(`${tag} Поставщик Окно`, 3);
    const current = await demandLine(orderId);
    await docs.addAllocation({
      currentUser: admin, documentId: doc.documentId, lineId: doc.lineId, orderId, resourceKey: sheetKey(), quantity: 1,
      expectedVersion: current.procurement.version, expectedDemandFingerprint: current.demandFingerprint, requestId: `${tag}-window-old`,
    });
    await conn.query(`DELETE FROM resource_suppliers WHERE first_onec_document_id = $1`, [doc.documentId]);
    expect((await conn.query(`SELECT count(*)::int AS c FROM resource_suppliers WHERE counterparty_name = $1`,
      [`${tag} Поставщик Окно`])).rows[0].c).toBe(0);
    await conn.query(originUpdate);
    await conn.query(suppliersBackfill);
    await conn.query(suppliersBackfill); // повтор — no-op, первый не затирается
    expect((await conn.query(`SELECT count(*)::int AS c FROM resource_suppliers WHERE counterparty_name = $1`,
      [`${tag} Поставщик Окно`])).rows[0].c).toBe(1);
    // Первый записанный поставщик материала по-прежнему первый.
    expect((await worklistLine(orderIds[0]))?.supplier.name).toBe(`${tag} Поставщик А`);
  });

  it('CR5-1: old writer A then B, backfill after the swap — A stays primary, dates come from the allocations', async () => {
    const adminId = Number(admin.id);
    const base = (await conn.query('SELECT client_id, project_id FROM orders WHERE order_id = $1', [orderIds[0]])).rows[0];
    const material = Number((await conn.query(
      `SELECT sheet_material_type_id FROM sheet_material_types
        WHERE sheet_material_type_id <> $1 AND NOT EXISTS (
          SELECT 1 FROM resource_suppliers rs WHERE rs.sheet_material_type_id = sheet_material_types.sheet_material_type_id)
          AND width_mm > 0 AND height_mm > 0
        ORDER BY sheet_material_type_id LIMIT 1`, [sheetMaterialTypeId])).rows[0].sheet_material_type_id);
    const millingTypeId = Number((await conn.query('SELECT milling_type_id FROM milling_types ORDER BY 1 LIMIT 1')).rows[0].milling_type_id);
    const edgeTypeId = Number((await conn.query('SELECT edge_type_id FROM edge_types ORDER BY 1 LIMIT 1')).rows[0].edge_type_id);
    await conn.query('BEGIN');
    const orderId = Number((await conn.query(
      `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, created_by, planned_completion_date)
       VALUES ($1, $2, $3, 1, 1, $4, $5::date) RETURNING order_id`,
      [`${tag}-cr5`, base.client_id, base.project_id, adminId, addDays(today, 3)])).rows[0].order_id);
    await conn.query(
      `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area, sheet_material_type_id, milling_type_id, edge_type_id, created_by)
       VALUES ($1, 1, 1000, 1000, 4, 4, $2, $3, $4, $5)`, [orderId, material, millingTypeId, edgeTypeId, adminId]);
    await conn.query('COMMIT');
    const key = `sheet_material:${material}`;
    const allocateOld = async (supplier: string, suffix: string) => {
      const documentId = Number((await conn.query(
        `INSERT INTO onec_documents (source_id, doc_kind, onec_ref_key, number, doc_date, posted, counterparty_name, amount)
         VALUES ($1, 'purchase_receipt', $2, $3, $4, true, $5, 100) RETURNING onec_document_id`,
        [sourceId, randomUUID(), `${tag.slice(-8)}-${suffix}`, today, supplier])).rows[0].onec_document_id);
      const lineId = Number((await conn.query(
        `INSERT INTO onec_document_lines (onec_document_id, line_no, nomenclature_name, quantity, unit_code, sheet_material_type_id)
         VALUES ($1, 1, 'лист', 2, 'm2', $2) RETURNING onec_document_line_id`, [documentId, material])).rows[0].onec_document_line_id);
      const card = await reads.getCard({ currentUser: admin, orderId }, { procurementEnabled: true, canSeeAmounts: true });
      const line = card.data.lines.find((candidate) => candidate.resourceKey === key)!;
      const result = await docs.addAllocation({ currentUser: admin, documentId, lineId, orderId, resourceKey: key, quantity: 1,
        expectedVersion: line.procurement.version, expectedDemandFingerprint: line.demandFingerprint, requestId: `${tag}-${suffix}` });
      // Старый писатель не вёл реестр поставщиков.
      await conn.query('DELETE FROM resource_suppliers WHERE first_onec_document_id = $1', [documentId]);
      return result.allocationId;
    };
    const allocationA = await allocateOld(`${tag} Первый А`, 'cr5-a');
    await new Promise((resolve) => setTimeout(resolve, 20));
    await allocateOld(`${tag} Второй Б`, 'cr5-b');
    const start = migration204.indexOf('INSERT INTO public.resource_suppliers');
    await conn.query(migration204.slice(start, migration204.indexOf('ALTER TABLE public.user_preferences', start)));
    const rows = (await conn.query<{ counterparty_name: string; first_seen_at: Date }>(
      `SELECT counterparty_name, first_seen_at FROM resource_suppliers WHERE sheet_material_type_id = $1
        ORDER BY first_seen_at, resource_supplier_id`, [material])).rows;
    expect(rows.map((row) => row.counterparty_name)).toEqual([`${tag} Первый А`, `${tag} Второй Б`]);
    const allocatedAt = (await conn.query<{ created_at: Date }>(
      'SELECT created_at FROM order_resource_onec_allocations WHERE allocation_id = $1', [allocationA])).rows[0].created_at;
    expect(rows[0].first_seen_at.toISOString()).toBe(allocatedAt.toISOString());
    const result = await workspace.listWorklist(admin, { ...allQuery, search: `${tag}-cr5` }, options);
    expect(result.lines.find((line) => line.orderId === orderId)?.supplier).toMatchObject({ name: `${tag} Первый А`, source: 'first_receipt' });
  });

  it('CR6-1: the stage chronology reconciliation catches a first supplier recorded later than its earliest receipt', async () => {
    // Копия сверки из spec_erp/reviews/procurement-workspace-p1/stage-deploy.cjs (migrationDataBlocks.supplierChronology).
    const chronology = `SELECT count(*)
      FROM public.resource_suppliers rs
      JOIN LATERAL (
        SELECT min(a.created_at) AS first_at
          FROM public.order_resource_onec_allocations a
          JOIN public.order_resource_procurement orp ON orp.order_resource_procurement_id = a.order_resource_procurement_id
          JOIN public.onec_document_lines l ON l.onec_document_line_id = a.onec_document_line_id
          JOIN public.onec_documents d ON d.onec_document_id = l.onec_document_id
         WHERE a.role = 'receipt'
           AND orp.resource_kind = rs.resource_kind
           AND orp.sheet_material_type_id IS NOT DISTINCT FROM rs.sheet_material_type_id
           AND orp.film_id IS NOT DISTINCT FROM rs.film_id
           AND CASE
                 WHEN d.supplier_id IS NOT NULL THEN 's:' || d.supplier_id
                 WHEN d.counterparty_ref_key IS NOT NULL THEN 'c:' || d.counterparty_ref_key
                 WHEN NULLIF(btrim(d.counterparty_name), '') IS NOT NULL THEN 'n:' || md5(lower(btrim(d.counterparty_name)))
               END = rs.supplier_key
      ) first_allocation ON true
     WHERE rs.source = 'onec_receipt' AND first_allocation.first_at IS NOT NULL
       AND first_allocation.first_at < rs.first_seen_at`;
    const clean = Number((await conn.query(chronology)).rows[0].count);
    expect(clean).toBe(0);
    // Поздняя транзакция старого писателя: реестр уже содержит поставщика с датой позже его самого раннего прихода.
    const row = (await conn.query<{ resource_supplier_id: string }>(
      `SELECT resource_supplier_id FROM resource_suppliers WHERE counterparty_name = $1`, [`${tag} Поставщик А`])).rows[0];
    await conn.query(`UPDATE resource_suppliers SET first_seen_at = first_seen_at + interval '1 day' WHERE resource_supplier_id = $1`,
      [row.resource_supplier_id]);
    expect(Number((await conn.query(chronology)).rows[0].count)).toBe(1);
    await conn.query(`UPDATE resource_suppliers SET first_seen_at = first_seen_at - interval '1 day' WHERE resource_supplier_id = $1`,
      [row.resource_supplier_id]);
    expect(Number((await conn.query(chronology)).rows[0].count)).toBe(0);
  });

  it('saved views round-trip per user', async () => {
    const views = [{ id: randomUUID(), name: 'Срочно МДФ', query: 'preset=urgent&groupBy=supplier' }];
    expect(await workspace.replaceSavedViews(admin, views)).toEqual(views);
    expect(await workspace.getSavedViews(admin)).toEqual(views);
    expect(await workspace.getSavedViews(manager)).toEqual([]);
  });
});
