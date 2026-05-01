import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deadlinesApi, validateDeadlineId } from './deadlinesApi';
import type { DeadlineDto } from './types/deadlineApi.types';

const deadlineId = '11111111-1111-4111-8111-111111111111';

describe('deadlinesApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('lists deadlines through versioned /api/v1/deadlines endpoint', async () => {
    const fetchMock = mockFetch({
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    });

    await deadlinesApi.list({
      page: 1,
      status: 'active',
      orderId: 42,
      onlyOverdue: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/deadlines?page=1&status=active&orderId=42&onlyOverdue=true',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('uses versioned order deadline summary endpoint', async () => {
    const fetchMock = mockFetch({
      orderId: 42,
      finalDeadline: null,
      currentStageDeadline: null,
      counts: { active: 0, expired: 0, completedLate: 0, completedOnTime: 0 },
    });

    await deadlinesApi.getSummaryForOrder(42);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/42/deadline-summary');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
  });

  it('creates and controls deadlines through versioned endpoints', async () => {
    const deadline = createDeadline();
    const fetchMock = mockFetch(
      { deadline },
      { deadline: { ...deadline, status: 'paused' } },
      { deadline: { ...deadline, status: 'active' } },
      { deadline: { ...deadline, status: 'cancelled' } },
    );

    await deadlinesApi.create({
      entityType: 'order',
      entityId: '42',
      deadlineAt: '2026-05-02T10:00:00.000Z',
    });
    await deadlinesApi.pause(deadlineId, {
      pauseMode: 'pause_and_shift_deadline',
      pauseReason: 'Ожидание клиента',
    });
    await deadlinesApi.resume(deadlineId);
    await deadlinesApi.cancel(deadlineId, { reason: 'Заказ отменен' });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/deadlines');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/v1/deadlines/${deadlineId}/pause`);
    expect(fetchMock.mock.calls[2][0]).toBe(`/api/v1/deadlines/${deadlineId}/resume`);
    expect(fetchMock.mock.calls[3][0]).toBe(`/api/v1/deadlines/${deadlineId}/cancel`);
  });

  it('rejects invalid deadline ids before fetch', async () => {
    const fetchMock = mockFetch({ deadline: createDeadline() });

    expect(() => validateDeadlineId('not-uuid')).toThrow('Invalid deadlineId');
    expect(() => deadlinesApi.getById('not-uuid')).toThrow('Invalid deadlineId');
    expect(fetchMock).not.toHaveBeenCalled();
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

function createDeadline(overrides: Partial<DeadlineDto> = {}): DeadlineDto {
  return {
    deadlineId,
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    deadlineAt: '2026-05-02T10:00:00.000Z',
    status: 'active',
    source: 'manual',
    isManuallyOverridden: false,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}
