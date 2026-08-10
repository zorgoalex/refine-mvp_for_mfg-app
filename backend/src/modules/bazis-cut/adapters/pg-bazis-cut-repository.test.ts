import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditService } from '../../../common/audit/audit.service';
import type { TransactionClient } from '../../../database/database.types';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { PgBazisCutRepository, resolveBazisDetailLabels } from './pg-bazis-cut-repository';

const user: CurrentUser = {
  id: '7', username: 'manager', role: 'manager', roleId: 3,
  permissions: ['cut.view', 'cut.manage', 'orders.view'],
};

afterEach(() => vi.restoreAllMocks());

describe('PgBazisCutRepository security and event contract', () => {
  it('lists saved sets with total finished detail area', async () => {
    let sqlText = '';
    const database = {
      query: vi.fn(async (sql: string) => {
        sqlText = sql;
        return result([{
          ...setRow(0),
          quantity: 5,
          position_count: 2,
          total_area_m2: '1.25',
          orders: [],
          projects: [],
          bazis_projects: [],
          bazis_orders: [],
          total_count: 1,
        }]);
      }),
    } as unknown as DatabaseService;
    const repository = new PgBazisCutRepository(database);

    await expect(repository.list({ currentUser: user, requestId: 'list-1', search: '', page: 1, pageSize: 25 }))
      .resolves.toMatchObject({ items: [{ quantity: 5, positionCount: 2, totalAreaM2: 1.25 }] });
    expect(sqlText).toContain('finished_length_mm * d.finished_width_mm * d.quantity / 1000000.0');
  });

  it('maps the ERP detail Basis project and product to separate frozen labels', () => {
    expect(resolveBazisDetailLabels(' 1319 ', ' Кухня ')).toEqual({
      sourceBazisProjectName: '1319',
      sourceBazisOrderNo: '1319',
      sourceBazisProductName: 'Кухня',
    });
    expect(resolveBazisDetailLabels(null, '')).toEqual({
      sourceBazisProjectName: '',
      sourceBazisOrderNo: '',
      sourceBazisProductName: '',
    });
  });

  it('records an order-scope denial outside the command transaction before idempotency', async () => {
    const tx = { query: vi.fn(async (sql: string) => sql.includes('FROM orders')
      ? result([])
      : result([])) } as unknown as TransactionClient;
    const database = fakeDatabase(tx);
    const denied = vi.spyOn(auditService, 'recordDenied').mockResolvedValue('denied-1');
    const repository = new PgBazisCutRepository(database);

    await expect(repository.create({ currentUser: user, requestId: 'scope-1', idempotencyKey: 'scope-key-123',
      name: 'Denied', orderId: 404, detailIds: [1] }))
      .rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' });

    expect(denied).toHaveBeenCalledWith(database, expect.objectContaining({
      event: 'bazis_cut_set.order_scope_denied', relatedOrderId: 404, reason: 'ORDER_SCOPE_DENIED',
    }));
    expect(tx.query).not.toHaveBeenCalledWith(expect.stringContaining('command_idempotency_keys'), expect.anything());
  });

  it('allocates the smallest freed set number on create under a transaction lock', async () => {
    const tx = { query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('INSERT INTO command_idempotency_keys')) return result([{ idempotency_key: 'create-reuse-key-123' }], 1);
      if (sql.includes('LOCK TABLE bazis_cut_sets')) return result([], 1);
      if (sql.includes('WITH next_id AS')) return result([{ bazis_cut_set_id: 3 }], 1);
      if (sql.includes('SELECT setval(')) return result([{ setval: '3' }]);
      if (sql.includes('FROM order_details')) return result([sourceRow()]);
      if (sql.includes('INSERT INTO bazis_cut_set_details')) return result([], 1);
      if (sql.includes('SELECT * FROM bazis_cut_sets WHERE')) return result([setRow(0, 3)]);
      if (sql.includes('SELECT d.*, COALESCE(source_order.delete_flag, false)')) return result([detailRow({ bazis_cut_set_id: 3 })]);
      if (sql.includes('INSERT INTO outbox_events')) return result([], 1);
      return result([], 1);
    }) } as unknown as TransactionClient;
    const database = {
      query: vi.fn(async (sql: string) => sql.includes('FROM orders')
        ? result([{ order_id: 1491, created_by: 7, manager_id: null }])
        : result([])),
      transaction: vi.fn(async (handler: (client: TransactionClient) => Promise<unknown>) => handler(tx)),
    } as unknown as DatabaseService;
    const audit = vi.spyOn(auditService, 'record').mockResolvedValue('audit-created');
    const repository = new PgBazisCutRepository(database);

    const response = await repository.create({ currentUser: user, requestId: 'create-reuse-1',
      idempotencyKey: 'create-reuse-key-123', name: 'Новый после удаления', orderId: 1491, detailIds: [40] });

    expect(response.set.bazisCutSetId).toBe(3);
    expect(audit).toHaveBeenCalledWith(tx, expect.objectContaining({
      event: 'bazis_cut_set.created', entityType: 'bazis_cut_set', entityId: 3,
    }));
    const calls = (tx.query as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => String(sql));
    const lockIndex = calls.findIndex((sql) => sql.includes('LOCK TABLE bazis_cut_sets'));
    const insertIndex = calls.findIndex((sql) => sql.includes('WITH next_id AS'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(lockIndex).toBeLessThan(insertIndex);
    expect(calls[insertIndex]).toContain('generate_series');
    expect(calls[insertIndex]).toContain('NOT EXISTS');
    expect(calls[insertIndex]).toContain('INSERT INTO bazis_cut_sets (bazis_cut_set_id, name, created_by, updated_by)');
    expect(calls.some((sql) => sql.includes("pg_get_serial_sequence('bazis_cut_sets','bazis_cut_set_id')"))).toBe(true);
  });

  it('emits canonical detail_removed audit bridges and outbox payload before completing idempotency', async () => {
    let outboxPayload: Record<string, unknown> | undefined;
    const tx = { query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('INSERT INTO command_idempotency_keys')) return result([{ idempotency_key: 'remove-key-123' }], 1);
      if (sql.includes('FROM bazis_cut_sets') && sql.includes('FOR UPDATE')) return result([setRow(2)]);
      if (sql.includes('FROM bazis_cut_set_details') && sql.includes('FOR UPDATE')) return result([detailRow()]);
      if (sql.includes('SELECT * FROM bazis_cut_sets WHERE')) return result([setRow(3)]);
      if (sql.includes('SELECT * FROM bazis_cut_set_details') && sql.includes('ORDER BY')) return result([]);
      if (sql.includes('INSERT INTO outbox_events')) {
        outboxPayload = JSON.parse(String(params?.[2])) as Record<string, unknown>;
        return result([], 1);
      }
      return result([], 1);
    }) } as unknown as TransactionClient;
    const database = fakeDatabase(tx);
    const audit = vi.spyOn(auditService, 'record').mockResolvedValue('audit-removed');
    const repository = new PgBazisCutRepository(database);

    const response = await repository.deleteDetail({ currentUser: user, requestId: 'remove-1',
      idempotencyKey: 'remove-key-123', setId: 10, detailId: 20, expectedVersion: 2 });

    expect(response.set.version).toBe(3);
    expect(audit).toHaveBeenCalledWith(tx, expect.objectContaining({
      event: 'bazis_cut_set.detail_removed', entityType: 'bazis_cut_set', entityId: 10,
      relatedEntities: expect.arrayContaining([
        { entityType: 'bazis_cut_set', entityId: 10 }, { entityType: 'order', entityId: 30 },
        { entityType: 'order_detail', entityId: 40 }, { entityType: 'project', entityId: 50 },
        { entityType: 'bazis_project', entityId: 60 }, { entityType: 'bazis_revision', entityId: 70 },
      ]),
    }));
    expect(outboxPayload).toMatchObject({
      actorUserId: 7, requestId: 'remove-1', entityType: 'bazis_cut_set', entityId: 10, setVersion: 3,
      related: { orderIds: [30], orderDetailIds: [40], projectIds: [50], bazisProjectIds: [60], bazisRevisionIds: [70] },
    });
    const calls = (tx.query as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => String(sql));
    expect(calls.findIndex((sql) => sql.includes('INSERT INTO outbox_events')))
      .toBeLessThan(calls.findIndex((sql) => sql.includes("status='completed'")));
  });

  it('deletes only empty sets with audit/outbox before completing idempotency', async () => {
    let outboxPayload: Record<string, unknown> | undefined;
    const tx = { query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('INSERT INTO command_idempotency_keys')) return result([{ idempotency_key: 'delete-set-key-123' }], 1);
      if (sql.includes('FROM bazis_cut_sets') && sql.includes('FOR UPDATE')) return result([setRow(4)]);
      if (sql.includes('COUNT(*)::text AS count')) return result([{ count: '0' }]);
      if (sql.includes('SELECT * FROM bazis_cut_sets WHERE')) return result([setRow(4)]);
      if (sql.includes('SELECT d.*, COALESCE(source_order.delete_flag, false)')) return result([]);
      if (sql.includes('INSERT INTO outbox_events')) {
        outboxPayload = JSON.parse(String(params?.[2])) as Record<string, unknown>;
        return result([], 1);
      }
      return result([], 1);
    }) } as unknown as TransactionClient;
    const database = fakeDatabase(tx);
    const audit = vi.spyOn(auditService, 'record').mockResolvedValue('audit-delete-set');
    const repository = new PgBazisCutRepository(database);

    const response = await repository.deleteEmptySet({ currentUser: user, requestId: 'delete-set-1',
      idempotencyKey: 'delete-set-key-123', setId: 10, expectedVersion: 4 });

    expect(response).toMatchObject({ deleted: true, set: { bazisCutSetId: 10, name: 'Набор', positionCount: 0 } });
    expect(audit).toHaveBeenCalledWith(tx, expect.objectContaining({
      event: 'bazis_cut_set.deleted', entityType: 'bazis_cut_set', entityId: 10,
      before: expect.objectContaining({ setId: 10, positionCount: 0 }),
      after: null,
      relatedEntities: [{ entityType: 'bazis_cut_set', entityId: 10 }],
    }));
    expect(outboxPayload).toMatchObject({
      actorUserId: 7, requestId: 'delete-set-1', entityType: 'bazis_cut_set', entityId: 10, setVersion: 4,
      related: { orderIds: [], orderDetailIds: [], projectIds: [], bazisProjectIds: [], bazisRevisionIds: [] },
    });
    const calls = (tx.query as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => String(sql));
    expect(calls.some((sql) => sql.includes('DELETE FROM bazis_cut_sets'))).toBe(true);
    expect(calls.findIndex((sql) => sql.includes('INSERT INTO outbox_events')))
      .toBeLessThan(calls.findIndex((sql) => sql.includes("status='completed'")));
  });

  it('rejects non-empty set deletion without audit, outbox or hard delete', async () => {
    const tx = { query: vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO command_idempotency_keys')) return result([{ idempotency_key: 'delete-set-key-456' }], 1);
      if (sql.includes('FROM bazis_cut_sets') && sql.includes('FOR UPDATE')) return result([setRow(4)]);
      if (sql.includes('COUNT(*)::text AS count')) return result([{ count: '2' }]);
      return result([], 1);
    }) } as unknown as TransactionClient;
    const database = fakeDatabase(tx);
    const audit = vi.spyOn(auditService, 'record').mockResolvedValue('unexpected');
    const repository = new PgBazisCutRepository(database);

    await expect(repository.deleteEmptySet({ currentUser: user, requestId: 'delete-set-2',
      idempotencyKey: 'delete-set-key-456', setId: 10, expectedVersion: 4 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'BAZIS_CUT_SET_NOT_EMPTY' });

    expect(audit).not.toHaveBeenCalled();
    const calls = (tx.query as ReturnType<typeof vi.fn>).mock.calls.map(([sql]) => String(sql));
    expect(calls.some((sql) => sql.includes('INSERT INTO outbox_events'))).toBe(false);
    expect(calls.some((sql) => sql.includes('DELETE FROM bazis_cut_sets'))).toBe(false);
  });
});

function fakeDatabase(tx: TransactionClient): DatabaseService {
  const database = {
    query: vi.fn(async () => result([])),
    transaction: vi.fn(async (handler: (client: TransactionClient) => Promise<unknown>) => handler(tx)),
  };
  return database as unknown as DatabaseService;
}

function result<T extends object>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount, command: '', oid: 0, fields: [] };
}

function setRow(version: number, setId = 10) {
  return { bazis_cut_set_id: setId, name: 'Набор', version, created_by: 7, updated_by: 7,
    created_at: new Date('2026-07-15T10:00:00Z'), updated_at: new Date('2026-07-15T10:00:00Z') };
}

function sourceRow() {
  return {
    detail_id: 40, order_id: 1491, project_id: 50, order_name: '1491',
    order_full_number: 'P-1491', project_code: 'P',
    material_name: 'ЛДСП', thickness_mm: '16', detail_number: 1,
    basis_designation: '001', basis_data: null, detail_bazis_project: 'BP',
    detail_bazis_product: 'Кухня', detail_name: 'Бок', height: '100', width: '50',
    quantity: 2, note: '', milling: '', film: '', doweling: false,
    exact_count: 0, exact_node_id: null, exact_revision_id: null, exact_bazis_project_id: null,
    exact_bazis_project_name: null, exact_bazis_order_no: null, exact_vertical: null,
    fallback_revision_id: null, fallback_bazis_project_id: null, fallback_bazis_project_name: null,
    fallback_bazis_order_no: null,
  };
}

function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    bazis_cut_set_detail_id: 20, bazis_cut_set_id: 10, sort_order: 0,
    source_order_detail_id: 40, source_order_id: 30, source_project_id: 50,
    source_bazis_project_id: 60, source_bazis_revision_id: 70, source_bazis_node_id: 80,
    source_order_name: '1', source_order_full_number: 'P-1', source_project_code: 'P',
    source_bazis_project_name: 'BP', source_bazis_order_no: 'BO',
    source_bazis_product_name: 'Кухня', cut_enabled: true,
    material_type: 'Площадной', material_name: 'ЛДСП', material_article: '', thickness_mm: '16',
    position: '001', part_name: 'Бок', finished_length_mm: '100', finished_width_mm: '50',
    cut_length_mm: '100', cut_width_mm: '50', quantity: 2, orientation: 'Не задана', groove: '',
    l1_name: '', l1_designation: '', l1_thickness_mm: 0, l2_name: '', l2_designation: '', l2_thickness_mm: 0,
    w1_name: '', w1_designation: '', w1_thickness_mm: 0, w2_name: '', w2_designation: '', w2_thickness_mm: 0,
    priority: null, comment: '', custom_property: '', glue: '', milling: '', route: '', film: '',
    created_at: new Date('2026-07-15T10:00:00Z'), updated_at: new Date('2026-07-15T10:00:00Z'),
    ...overrides,
  };
}
