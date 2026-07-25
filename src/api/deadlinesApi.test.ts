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

  it('reads order deadlines and events through versioned order endpoints', async () => {
    const fetchMock = mockFetch(
      { data: [createDeadline()] },
      {
        data: [
          {
            deadlineEventId: 'event-1',
            deadlineId,
            eventType: 'DEADLINE_CREATED',
            severity: 'info',
            eventAt: '2026-05-01T10:00:00.000Z',
            deadlineAt: '2026-05-02T10:00:00.000Z',
            delayMinutes: null,
            payload: null,
          },
        ],
      },
    );

    await deadlinesApi.listForOrder(42);
    await deadlinesApi.listEventsForOrder(42);

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/42/deadlines');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/42/deadline-events');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('GET');
  });

  it('reads effective order rules and dry-run preview through Slice 2 endpoints', async () => {
    const fetchMock = mockFetch(
      { orderId: 42, policies: [], actionRules: [], overrides: [] },
      {
        orderId: 42,
        eventType: 'DEADLINE_EXPIRED',
        deadlineId,
        deadlineEventId: null,
        candidateActionRules: [],
        selectedActionRuleId: null,
        selectionReason: 'no_candidate_rules',
      },
    );

    await deadlinesApi.getOrderEffectiveRules(42);
    await deadlinesApi.previewOrderActionRules(42, {
      eventType: 'DEADLINE_EXPIRED',
      deadlineId,
      fixtureKey: 'deadline-canary',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/42/deadline-effective-rules');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/42/deadline-action-preview');
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ eventType: 'DEADLINE_EXPIRED', deadlineId, fixtureKey: 'deadline-canary' }),
      }),
    );
  });

  it('writes and retires order overrides with required audit reason payloads', async () => {
    const override = createOrderOverride();
    const fetchMock = mockFetch({ override }, { override: { ...override, retiredAt: '2026-05-04T10:00:00.000Z' } });

    await deadlinesApi.upsertOrderOverride(42, {
      targetType: 'action_rule',
      actionRuleId: deadlineId,
      isDisabled: true,
      reason: 'Disable status automation for this order',
    });
    await deadlinesApi.retireOrderOverride(42, deadlineId, {
      reason: 'Restore automation',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/orders/42/deadline-overrides',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          targetType: 'action_rule',
          actionRuleId: deadlineId,
          isDisabled: true,
          reason: 'Disable status automation for this order',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/orders/42/deadline-overrides/${deadlineId}`,
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ reason: 'Restore automation' }),
      }),
    );
  });

  it('lists and patches global transition rules through Slice 2 endpoints', async () => {
    const rule = createActionRule();
    const fetchMock = mockFetch({ data: [rule] }, { rule: { ...rule, isEnabled: false } });

    await deadlinesApi.listDeadlineTransitionRules();
    await deadlinesApi.updateDeadlineTransitionRule(deadlineId, {
      expectedUpdatedAt: '2026-05-01T10:00:00.000Z',
      priority: 25,
      targetOrderStatusId: 7,
      allowedFromOrderStatusIds: [1, 2],
      excludeOrderStatusIds: [9],
      excludeCompletedOrders: true,
      reason: 'Narrow expired transition rule',
      comment: 'Ops request',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/deadline-transition-rules');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('GET');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/deadline-transition-rules/${deadlineId}`,
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          expectedUpdatedAt: '2026-05-01T10:00:00.000Z',
          priority: 25,
          targetOrderStatusId: 7,
          allowedFromOrderStatusIds: [1, 2],
          excludeOrderStatusIds: [9],
          excludeCompletedOrders: true,
          reason: 'Narrow expired transition rule',
          comment: 'Ops request',
        }),
      }),
    );
  });

  it('creates and deletes deadline transition rules with audited payloads', async () => {
    const rule = createActionRule();
    const fetchMock = mockFetch({ rule }, { rule });

    await deadlinesApi.createDeadlineTransitionRule({
      ruleName: 'Просрочена выдача',
      policyId: null,
      targetOrderStatusId: 7,
      allowedFromOrderStatusIds: [1, 2],
      reason: 'Approved rule',
    });
    await deadlinesApi.deleteDeadlineTransitionRule(deadlineId, {
      expectedUpdatedAt: '2026-05-01T10:00:00.000Z',
      reason: 'Unused rule',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/deadline-transition-rules',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ruleName: 'Просрочена выдача',
          policyId: null,
          targetOrderStatusId: 7,
          allowedFromOrderStatusIds: [1, 2],
          reason: 'Approved rule',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/v1/deadline-transition-rules/${deadlineId}`,
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({
          expectedUpdatedAt: '2026-05-01T10:00:00.000Z',
          reason: 'Unused rule',
        }),
      }),
    );
  });

  it('reads and replaces the default production schedule', async () => {
    const schedule = {
      configured: false,
      hasStoredConfiguration: false,
      version: 1,
      reserveDays: 0,
      transitionsOrder: {},
      totalProductionDays: null,
      plannedOrderDays: null,
      updatedAt: null,
      stages: [],
    };
    const fetchMock = mockFetch({ schedule }, { schedule: { ...schedule, version: 2 } });

    await deadlinesApi.getDefaultSchedule();
    await deadlinesApi.replaceDefaultSchedule({
      expectedVersion: 1,
      reserveDays: 2,
      reason: 'Новый производственный цикл',
      stages: [
        {
          productionStatusId: 10,
          durationDays: 3,
          parallelWithPrevious: false,
        },
      ],
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/v1/deadline-default-schedule',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/v1/deadline-default-schedule',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          expectedVersion: 1,
          reserveDays: 2,
          reason: 'Новый производственный цикл',
          stages: [
            {
              productionStatusId: 10,
              durationDays: 3,
              parallelWithPrevious: false,
            },
          ],
        }),
      }),
    );
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

  it('posts deadline override command to the backend-owned override route', async () => {
    const fetchMock = mockFetch({ deadline: createDeadline({ isManuallyOverridden: true }) });

    await deadlinesApi.override('11111111-1111-4111-8111-111111111111', {
      deadlineAt: '2026-05-03T10:00:00.000Z',
      reason: 'Manual correction',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/deadlines/11111111-1111-4111-8111-111111111111/override',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          deadlineAt: '2026-05-03T10:00:00.000Z',
          reason: 'Manual correction',
        }),
      }),
    );
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

function createActionRule() {
  return {
    actionRuleId: deadlineId,
    policyId: null,
    scopeType: 'order',
    eventType: 'DEADLINE_EXPIRED',
    actionType: 'change_order_status',
    isEnabled: true,
    priority: 10,
    config: {
      scope: { type: 'global_orders' },
      conditions: {
        allowedFromOrderStatusIds: [1],
        excludeOrderStatusIds: [9],
        excludeCompletedOrders: true,
        requireCurrentDeadlineEvent: true,
      },
      actionConfig: { targetOrderStatusId: 7 },
    },
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
  };
}

function createOrderOverride() {
  return {
    overrideId: deadlineId,
    orderId: 42,
    targetType: 'action_rule',
    policyId: null,
    actionRuleId: deadlineId,
    isDisabled: true,
    overrideConfig: {},
    reason: 'Disable status automation for this order',
    createdByUserId: 1,
    updatedByUserId: 1,
    retiredByUserId: null,
    retiredAt: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
  };
}
