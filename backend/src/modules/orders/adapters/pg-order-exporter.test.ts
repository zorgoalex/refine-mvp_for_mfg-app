import { describe, expect, it } from 'vitest';
import type { QueryResult, QueryResultRow } from 'pg';
import type { TransactionClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import { PgOrderExporter } from './pg-order-exporter';

describe('PgOrderExporter', () => {
  it('builds export payload from DB, calls GAS, and writes success audit', async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const database = new FakeExportDatabase(
      [{ match: 'INSERT INTO audit_log', rows: [{ audit_id: 'aud-x' }] }],
      [
        { match: 'FROM orders o', rows: [headerRow()] },
        {
          match: 'FROM order_details od',
          rows: [
            detailRow({ detail_number: 1, material_name: 'MDF', film_name: 'Matte' }),
            detailRow({ detail_number: 2, material_name: 'MDF', film_name: 'Matte' }),
          ],
        },
        { match: 'FROM payments p', rows: [paymentRow()] },
        { match: 'FROM doweling_orders d', rows: [dowelingRow()] },
        { match: 'INSERT INTO audit_log', rows: [{ audit_id: 'aud-s' }] },
      ],
    );
    const exporter = new PgOrderExporter(database, {
      gasWebappUrl: 'https://script.google.com/macros/s/test/exec',
      gasApiKey: 'gas-secret',
      timeoutMs: 1000,
      fetchImpl: async (url, init) => {
        fetchCalls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return response({ success: true, fileName: 'exported.xlsx', folder: 'ERP', xlsxUrl: 'https://drive/file' });
      },
    });

    await expect(
      exporter.exportToGoogleDrive({
        currentUser: manager(),
        orderId: 42,
        requestId: 'req_export',
        request: { format: 'xlsx', fileName: 'custom.xlsx' },
      }),
    ).resolves.toEqual({
      success: true,
      fileName: 'exported.xlsx',
      folder: 'ERP',
      xlsxUrl: 'https://drive/file',
      externalId: null,
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://script.google.com/macros/s/test/exec');
    expect(fetchCalls[0].body).toMatchObject({
      apiKey: 'gas-secret',
      fileName: 'custom.xlsx',
      orderName: 'ORD-42',
      orderId: '42',
      clientName: 'Client A',
      clientPhone: '+77000000000',
      materialSummary: 'MDF',
      filmSummary: 'Matte',
      orderDate: '02.05.2026',
      orderYear: 2026,
      orderMonth: 5,
      orderStatusName: 'В работе',
      paymentStatusName: 'Оплачен',
      productionStatusName: 'Производство',
      prisadkaName: 'DWL-42',
      prisadkaDesignerName: 'Engineer A',
    });
    expect(fetchCalls[0].body.items).toEqual([
      expect.objectContaining({ detailNumber: 1, height: 100, width: 200, quantity: 2 }),
      expect.objectContaining({ detailNumber: 2, height: 100, width: 200, quantity: 2 }),
    ]);
    expect(fetchCalls[0].body.payments).toEqual([
      { paymentType: 'Наличные', paymentDate: '03.05.2026', amount: 5000 },
    ]);

    const successAudit = database.queries.find(
      (q) => q.text.includes('INSERT INTO audit_log') && JSON.stringify(q.params).includes('orders.export') && !JSON.stringify(q.params).includes('requested'),
    );
    expect(successAudit).toBeDefined();
    expect(successAudit!.text).toMatch(/related_order_id/i);
    // Param indices per AUDIT_INSERT: [0]=event [1]=entity_type [2]=entity_id [3]=user_id
    // [4]=username [5]=role_code [6]=request_id [7]=source [8]=related_order_id
    // [9]=related_client_id [13]=related_user_id ... [22]=metadata_json
    expect(successAudit!.params[0]).toBe('orders.export');
    expect(successAudit!.params[4]).toBe('manager');       // actorUsername
    expect(successAudit!.params[5]).toBe('manager');       // actorRole / role_code
    expect(successAudit!.params[6]).toBe('req_export');    // requestId
    expect(successAudit!.params[7]).toBe('backend-orders-command'); // source
    expect(successAudit!.params[8]).toBe(42);              // related_order_id
    expect(successAudit!.params[9]).toBe(7);               // related_client_id (from headerRow client_id=7)
    const metadata = JSON.parse(successAudit!.params[22] as string);
    expect(metadata).toMatchObject({ target: 'google-drive' });
  });

  it('rejects unknown orders before calling GAS', async () => {
    const database = new FakeExportDatabase([], [{ match: 'FROM orders o', rows: [] }]);
    let fetchCalled = false;
    const exporter = new PgOrderExporter(database, {
      gasWebappUrl: 'https://script.google.com/macros/s/test/exec',
      gasApiKey: 'gas-secret',
      timeoutMs: 1000,
      fetchImpl: async () => {
        fetchCalled = true;
        return response({ success: true });
      },
    });

    await expect(
      exporter.exportToGoogleDrive({
        currentUser: manager(),
        orderId: 404,
        request: { format: 'xlsx', fileName: null },
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'ORDER_NOT_FOUND' });
    expect(fetchCalled).toBe(false);
  });

  it('maps provider failures to stable ApiError codes', async () => {
    const database = new FakeExportDatabase(
      [],
      [
        { match: 'FROM orders o', rows: [headerRow()] },
        { match: 'FROM order_details od', rows: [] },
        { match: 'FROM payments p', rows: [] },
        { match: 'FROM doweling_orders d', rows: [] },
        { match: 'INSERT INTO audit_log', rows: [{ audit_id: 'aud-s' }] },
      ],
    );
    const exporter = new PgOrderExporter(database, {
      gasWebappUrl: 'https://script.google.com/macros/s/test/exec',
      gasApiKey: 'gas-secret',
      timeoutMs: 1000,
      fetchImpl: async () => response({ success: false, error: 'GAS failed' }),
    });

    await expect(
      exporter.exportToGoogleDrive({
        currentUser: manager(),
        orderId: 42,
        request: { format: 'xlsx', fileName: null },
      }),
    ).rejects.toMatchObject({ statusCode: 502, code: 'EXPORT_PROVIDER_ERROR' });
  });
});

interface ExpectedQuery {
  match: string;
  rows: QueryResultRow[];
}

class FakeExportDatabase {
  readonly queries: Array<{ text: string; params: readonly unknown[] }> = [];
  private queryQueue: ExpectedQuery[];
  private transactionQueue: ExpectedQuery[];

  constructor(queryResults: ExpectedQuery[] = [], transactionResults: ExpectedQuery[] = []) {
    this.queryQueue = [...queryResults];
    this.transactionQueue = [...transactionResults];
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, params });
    const expected = this.queryQueue.shift();
    if (!expected) {
      return toQueryResult([]) as QueryResult<T>;
    }
    expect(text).toContain(expected.match);
    return toQueryResult(expected.rows) as QueryResult<T>;
  }

  async transaction<T>(handler: (client: TransactionClient) => Promise<T>): Promise<T> {
    const tx = {
      raw: undefined,
      query: async <T extends QueryResultRow = QueryResultRow>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<QueryResult<T>> => {
        this.queries.push({ text, params });
        const expected = this.transactionQueue.shift();
        if (!expected) {
          return toQueryResult([]) as QueryResult<T>;
        }
        expect(text).toContain(expected.match);
        return toQueryResult(expected.rows) as QueryResult<T>;
      },
    } as unknown as TransactionClient;

    return handler(tx);
  }
}

function response(body: Record<string, unknown>, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

function toQueryResult(rows: QueryResultRow[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

function manager(): CurrentUser {
  return {
    id: '10',
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}

function headerRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    order_id: 42,
    order_name: 'ORD-42',
    order_date: '2026-05-02',
    client_id: 7,
    client_name: 'Client A',
    client_phone: '+77000000000',
    total_area: 1.5,
    planned_completion_date: '2026-05-10',
    order_status_name: 'В работе',
    payment_status_name: 'Оплачен',
    issue_date: '2026-05-11',
    production_status_name: 'Производство',
    manager_id: 10,
    created_by: 1,
    ...overrides,
  };
}

function detailRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    detail_number: 1,
    height: 100,
    width: 200,
    quantity: 2,
    milling_type_name: 'Модерн',
    edge_type_name: 'R2',
    note: 'note',
    milling_cost_per_sqm: 1500,
    film_name: 'Matte',
    material_name: 'MDF',
    ...overrides,
  };
}

function paymentRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    type_paid_name: 'Наличные',
    payment_date: '2026-05-03',
    amount: 5000,
    ...overrides,
  };
}

function dowelingRow(overrides: Partial<QueryResultRow> = {}): QueryResultRow {
  return {
    doweling_order_name: 'DWL-42',
    design_engineer_name: 'Engineer A',
    ...overrides,
  };
}
