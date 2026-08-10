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

function setRow(version: number) {
  return { bazis_cut_set_id: 10, name: 'Набор', version, created_by: 7, updated_by: 7,
    created_at: new Date('2026-07-15T10:00:00Z'), updated_at: new Date('2026-07-15T10:00:00Z') };
}

function detailRow() {
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
  };
}
