import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../database/database.service';
import type { TransactionClient } from '../../database/database.types';
import type { CurrentUser } from '../../permissions/current-user';
import { PgSheetMaterialsRepository } from '../sheet-materials/adapters/pg-sheet-materials-repository';
import { OrderHdfSettingsService } from '../orders/application/order-hdf-settings.service';
import { FilmSuppliersService } from './application/film-suppliers.service';
import { buildNarrowingPredicates } from '../orders/adapters/pg-procurement-workspace-repository';

/**
 * Поставщики позиций материалов (migr 280) на полной схеме: БД с миграциями до 279 (stage `erp_test`). Всё — в одной
 * транзакции, которая в конце откатывается (миграция 280 применяется внутри неё же): после теста в БД ничего не остаётся.
 * Без MATERIAL_SUPPLIERS_DATABASE_URL — пропуск (opt-in).
 */
const databaseUrl = process.env.MATERIAL_SUPPLIERS_DATABASE_URL;
const describeIntegration = databaseUrl ? describe : describe.skip;

const migration280 = readFileSync(resolve(__dirname, '../../../db/migrations/280_material_suppliers.sql'), 'utf8')
  .replace(/^BEGIN;\s*$/m, '')
  .replace(/^COMMIT;\s*$/m, '');

describeIntegration('material suppliers (integration, rolled back)', () => {
  let pool: Pool;
  let client: PoolClient;
  let database: DatabaseService;
  let user: CurrentUser;
  const ids = { a: 0, b: 0, c: 0, vendor: 0, film: 0, materialType: 0, unit: 0 };
  const tag = `E2E-Тест ${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(migration280);
    database = rolledBackDatabase(client);
    const actor = (await client.query<{ user_id: string; username: string }>(
      `SELECT user_id, username FROM users WHERE is_active ORDER BY user_id LIMIT 1`,
    )).rows[0];
    user = { id: actor.user_id, username: actor.username, role: 'admin', permissions: [
      'references.view', 'references.manage', 'sheet_materials.view', 'sheet_materials.manage', 'settings.view', 'settings.manage',
    ] } as unknown as CurrentUser;
    const supplier = async (name: string, active: boolean) => Number((await client.query<{ supplier_id: number }>(
      `INSERT INTO suppliers (supplier_name, is_active) VALUES ($1, $2) RETURNING supplier_id`, [name, active],
    )).rows[0].supplier_id);
    ids.a = await supplier(`${tag} A`, true);
    ids.b = await supplier(`${tag} B`, true);
    ids.c = await supplier(`${tag} C`, false);
    ids.vendor = Number((await client.query<{ vendor_id: number }>(
      `INSERT INTO vendors (vendor_name, material_type_id) SELECT $1, material_type_id FROM material_types ORDER BY material_type_id LIMIT 1 RETURNING vendor_id`,
      [`${tag} V`],
    )).rows[0].vendor_id);
    ids.film = Number((await client.query<{ film_id: number }>(
      `INSERT INTO films (film_name, film_type_id, vendor_id)
       SELECT $1, (SELECT film_type_id FROM film_types ORDER BY film_type_id LIMIT 1), $2 RETURNING film_id`,
      [`${tag} плёнка`, ids.vendor],
    )).rows[0].film_id);
    ids.materialType = Number((await client.query<{ id: number }>(`SELECT material_type_id AS id FROM material_types ORDER BY 1 LIMIT 1`)).rows[0].id);
    ids.unit = Number((await client.query<{ id: number }>(`SELECT unit_id AS id FROM units ORDER BY 1 LIMIT 1`)).rows[0].id);
  });

  afterAll(async () => {
    await client?.query('ROLLBACK');
    client?.release();
    await pool?.end();
  });

  const auditCount = async (event: string, entityId: number) => Number((await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM audit_log WHERE event = $1 AND entity_id = $2::text`, [event, String(entityId)],
  )).rows[0].n);

  describe('films', () => {
    const service = () => new FilmSuppliersService(database);

    it('replaces the list in order, audits once with every touched supplier, no-op for the same list', async () => {
      const saved = await service().replace({ currentUser: user, requestId: `${tag}-1`, filmId: ids.film, supplierIds: [ids.b, ids.a], expectedSupplierIds: [] });
      expect(saved.suppliers.map((s) => s.id)).toEqual([ids.b, ids.a]);
      await service().replace({ currentUser: user, requestId: `${tag}-2`, filmId: ids.film, supplierIds: [ids.b, ids.a], expectedSupplierIds: [ids.b, ids.a] });
      expect(await auditCount('film.suppliers_changed', ids.film)).toBe(1);

      await service().replace({ currentUser: user, requestId: `${tag}-3`, filmId: ids.film, supplierIds: [ids.a], expectedSupplierIds: [ids.b, ids.a] });
      // Удалённого поставщика B историю можно найти по связанной сущности.
      const byB = await client.query(
        `SELECT 1 FROM audit_log a JOIN audit_log_related_entity r ON r.audit_id = a.audit_id
          WHERE a.event = 'film.suppliers_changed' AND a.entity_id = $1::text AND r.entity_type = 'supplier' AND r.entity_id = $2`,
        [String(ids.film), ids.b],
      );
      expect(byB.rowCount).toBe(2);
      expect((await service().list([ids.film]))[0]).toMatchObject({ filmId: ids.film, suppliers: [{ id: ids.a }], onecSuppliers: [] });
    });

    it('rejects a stale expected list (409) and an inactive new supplier (422) without changes', async () => {
      await expect(service().replace({ currentUser: user, requestId: `${tag}-4`, filmId: ids.film, supplierIds: [], expectedSupplierIds: [ids.b] }))
        .rejects.toMatchObject({ statusCode: 409, code: 'FILM_SUPPLIERS_STALE' });
      await expect(service().replace({ currentUser: user, requestId: `${tag}-5`, filmId: ids.film, supplierIds: [ids.a, ids.c], expectedSupplierIds: [ids.a] }))
        .rejects.toMatchObject({ statusCode: 422, code: 'MATERIAL_SUPPLIER_INVALID' });
      expect((await service().list([ids.film]))[0].suppliers.map((s) => s.id)).toEqual([ids.a]);
    });
  });

  describe('sheet materials', () => {
    const repo = () => new PgSheetMaterialsRepository(database);
    const base = () => ({
      name: `${tag} лист`, materialTypeId: ids.materialType, unitId: ids.unit, thicknessMm: 16, widthMm: 2800, heightMm: 2070,
      supplierId: ids.a as number | null, vendorId: ids.vendor,
    });
    let sheetId = 0;
    let version = 0;

    it('creates with the main and additional suppliers', async () => {
      const created = await repo().create({ currentUser: user, requestId: `${tag}-s1`, input: { ...base(), additionalSupplierIds: [ids.a, ids.b] } });
      sheetId = created.sheetMaterialTypeId;
      version = created.version;
      // Основной из дополнительных исключается.
      expect(created.additionalSupplierIds).toEqual([ids.b]);
      expect(created.suppliers.map((s) => s.id)).toEqual([ids.a, ids.b]);
    });

    it('an old form body (no additionalSupplierIds) keeps the additional suppliers; clearing the main keeps them too', async () => {
      const legacy = await repo().update({ currentUser: user, requestId: `${tag}-s2`, id: sheetId, expectedVersion: version, input: { ...base(), color: 'Дуб' } });
      expect(legacy.additionalSupplierIds).toEqual([ids.b]);
      const cleared = await repo().update({
        currentUser: user, requestId: `${tag}-s3`, id: sheetId, expectedVersion: legacy.version, input: { ...base(), supplierId: undefined },
      });
      expect(cleared.supplierId).toBeNull();
      expect(cleared.suppliers.map((s) => s.id)).toEqual([ids.b]);
      version = cleared.version;
    });

    it('promotes an additional supplier to the main one and renumbers', async () => {
      const promoted = await repo().update({
        currentUser: user, requestId: `${tag}-s4`, id: sheetId, expectedVersion: version,
        input: { ...base(), supplierId: ids.b, additionalSupplierIds: [ids.b, ids.a] },
      });
      expect(promoted.supplierId).toBe(ids.b);
      expect(promoted.suppliers.map((s) => s.id)).toEqual([ids.b, ids.a]);
      const rows = await client.query<{ supplier_id: number; position: number }>(
        `SELECT supplier_id, position FROM material_suppliers WHERE resource_kind = 'sheet_material' AND sheet_material_type_id = $1 ORDER BY position`,
        [sheetId],
      );
      expect(rows.rows.map((row) => [Number(row.supplier_id), Number(row.position)])).toEqual([[ids.a, 1]]);
      version = promoted.version;
    });

    it('a main supplier written by the previous backend that is also additional is shown once', async () => {
      await client.query('UPDATE sheet_material_types SET supplier_id = $2 WHERE sheet_material_type_id = $1', [sheetId, ids.a]);
      const read = await repo().getById({ currentUser: user, requestId: `${tag}-s5`, id: sheetId });
      expect(read.suppliers.map((s) => s.id)).toEqual([ids.a]);
      expect(read.additionalSupplierIds).toEqual([]);
      await client.query('UPDATE sheet_material_types SET supplier_id = $2 WHERE sheet_material_type_id = $1', [sheetId, ids.b]);
    });

    it('rejects an inactive additional supplier atomically: list, version and audit unchanged', async () => {
      const audits = await auditCount('sheet_material.updated', sheetId);
      await expect(repo().update({
        currentUser: user, requestId: `${tag}-s6`, id: sheetId, expectedVersion: version,
        input: { ...base(), supplierId: ids.b, additionalSupplierIds: [ids.a, ids.c] },
      })).rejects.toMatchObject({ statusCode: 422 });
      const read = await repo().getById({ currentUser: user, requestId: `${tag}-s7`, id: sheetId });
      expect(read.version).toBe(version);
      expect(read.suppliers.map((s) => s.id)).toEqual([ids.b, ids.a]);
      expect(await auditCount('sheet_material.updated', sheetId)).toBe(audits);
    });

    it('rolls back the list, the version and the audit when the write fails after the list was replaced', async () => {
      const audits = await auditCount('sheet_material.updated', sheetId);
      // Управляемый сбой ПОСЛЕ замены списка и UPDATE материала: запись аудита этого события падает.
      await client.query(`CREATE FUNCTION pg_temp.ms_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.event = 'sheet_material.updated' THEN RAISE EXCEPTION 'ms test: audit write failed'; END IF; RETURN NEW; END $$`);
      await client.query('CREATE TRIGGER ms_fail_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp.ms_fail_audit()');
      try {
        await expect(repo().update({
          currentUser: user, requestId: `${tag}-s8`, id: sheetId, expectedVersion: version,
          input: { ...base(), supplierId: ids.b, additionalSupplierIds: [] },
        })).rejects.toThrow(/audit write failed/);
      } finally {
        await client.query('DROP TRIGGER ms_fail_audit ON audit_log');
      }
      const read = await repo().getById({ currentUser: user, requestId: `${tag}-s9`, id: sheetId });
      expect(read.version).toBe(version);
      expect(read.suppliers.map((s) => s.id)).toEqual([ids.b, ids.a]);
      expect(await auditCount('sheet_material.updated', sheetId)).toBe(audits);
    });

    it('a new inactive supplier is rejected as the main one too (create and update); a kept inactive one is allowed', async () => {
      await expect(repo().create({ currentUser: user, requestId: `${tag}-s10`, input: { ...base(), name: `${tag} лист 2`, supplierId: ids.c } }))
        .rejects.toMatchObject({ statusCode: 422 });
      await expect(repo().update({
        currentUser: user, requestId: `${tag}-s11`, id: sheetId, expectedVersion: version, input: { ...base(), supplierId: ids.c },
      })).rejects.toMatchObject({ statusCode: 422 });
      await client.query('UPDATE sheet_material_types SET supplier_id = $2 WHERE sheet_material_type_id = $1', [sheetId, ids.c]);
      const kept = await repo().update({
        currentUser: user, requestId: `${tag}-s12`, id: sheetId, expectedVersion: version, input: { ...base(), supplierId: ids.c, color: 'Белый' },
      });
      expect(kept.supplierId).toBe(ids.c);
      version = kept.version;
    });

    it('clearing after the previous backend promoted an additional supplier removes the hidden row too', async () => {
      // Прежний backend сделал основным A, который есть и среди дополнительных (в DTO скрыт).
      await client.query('UPDATE sheet_material_types SET supplier_id = $2 WHERE sheet_material_type_id = $1', [sheetId, ids.a]);
      const cleared = await repo().update({
        currentUser: user, requestId: `${tag}-s13`, id: sheetId, expectedVersion: version,
        input: { ...base(), supplierId: null, additionalSupplierIds: [] },
      });
      expect(cleared.supplierId).toBeNull();
      expect(cleared.suppliers).toEqual([]);
      const rows = await client.query(
        `SELECT 1 FROM material_suppliers WHERE resource_kind = 'sheet_material' AND sheet_material_type_id = $1`, [sheetId],
      );
      expect(rows.rowCount).toBe(0);
      version = cleared.version;
    });
  });

  describe('extra resources', () => {
    const service = () => new OrderHdfSettingsService(database);
    let resourceId = 0;
    let version = 0;
    const body = () => ({ resourceKind: 'other', resourceName: `${tag} ресурс` });

    it('creates with a vendor and suppliers; an old body (no fields) keeps them; null clears', async () => {
      const created = await service().createExtraResource({
        currentUser: user, ...body(), vendorId: ids.vendor, supplierIds: [ids.b, ids.a], idempotencyKey: `${tag}-e1`, requestId: `${tag}-e1`,
      });
      resourceId = created.id;
      expect(created.vendorId).toBe(ids.vendor);
      expect(created.suppliers?.map((s) => s.id)).toEqual([ids.b, ids.a]);
      const legacy = await service().updateExtraResource({
        currentUser: user, id: resourceId, version: created.version, ...body(), comment: 'x', idempotencyKey: `${tag}-e2`, requestId: `${tag}-e2`,
      });
      expect(legacy.vendorId).toBe(ids.vendor);
      expect(legacy.suppliers?.map((s) => s.id)).toEqual([ids.b, ids.a]);
      const cleared = await service().updateExtraResource({
        currentUser: user, id: resourceId, version: legacy.version, ...body(), vendorId: null, supplierIds: null,
        idempotencyKey: `${tag}-e3`, requestId: `${tag}-e3`,
      });
      expect(cleared.vendorId).toBeNull();
      expect(cleared.suppliers).toEqual([]);
      version = cleared.version;
      const related = await client.query(
        `SELECT r.entity_type, r.entity_id FROM audit_log a JOIN audit_log_related_entity r ON r.audit_id = a.audit_id
          WHERE a.event = 'settings.extra_resource_changed' AND a.entity_id = $1::text AND r.entity_type IN ('vendor', 'supplier')`,
        [String(resourceId)],
      );
      expect(related.rows.map((row) => `${row.entity_type}:${Number(row.entity_id)}`)).toEqual(expect.arrayContaining([
        `vendor:${ids.vendor}`, `supplier:${ids.a}`, `supplier:${ids.b}`,
      ]));
      expect(version).toBeGreaterThan(created.version);
    });

    it('lists the vendor and suppliers in the directory read', async () => {
      await service().updateExtraResource({
        currentUser: user, id: resourceId, version, ...body(), supplierIds: [ids.a], idempotencyKey: `${tag}-e4`, requestId: `${tag}-e4`,
      });
      const listed = (await service().getExtraResources(user)).find((resource) => resource.id === resourceId);
      expect(listed?.suppliers?.map((s) => s.id)).toEqual([ids.a]);
    });
  });
});

describeIntegration('procurement narrowing with chosen suppliers (integration, rolled back)', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(migration280);
  });

  afterAll(async () => {
    await client?.query('ROLLBACK');
    client?.release();
    await pool?.end();
  });

  /** Предикаты сужения на одном заказе (на всей БД stage коррелированные подзапросы идут слишком долго для теста). */
  const ordersMatching = async (orderId: number, query: Record<string, unknown>): Promise<number[]> => {
    const params: unknown[] = [orderId];
    const clauses = buildNarrowingPredicates({ preset: 'all', groupBy: 'none', sort: 'due', ...query } as never, 3, params);
    return (await client.query<{ order_id: string }>(
      `SELECT o.order_id FROM orders o JOIN projects p ON p.project_id = o.project_id LEFT JOIN clients c ON c.client_id = o.client_id
        WHERE o.order_id = $1 AND ${clauses.join(' AND ')}`,
      params,
    )).rows.map((row) => Number(row.order_id));
  };

  it('a film with a chosen supplier and no 1C receipts: the supplier filter (main) and search (any) find the order', async () => {
    const detail = (await client.query<{ order_id: string; film_id: string }>(
      `SELECT d.order_id, d.film_id FROM order_details d
        WHERE d.delete_flag = false AND d.film_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM resource_suppliers rs WHERE rs.resource_kind = 'film' AND rs.film_id = d.film_id)
        ORDER BY d.order_id DESC LIMIT 1`,
    )).rows[0];
    expect(detail, "в БД нужна деталь с плёнкой без поставщиков 1С").toBeDefined();
    const tag = `E2E-Тест ${randomUUID().slice(0, 8)}`;
    const insert = async (name: string) => Number((await client.query<{ supplier_id: number }>(
      `INSERT INTO suppliers (supplier_name) VALUES ($1) RETURNING supplier_id`, [name])).rows[0].supplier_id);
    const main = await insert(`${tag} основной`);
    const second = await insert(`${tag} второй`);
    await client.query(
      `INSERT INTO material_suppliers (resource_kind, film_id, supplier_id, position) VALUES ('film', $1, $2, 1), ('film', $1, $3, 2)`,
      [detail.film_id, main, second],
    );
    const orderId = Number(detail.order_id);
    expect(await ordersMatching(orderId, { supplierKey: `s:${main}` })).toContain(orderId);
    expect(await ordersMatching(orderId, { supplierKey: `s:${second}` })).not.toContain(orderId);
    expect(await ordersMatching(orderId, { search: `${tag} второй` })).toContain(orderId);
  }, 60_000);
});

/** «Транзакции» команд — точки сохранения внутри общей откатываемой транзакции теста. */
function rolledBackDatabase(client: PoolClient): DatabaseService {
  let counter = 0;
  const query = (text: string, params: readonly unknown[] = []) => client.query(text, [...params]);
  return {
    isConfigured: true,
    query,
    async transaction<T>(handler: (tx: TransactionClient) => Promise<T>): Promise<T> {
      const savepoint = `ms_${++counter}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await handler({ raw: client as never, query } as TransactionClient);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      }
    },
  } as unknown as DatabaseService;
}
