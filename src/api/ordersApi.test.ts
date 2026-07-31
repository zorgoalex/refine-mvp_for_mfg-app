import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ordersApi, validateOrderId, withQuery } from './ordersApi';
import type { OrderDto, SaveOrderDto } from './types/orderApi.types';

describe('ordersApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists orders with whitelisted query shape', async () => {
    const fetchMock = mockFetch({
      data: [],
      pagination: { page: 2, pageSize: 20, total: 0, totalPages: 0 },
    });

    await ordersApi.list({
      page: 2,
      pageSize: 20,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
      search: 'Order A',
      clientId: 12,
      onlyMyOrders: true,
      productionStatusId: undefined,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/orders?page=2&pageSize=20&sortBy=updatedAt&sortOrder=desc&search=Order+A&clientId=12&onlyMyOrders=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('gets an order by id and unwraps OrderResponse', async () => {
    const order = createOrderDto();
    const fetchMock = mockFetch({ order });

    await expect(ordersApi.getById(15)).resolves.toEqual(order);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/orders/15',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('loads order form reference data', async () => {
    const response = {
      clients: [{ id: 1, name: 'Client' }],
      materials: [{ id: 2, name: 'MDF', unitId: 1 }],
      millingTypes: [{ id: 3, name: 'Modern', costPerSqm: 120 }],
      edgeTypes: [{ id: 4, name: 'PVC' }],
      films: [{ id: 5, name: 'White' }],
      orderStatuses: [{ id: 6, name: 'New', color: '#ffffff' }],
      paymentStatuses: [{ id: 7, name: 'Unpaid', code: 'unpaid', color: '#ff0000' }],
      paymentTypes: [{ id: 8, name: 'Cash' }],
      productionStatuses: [{ id: 9, name: 'Cut', code: 'cut', color: '#00ff00' }],
      workshops: [{ id: 10, name: 'Workshop' }],
      employees: [{ id: 11, fullName: 'Employee' }],
      units: [{ id: 12, code: 'pcs', name: 'Pieces', symbol: 'pcs' }],
    };
    const fetchMock = mockFetch(response);

    await expect(ordersApi.getFormData()).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/orders/form-data',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('loads the live resource demand projection with report filters', async () => {
    const response = {
      data: [],
      pagination: { page: 2, pageSize: 50, total: 0, totalPages: 1 },
      refreshedAt: '2026-07-31T10:00:00.000Z',
    };
    const fetchMock = mockFetch(response);

    await expect(ordersApi.listResourceDemands({
      page: 2,
      pageSize: 50,
      dateFrom: '2026-07-01',
      supplierId: 7,
    })).resolves.toEqual(response);

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/orders/resource-demands?page=2&pageSize=50&dateFrom=2026-07-01&supplierId=7',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('creates an order with one POST /api/v1/orders request', async () => {
    const dto = createSaveOrderDto();
    const order = createOrderDto();
    const fetchMock = mockFetch({ order });

    await expect(ordersApi.create(dto)).resolves.toEqual({ order });

    const [, init] = fetchMock.mock.calls[0];
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify(dto));
  });

  it('updates an order with PUT /api/v1/orders/:id', async () => {
    const dto = createSaveOrderDto();
    const order = createOrderDto();
    const fetchMock = mockFetch({ order });

    await expect(ordersApi.update(15, dto)).resolves.toEqual({ order });

    const [, init] = fetchMock.mock.calls[0];
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/15');
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe(JSON.stringify(dto));
  });

  it('changes status and deletes by order id', async () => {
    const fetchMock = mockFetch(
      { order: createOrderDto() },
      {
        success: true,
        orderId: 15,
        auditId: 'audit-delete-1',
        requestId: 'request-delete-1',
      },
    );

    await ordersApi.changeStatus(15, { orderStatusId: 3, version: 4 });
    await expect(
      ordersApi.delete(15, { version: 4, idempotencyKey: 'order-delete-key-1' }),
    ).resolves.toEqual({
      success: true,
      orderId: 15,
      auditId: 'audit-delete-1',
      requestId: 'request-delete-1',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/15/status');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ orderStatusId: 3, version: 4 }),
    );
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/15');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE');
    const deleteHeaders = fetchMock.mock.calls[1][1]?.headers as Headers;
    expect(deleteHeaders.get('If-Match')).toBe('"4"');
    expect(deleteHeaders.get('Idempotency-Key')).toBe('order-delete-key-1');
  });

  it('restores an order with If-Match, Idempotency-Key and orderName body', async () => {
    const order = createOrderDto();
    const fetchMock = mockFetch({ order, auditId: 'audit-restore-1', requestId: 'request-restore-1' });

    await ordersApi.restore(15, {
      version: 4,
      orderName: '2561',
      idempotencyKey: 'order-restore-key-1',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/15/restore');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('If-Match')).toBe('"4"');
    expect(headers.get('Idempotency-Key')).toBe('order-restore-key-1');
    expect(fetchMock.mock.calls[0][1]?.body).toBe(JSON.stringify({ orderName: '2561' }));
  });

  it('restore generates a fresh order-restore key and empty body without orderName', async () => {
    const fetchMock = mockFetch({ order: createOrderDto(), requestId: 'request-restore-2' });

    await ordersApi.restore(15, { version: 4 });

    const headers = fetchMock.mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Idempotency-Key')).toMatch(/^order-restore:/);
    expect(fetchMock.mock.calls[0][1]?.body).toBe('{}');
  });

  it('restore validates version before fetch', () => {
    const fetchMock = mockFetch({});
    expect(() => ordersApi.restore(15, { version: -1 })).toThrow('Invalid order version');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('getById appends includeDeleted=true only when requested', async () => {
    const fetchMock = mockFetch({ order: createOrderDto() }, { order: createOrderDto() });

    await ordersApi.getById(15);
    await ordersApi.getById(15, { includeDeleted: true });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/15');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/15?includeDeleted=true');
  });

  it('list passes deleted=true and sortBy=deletedAt through the query string', async () => {
    const fetchMock = mockFetch({
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    });

    await ordersApi.list({ deleted: true, sortBy: 'deletedAt', sortOrder: 'desc' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/orders?deleted=true&sortBy=deletedAt&sortOrder=desc',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('rejects invalid order ids before fetch', async () => {
    const fetchMock = mockFetch({ order: createOrderDto() });

    expect(() => validateOrderId(0)).toThrow('Invalid orderId');
    await expect(ordersApi.getById(1.5)).rejects.toThrow('Invalid orderId');
    expect(() => ordersApi.delete(1, { version: -1, idempotencyKey: 'order-delete-key-1' })).toThrow(
      'Invalid order version',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('withQuery skips empty params', () => {
    expect(withQuery('/api/v1/orders', { page: 1, search: '', clientId: null })).toBe(
      '/api/v1/orders?page=1',
    );
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function createSaveOrderDto(): SaveOrderDto {
  return {
    version: 4,
    header: {
      orderName: 'Order A',
      clientId: 12,
      orderDate: '2026-04-30',
      priority: 100,
      orderStatusId: 3,
      discount: 0,
      surcharge: 0,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {
      detailIds: [],
      paymentIds: [],
      workshopIds: [],
      requirementIds: [],
      dowelingLinkIds: [],
    },
  };
}

function createOrderDto(): OrderDto {
  return {
    header: {
      orderId: 15,
      orderName: 'Order A',
      clientId: 12,
      orderDate: '2026-04-30',
      orderStatusId: 3,
      paymentStatusId: 1,
      version: 4,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    totals: {
      totalAmount: 0,
      discount: 0,
      surcharge: 0,
      finalAmount: 0,
      paidAmount: 0,
      debtAmount: 0,
      partsCount: 0,
      totalArea: 0,
    },
    version: 4,
  };
}
