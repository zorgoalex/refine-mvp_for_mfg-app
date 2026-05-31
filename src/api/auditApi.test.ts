import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditApi } from './auditApi';
import type { AuditLogEventDto } from './types/auditApi.types';

describe('auditApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('calls GET /api/v1/audit without params when called with empty query', async () => {
    const fetchMock = mockFetch(createListResponse([]));

    await auditApi.list();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/audit',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('builds correct query string with all supported params', async () => {
    const fetchMock = mockFetch(createListResponse([]));

    await auditApi.list({
      page: 2,
      pageSize: 50,
      event: 'ORDER_CREATED',
      entityType: 'order',
      entityId: '42',
      userId: 7,
      source: 'backend',
      relatedOrderId: 10,
      relatedClientId: 3,
      relatedPaymentId: 5,
      relatedProductionEventId: 8,
      requestId: 'req-abc',
      createdFrom: '2026-01-01T00:00:00.000Z',
      createdTo: '2026-01-31T23:59:59.999Z',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/audit?page=2&pageSize=50&event=ORDER_CREATED&entityType=order&entityId=42&userId=7&source=backend&relatedOrderId=10&relatedClientId=3&relatedPaymentId=5&relatedProductionEventId=8&requestId=req-abc&createdFrom=2026-01-01T00%3A00%3A00.000Z&createdTo=2026-01-31T23%3A59%3A59.999Z',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('skips null and undefined and empty string query params', async () => {
    const fetchMock = mockFetch(createListResponse([]));

    await auditApi.list({
      page: 1,
      event: '',
      entityType: undefined,
      userId: undefined,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/audit?page=1',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('maps the response data and pagination correctly', async () => {
    const event = createAuditEvent();
    const fetchMock = mockFetch(
      createListResponse([event], { page: 3, pageSize: 50, total: 120, totalPages: 3 }),
    );

    const result = await auditApi.list({ page: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toEqual(event);
    expect(result.pagination).toEqual({ page: 3, pageSize: 50, total: 120, totalPages: 3 });
    expect(typeof result.requestId).toBe('string');
  });

  it('passes relatedDeadlineId as a numeric query param', async () => {
    const fetchMock = mockFetch(createListResponse([]));

    await auditApi.list({ relatedDeadlineId: 42 });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/audit?relatedDeadlineId=42',
      expect.objectContaining({ method: 'GET' }),
    );
  });
});

// Helpers

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

function createListResponse(
  data: AuditLogEventDto[],
  pagination = { page: 1, pageSize: 50, total: 0, totalPages: 0 },
  requestId = 'req-test-1',
) {
  return { data, pagination, requestId };
}

function createAuditEvent(): AuditLogEventDto {
  return {
    auditId: 'audit-uuid-1',
    event: 'ORDER_CREATED',
    entityType: 'order',
    entityId: '42',
    userId: 7,
    username: 'testuser',
    role: 'manager',
    source: 'backend',
    relatedOrderId: 42,
    relatedClientId: 3,
    relatedPaymentId: null,
    relatedDeadlineId: null,
    relatedProductionEventId: null,
    statusField: null,
    statusId: null,
    statusName: null,
    statusCode: null,
    stageCode: null,
    requestId: 'req-abc-1',
    ip: '127.0.0.1',
    userAgent: 'Test/1.0',
    before: null,
    after: { orderId: 42, orderName: 'Test Order' },
    diff: null,
    metadata: null,
    createdAt: '2026-01-15T10:30:00.000Z',
  };
}
