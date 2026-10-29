import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import type { OrderResourceDemandQuery, OrderResourceReadOptions } from '../application/order-resource-demand.types';
import { PgOrderResourceDemandRepository } from './pg-order-resource-demand-repository';

// Runs against the stage database (erp_test, test data) inside ONE transaction that is rolled back at the end:
// fixtures never commit (the deferred «production order owns a detail» check never fires), shared rows touched
// here (a sheet material's main supplier) return to their state on ROLLBACK.
const databaseUrl = process.env.ERP_STAGE_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('resource demand header filters, supplier and payment (stage DB, rolled back)', { timeout: 60000 }, () => {
  const tag = 'E2E-Тест-фильтры-' + randomUUID().slice(0, 8);
  let pool: Pool;
  let client: PoolClient;
  let repository: PgOrderResourceDemandRepository;
  let admin: CurrentUser;
  const ids = {} as {
    supplierA: number; supplierB: number; sheet: number; sheetNone: number; bathSheet: number; filmB: number; filmNone: number;
    paid: number; partial: number; unpaid: number; paidSheetDetail: number;
  };
  const options: OrderResourceReadOptions = { procurementEnabled: true };
  const q = <T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []) => client.query<T>(text, params);
  const list = async (over: Partial<OrderResourceDemandQuery>) => (await repository.list(
    { currentUser: admin, query: { page: 1, pageSize: 100, search: tag, ...over } }, options,
  )).data;
  const listed = async (over: Partial<OrderResourceDemandQuery>) => (await list(over)).map((row) => row.orderId).sort((a, b) => a - b);

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 30000 });
    client = await pool.connect();
    await q('BEGIN');
    // The repository opens its own REPEATABLE READ transaction; here every call runs inside the outer one.
    const database = {
      isConfigured: true,
      query: <T extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => client.query<T>(text, [...params]),
      transaction: async <T>(handler: (tx: unknown) => Promise<T>) => handler({
        query: <R extends QueryResultRow = QueryResultRow>(text: string, params: readonly unknown[] = []) => (
          /^\s*SET TRANSACTION/i.test(text) ? Promise.resolve({ rows: [] as R[] }) : client.query<R>(text, [...params])
        ),
      }),
    } as unknown as DatabaseService;
    repository = new PgOrderResourceDemandRepository(database);

    const adminId = Number((await q(
      `INSERT INTO users (username, email, password_hash, role_id) VALUES ($1, $2, 'E2E-NO-LOGIN', 1) RETURNING user_id`,
      [tag + '-admin', tag + '-admin@example.invalid'],
    )).rows[0].user_id);
    await q('SELECT set_config($1, $2, true)', ['app.user_id', String(adminId)]);
    admin = { id: String(adminId), username: tag + '-admin', role: 'admin', roleId: 1, permissions: ['orders.view'] };

    ids.supplierA = Number((await q('INSERT INTO suppliers (supplier_name) VALUES ($1) RETURNING supplier_id', [tag + ' Поставщик А'])).rows[0].supplier_id);
    ids.supplierB = Number((await q('INSERT INTO suppliers (supplier_name) VALUES ($1) RETURNING supplier_id', [tag + ' Поставщик Б'])).rows[0].supplier_id);
    // A non-bath sheet material gets supplier A as its main supplier (rolled back with everything else).
    ids.sheet = Number((await q(`SELECT sheet_material_type_id FROM sheet_material_types WHERE name NOT ILIKE 'ванна%' ORDER BY sheet_material_type_id LIMIT 1`)).rows[0].sheet_material_type_id);
    await q('UPDATE sheet_material_types SET supplier_id = $2 WHERE sheet_material_type_id = $1', [ids.sheet, ids.supplierA]);
    // Another sheet material loses every supplier source for this test: it is «without supplier».
    ids.sheetNone = Number((await q(
      `SELECT sheet_material_type_id FROM sheet_material_types WHERE name NOT ILIKE 'ванна%' AND sheet_material_type_id <> $1
        ORDER BY sheet_material_type_id LIMIT 1`, [ids.sheet],
    )).rows[0].sheet_material_type_id);
    await q('UPDATE sheet_material_types SET supplier_id = NULL WHERE sheet_material_type_id = $1', [ids.sheetNone]);
    await q(`DELETE FROM material_suppliers WHERE resource_kind = 'sheet_material' AND sheet_material_type_id = $1`, [ids.sheetNone]);
    await q(`DELETE FROM resource_suppliers WHERE resource_kind = 'sheet_material' AND sheet_material_type_id = $1`, [ids.sheetNone]);
    ids.bathSheet = Number((await q(`SELECT sheet_material_type_id FROM sheet_material_types WHERE name ILIKE 'ванна%' ORDER BY sheet_material_type_id LIMIT 1`)).rows[0].sheet_material_type_id);
    // Films without any chosen or 1C supplier: one gets supplier B as its first chosen one, one stays «without supplier».
    const freeFilms = (await q<{ film_id: string }>(
      `SELECT f.film_id FROM films f
        WHERE NOT EXISTS (SELECT 1 FROM material_suppliers ms WHERE ms.resource_kind = 'film' AND ms.film_id = f.film_id)
          AND NOT EXISTS (SELECT 1 FROM resource_suppliers rs WHERE rs.resource_kind = 'film' AND rs.film_id = f.film_id)
        ORDER BY f.film_id LIMIT 2`,
    )).rows.map((row) => Number(row.film_id));
    [ids.filmB, ids.filmNone] = freeFilms;
    await q(`INSERT INTO material_suppliers (resource_kind, film_id, supplier_id, position) VALUES ('film', $1, $2, 1)`, [ids.filmB, ids.supplierB]);

    const millingTypeId = Number((await q('SELECT milling_type_id FROM milling_types ORDER BY milling_type_id LIMIT 1')).rows[0].milling_type_id);
    const edgeTypeId = Number((await q('SELECT edge_type_id FROM edge_types ORDER BY edge_type_id LIMIT 1')).rows[0].edge_type_id);
    const clientId = Number((await q('INSERT INTO clients (client_name) VALUES ($1) RETURNING client_id', [tag])).rows[0].client_id);
    const projectId = Number((await q(
      'INSERT INTO projects (code, name, client_id, created_by) VALUES ($1, $2, $3, $4) RETURNING project_id',
      [('E2E-' + randomUUID().slice(0, 8)).toUpperCase(), tag, clientId, adminId],
    )).rows[0].project_id);
    const order = async (suffix: string, paymentStatusId: number, date: string) => Number((await q(
      `INSERT INTO orders (order_name, client_id, project_id, order_status_id, payment_status_id, order_date, created_by)
       VALUES ($1, $2, $3, 1, $4, $5, $6) RETURNING order_id`,
      [`${tag}-${suffix}`, clientId, projectId, paymentStatusId, date, adminId],
    )).rows[0].order_id);
    const detail = async (orderId: number, number: number, sheet: number, film: number | null) => Number((await q(
      `INSERT INTO order_details (order_id, detail_number, height, width, quantity, area,
          sheet_material_type_id, film_id, milling_type_id, edge_type_id, created_by)
       VALUES ($1, $2, 716, 396, 2, 0.57, $3, $4, $5, $6, $7) RETURNING detail_id`,
      [orderId, number, sheet, film, millingTypeId, edgeTypeId, adminId],
    )).rows[0].detail_id);

    ids.paid = await order('paid', 3, '2026-01-11');
    ids.paidSheetDetail = await detail(ids.paid, 1, ids.sheet, ids.filmB);
    ids.partial = await order('partial', 2, '2026-01-12');
    await detail(ids.partial, 1, ids.sheetNone, ids.filmNone);
    ids.unpaid = await order('unpaid', 1, '2026-01-12');
    await detail(ids.unpaid, 1, ids.sheet, null);

    // A ready vacuum-table cut on a «Ванна» sheet holds the paid order's film detail → its film has meters.
    const cutJobId = Number((await q(`INSERT INTO cut_job (name, status) VALUES ($1, 'ready') RETURNING cut_job_id`, [tag])).rows[0].cut_job_id);
    await q(
      `INSERT INTO cut_job_item (cut_job_id, order_id, order_detail_id, qty, is_active) VALUES ($1, $2, $3, 2, true)`,
      [cutJobId, ids.paid, ids.paidSheetDetail],
    );
    const groupId = Number((await q(
      `INSERT INTO cut_group (cut_job_id, sheet_material_type_id, group_key, summary)
       VALUES ($1, $2, $3, '{"engine_used":"vacuum_table"}'::jsonb) RETURNING cut_group_id`,
      [cutJobId, ids.bathSheet, tag],
    )).rows[0].cut_group_id);
    await q(
      `INSERT INTO cut_group_sheet (cut_group_id, sheet_index, placements) VALUES ($1, 0, $2::jsonb)`,
      [groupId, JSON.stringify({
        sheet_width_mm: 1100, sheet_height_mm: 2800, trim_mm: { left: 0, right: 0, top: 0, bottom: 0 },
        pieces: [{ item_id: `det-${ids.paidSheetDetail}`, instance: 1, x_mm: 0, y_mm: 0, width_mm: 396, height_mm: 716, rotated: false }],
      })],
    );
  });

  afterAll(async () => {
    try { await client?.query('ROLLBACK'); } finally { client?.release(); await pool?.end().catch(() => undefined); }
  });

  it('payment: «any_paid» = partially or fully paid, «fully_paid» = paid only', async () => {
    expect(await listed({})).toEqual([ids.paid, ids.partial, ids.unpaid].sort((a, b) => a - b));
    expect(await listed({ payment: 'any_paid' })).toEqual([ids.paid, ids.partial].sort((a, b) => a - b));
    expect(await listed({ payment: 'fully_paid' })).toEqual([ids.paid]);
  });

  it('supplier filter selects orders by the main supplier on all pages and keeps only that supplier\'s materials', async () => {
    const a = `s:${ids.supplierA}`;
    const b = `s:${ids.supplierB}`;
    expect(await listed({ supplierKeys: [a] })).toEqual([ids.paid, ids.unpaid].sort((x, y) => x - y));
    const paidRow = (await list({ supplierKeys: [a] })).find((row) => row.orderId === ids.paid)!;
    expect(paidRow.lines.map((line) => line.resourceKey)).toEqual([`sheet_material:${ids.sheet}`]);
    expect(paidRow.films).toEqual([]);
    expect(paidRow.sheetMaterials.map((row) => row.sheetMaterialTypeId)).toEqual([ids.sheet]);
    expect(paidRow.lines[0]).toMatchObject({ supplierKey: a, supplierName: `${tag} Поставщик А` });
    expect(await listed({ supplierKeys: [b] })).toEqual([ids.paid]);
    expect(await listed({ supplierKeys: ['none'] })).toEqual([ids.partial]);
    const partialRow = (await list({ supplierKeys: ['none'] }))[0];
    expect(partialRow.lines.map((line) => line.supplierKey)).toEqual(['none', 'none']);
    expect(await listed({ supplierKeys: [b, 'none'] })).toEqual([ids.paid, ids.partial].sort((x, y) => x - y));
    // Paging counts the filtered orders, not the page.
    const page = await repository.list({ currentUser: admin, query: { page: 1, pageSize: 1, search: tag, supplierKeys: [a] } }, options);
    expect(page.pagination.total).toBe(2);
  });

  it('sorts all pages on the server; empty keys last; the supplier filter sorts by the kept materials', async () => {
    const ordered = async (over: Partial<OrderResourceDemandQuery>) => (await list(over)).map((row) => row.orderId);
    expect(await ordered({ sort: { key: 'order', direction: 'asc' } })).toEqual([ids.paid, ids.partial, ids.unpaid]);
    expect(await ordered({ sort: { key: 'order', direction: 'desc' } })).toEqual([ids.unpaid, ids.partial, ids.paid]);
    // Equal dates keep the default order (newest id first).
    expect(await ordered({ sort: { key: 'date', direction: 'asc' } })).toEqual([ids.paid, ids.unpaid, ids.partial]);
    expect(await ordered({ sort: { key: 'date', direction: 'desc' } })).toEqual([ids.unpaid, ids.partial, ids.paid]);
    // The order without film is last in both directions; the two with films swap.
    const filmsAsc = await ordered({ sort: { key: 'films', direction: 'asc' } });
    const filmsDesc = await ordered({ sort: { key: 'films', direction: 'desc' } });
    expect(filmsAsc[2]).toBe(ids.unpaid);
    expect(filmsDesc[2]).toBe(ids.unpaid);
    expect(filmsDesc.slice(0, 2)).toEqual(filmsAsc.slice(0, 2).reverse());
    // Supplier A keeps no film of the paid order (its film is supplier B's): both rows have no film key → default order.
    expect(await ordered({ supplierKeys: [`s:${ids.supplierA}`], sort: { key: 'films', direction: 'asc' } })).toEqual([ids.unpaid, ids.paid]);
    // The legacy supplierId filter keeps whole details (sheet of supplier A with film B): the paid film stays in the key.
    expect(await ordered({ supplierId: ids.supplierA, sort: { key: 'films', direction: 'asc' } })).toEqual([ids.paid, ids.unpaid]);
    await q('SAVEPOINT sort_hdf');
    try {
      // HDF positions (current revision): one repeats the detail's sheet with another snapshot name (the detail name wins),
      // one adds an HDF-only sheet (its snapshot name counts).
      const revision = Number((await q('SELECT revision FROM hdf_calculation_config_state WHERE id = 1')).rows[0].revision);
      const hdf = (orderId: number, sheet: number, name: string) => q(
        `INSERT INTO order_hdf_details (order_id, source_order_detail_id_snapshot, status, source_snapshot_hash, source_snapshot_json,
            config_revision, hdf_sheet_material_type_id, hdf_sheet_material_name, edge_mm, threshold_mm, hdf_height_mm, hdf_width_mm, quantity)
         VALUES ($1, 0, 'ok', 'e2e', '{}'::jsonb, $2, $3, $4, 10, 10, 700, 380, 1)`,
        [orderId, revision, sheet, name],
      );
      await hdf(ids.unpaid, ids.sheet, 'ААА ' + tag);
      await hdf(ids.partial, ids.bathSheet, 'Яя ' + tag);
      // Paid and unpaid show the same sheet (the unpaid HDF snapshot name does not replace the detail's): equal keys → date desc.
      const unpaidRow = (await list({ orderIds: [ids.unpaid] }))[0];
      expect(unpaidRow.sheetMaterials.map((row) => row.name)).not.toContain('ААА ' + tag);
      for (const direction of ['asc', 'desc'] as const) {
        const sheets = await ordered({ sort: { key: 'sheetMaterials', direction } });
        expect(sheets.indexOf(ids.paid) - sheets.indexOf(ids.unpaid)).toBe(1);
      }
      const partialRow = (await list({ orderIds: [ids.partial] }))[0];
      expect(partialRow.sheetMaterials.map((row) => row.name)).toContain('Яя ' + tag);
    } finally {
      await q('ROLLBACK TO SAVEPOINT sort_hdf');
    }
    // The sort applies before paging.
    const second = await repository.list(
      { currentUser: admin, query: { page: 2, pageSize: 1, search: tag, sort: { key: 'order', direction: 'asc' } } }, options,
    );
    expect(second.data.map((row) => row.orderId)).toEqual([ids.partial]);
  });

  it('header filters: orders, dates, sheet materials, films (and «without»)', async () => {
    expect(await listed({ orderIds: [ids.partial] })).toEqual([ids.partial]);
    expect(await listed({ orderDates: { values: ['2026-01-12'], includeEmpty: false } })).toEqual([ids.partial, ids.unpaid].sort((a, b) => a - b));
    expect(await listed({ orderDates: { values: [], includeEmpty: true } })).toEqual([]);
    expect(await listed({ sheetMaterialTypeIds: { values: [ids.sheet], includeEmpty: false } })).toEqual([ids.paid, ids.unpaid].sort((a, b) => a - b));
    // Every detail has a sheet material (NOT NULL), so «without sheet materials» selects nothing here.
    expect(await listed({ sheetMaterialTypeIds: { values: [], includeEmpty: true } })).toEqual([]);
    expect(await listed({ sheetMaterialTypeIds: { values: [ids.sheetNone], includeEmpty: true } })).toEqual([ids.partial]);
    expect(await listed({ filmIds: { values: [ids.filmNone], includeEmpty: true } })).toEqual([ids.partial, ids.unpaid].sort((a, b) => a - b));
    // Header filters do not narrow the lines: the order keeps all its materials.
    const paidRow = (await list({ filmIds: { values: [ids.filmB], includeEmpty: false } }))[0];
    expect(paidRow.lines.map((line) => line.kind).sort()).toEqual(['film', 'sheet_material']);
  });

  it('«all except» works like the complementary selection, including the supplier narrowing', async () => {
    expect(await listed({ filmIds: { values: [ids.filmB], includeEmpty: true, exclude: true } }))
      .toEqual([ids.partial, ids.unpaid].sort((a, b) => a - b));
    expect(await listed({ filmIds: { values: [], includeEmpty: false, exclude: true } }))
      .toEqual([ids.paid, ids.partial].sort((a, b) => a - b));
    expect(await listed({ orderDates: { values: ['2026-01-11'], includeEmpty: false, exclude: true } }))
      .toEqual([ids.partial, ids.unpaid].sort((a, b) => a - b));
    expect(await listed({ sheetMaterialTypeIds: { values: [ids.sheet], includeEmpty: false, exclude: true } })).toEqual([ids.partial]);
    const exceptA = await list({ supplierKeys: [`s:${ids.supplierA}`], supplierKeysExclude: true });
    expect(exceptA.map((row) => row.orderId).sort((a, b) => a - b)).toEqual([ids.paid, ids.partial].sort((a, b) => a - b));
    expect(exceptA.find((row) => row.orderId === ids.paid)!.lines.map((line) => line.resourceKey)).toEqual([`film:${ids.filmB}`]);
  });

  it('ready cuts on the server match the film meters of the projection', async () => {
    const all = await list({});
    const withMeters = all.filter((row) => row.films.some((film) => film.hasCutData)).map((row) => row.orderId);
    expect(withMeters).toEqual([ids.paid]);
    expect(await listed({ readyCutsOnly: true })).toEqual(withMeters);
    // An active manual layout replaces the automatic sheets; a stale one is ignored.
    const group = (await q<{ cut_job_id: string; group_key: string }>(
      `SELECT cg.cut_job_id, cg.group_key FROM cut_group cg JOIN cut_job_item cji ON cji.cut_job_id = cg.cut_job_id WHERE cji.order_detail_id = $1`,
      [ids.paidSheetDetail],
    )).rows[0];
    const manualWithoutDetail = (stale: boolean) => q(
      `INSERT INTO cut_group_manual_layout (cut_job_id, group_key, sheets, is_active, is_stale, based_on_job_version)
       VALUES ($1, $2, '[{"sheetIndex":0,"placements":{"sheet_width_mm":1100,"sheet_height_mm":2800,"pieces":[{"item_id":"det-0","x_mm":0,"y_mm":0,"width_mm":10,"height_mm":10}]}}]'::jsonb, true, $3, 1)`,
      [group.cut_job_id, group.group_key, stale],
    );
    const withMetersNow = async () => (await list({})).filter((row) => row.films.some((film) => film.hasCutData)).map((row) => row.orderId);
    // A bath sheet whose pieces occupy no length (zero geometry) gives no meters — on the server either.
    await q('SAVEPOINT zero');
    try {
      await q(
        `UPDATE cut_group_sheet SET placements = jsonb_set(placements, '{pieces}',
           jsonb_build_array(jsonb_build_object('item_id', $2::text, 'x_mm', 0, 'y_mm', 0, 'width_mm', 0, 'height_mm', 0)))
          WHERE cut_group_id IN (SELECT cg.cut_group_id FROM cut_group cg WHERE cg.cut_job_id = $1)`,
        [group.cut_job_id, `det-${ids.paidSheetDetail}`],
      );
      expect(await withMetersNow()).toEqual([]);
      expect(await listed({ readyCutsOnly: true })).toEqual([]);
    } finally {
      await q('ROLLBACK TO SAVEPOINT zero');
    }
    for (const stale of [false, true]) {
      await q('SAVEPOINT manual');
      try {
        await manualWithoutDetail(stale);
        const expected = stale ? [ids.paid] : [];
        expect(await withMetersNow()).toEqual(expected);
        expect(await listed({ readyCutsOnly: true })).toEqual(expected);
      } finally {
        await q('ROLLBACK TO SAVEPOINT manual');
      }
    }
  });

  it('by-material honours the same filters and the supplier narrowing', async () => {
    const result = await repository.listByMaterial(
      { currentUser: admin, query: { page: 1, pageSize: 20, search: tag, supplierKeys: [`s:${ids.supplierA}`] } }, options,
    );
    expect(result.ordersCount).toBe(2);
    expect(result.data.map((row) => row.resourceKey)).toEqual([`sheet_material:${ids.sheet}`]);
  });

  it('filter options cover the whole selection and ignore the header filters', async () => {
    const result = await repository.listFilterOptions(
      { currentUser: admin, query: { page: 1, pageSize: 1, search: tag, supplierKeys: [`s:${ids.supplierA}`], orderIds: [ids.paid] } }, options,
    );
    expect(result.orders.map((row) => row.orderId).sort((a, b) => a - b)).toEqual([ids.paid, ids.partial, ids.unpaid].sort((a, b) => a - b));
    expect(result.dates).toEqual(['2026-01-12', '2026-01-11']);
    expect(result.hasEmptyDate).toBe(false);
    expect(result.sheetMaterials.map((row) => row.id).sort((a, b) => a - b)).toEqual([ids.sheet, ids.sheetNone].sort((a, b) => a - b));
    expect(result.hasNoSheetMaterials).toBe(false);
    expect(result.films.map((row) => row.id).sort((a, b) => a - b)).toEqual([ids.filmB, ids.filmNone].sort((a, b) => a - b));
    expect(result.hasNoFilms).toBe(true);
    expect(result.suppliers).toEqual([
      { key: `s:${ids.supplierA}`, name: `${tag} Поставщик А` },
      { key: `s:${ids.supplierB}`, name: `${tag} Поставщик Б` },
      { key: 'none', name: 'Без поставщика' },
    ]);
    const paidOnly = await repository.listFilterOptions(
      { currentUser: admin, query: { page: 1, pageSize: 1, search: tag, payment: 'fully_paid' } }, options,
    );
    expect(paidOnly.orders.map((row) => row.orderId)).toEqual([ids.paid]);
  });
});
