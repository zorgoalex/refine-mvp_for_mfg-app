import { describe, expect, it } from 'vitest';
import type {
  DeadlineDto,
  DeadlineEventDto,
  OrderDeadlineSummary,
} from '../../../api/types/deadlineApi.types';
import {
  buildDeadlineEventRows,
  buildDeadlineRows,
  formatDeadlineDate,
  formatDeadlineDuration,
  getDeadlineSeverityColor,
  getDeadlineStatusLabel,
  summarizeDeadlineCounts,
} from './orderDeadlineView';

describe('orderDeadlineView', () => {
  it('formats summary counts and status labels for the order panel', () => {
    const summary: OrderDeadlineSummary = {
      orderId: 42,
      finalDeadline: {
        deadlineId: 'final',
        deadlineAt: '2026-05-20T12:00:00.000Z',
        status: 'active',
        remainingMinutes: 180,
        delayMinutes: null,
        severity: 'warning',
      },
      currentStageDeadline: null,
      counts: {
        active: 2,
        expired: 1,
        completedLate: 3,
        completedOnTime: 4,
      },
    };

    expect(summarizeDeadlineCounts(summary)).toBe(
      'Активные: 2 · Просрочены: 1 · Поздно завершены: 3 · В срок: 4',
    );
    expect(getDeadlineStatusLabel('active')).toBe('Активен');
    expect(getDeadlineStatusLabel('completed_late')).toBe('Завершен поздно');
  });

  it('builds deadline rows with human-readable dates and durations', () => {
    const rows = buildDeadlineRows([
      createDeadline({
        deadlineId: '11111111-1111-4111-8111-111111111111',
        entityType: 'order',
        entityId: '42',
        deadlineAt: '2026-05-20T12:00:00.000Z',
        status: 'expired',
      }),
    ]);

    expect(rows).toEqual([
      {
        key: '11111111-1111-4111-8111-111111111111',
        entity: 'Заказ',
        deadlineAt: '20.05.2026, 12:00',
        status: 'Просрочен',
        statusCode: 'expired',
        source: 'manual',
        severityColor: 'red',
        updatedAt: '01.05.2026, 10:00',
      },
    ]);
  });

  it('builds event rows and duration text', () => {
    const rows = buildDeadlineEventRows([
      {
        deadlineEventId: 'event-1',
        deadlineId: 'deadline-1',
        eventType: 'DEADLINE_EXPIRED',
        severity: 'critical',
        eventAt: '2026-05-21T12:00:00.000Z',
        deadlineAt: '2026-05-20T12:00:00.000Z',
        delayMinutes: 1440,
        payload: null,
      },
    ]);

    expect(rows[0]).toEqual({
      key: 'event-1',
      eventType: 'DEADLINE_EXPIRED',
      severity: 'critical',
      severityColor: 'red',
      eventAt: '21.05.2026, 12:00',
      delay: '24 ч',
    });
    expect(formatDeadlineDuration(90)).toBe('1 ч 30 мин');
    expect(formatDeadlineDuration(null)).toBe('—');
    expect(getDeadlineSeverityColor('info')).toBe('blue');
  });

  it('formats dates with UTC clock output and handles empty values', () => {
    expect(formatDeadlineDate('2026-05-20T12:00:00.000Z')).toBe(
      '20.05.2026, 12:00',
    );
    expect(formatDeadlineDate(null)).toBe('—');
    expect(formatDeadlineDate('not-a-date')).toBe('—');
  });

  it('uses neutral severity color for unknown runtime statuses', () => {
    const [row] = buildDeadlineRows([
      createDeadline({
        status: 'archived' as DeadlineDto['status'],
      }),
    ]);

    expect(row.status).toBe('archived');
    expect(row.severityColor).toBe('blue');
  });
});

function createDeadline(overrides: Partial<DeadlineDto>): DeadlineDto {
  return {
    deadlineId: '11111111-1111-4111-8111-111111111111',
    entityType: 'order',
    entityId: '42',
    orderId: 42,
    orderWorkshopId: null,
    clientId: null,
    responsibleUserId: null,
    deadlineAt: '2026-05-20T12:00:00.000Z',
    status: 'active',
    source: 'manual',
    isManuallyOverridden: false,
    metadata: null,
    createdAt: '2026-05-01T10:00:00.000Z',
    updatedAt: '2026-05-01T10:00:00.000Z',
    ...overrides,
  };
}
