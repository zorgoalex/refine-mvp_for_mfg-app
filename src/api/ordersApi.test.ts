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
    const fetchMock = mockFetch({ order: createOrderDto() }, { orderId: 15, deleted: true });

    await ordersApi.changeStatus(15, { orderStatusId: 3, version: 4 });
    await ordersApi.delete(15);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/15/status');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[0][1]?.body).toBe(
      JSON.stringify({ orderStatusId: 3, version: 4 }),
    );
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/15');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE');
  });

  it('rejects invalid order ids before fetch', async () => {
    const fetchMock = mockFetch({ order: createOrderDto() });

    expect(() => validateOrderId(0)).toThrow('Invalid orderId');
    await expect(ordersApi.getById(1.5)).rejects.toThrow('Invalid orderId');
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
