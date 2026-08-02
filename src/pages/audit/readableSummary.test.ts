import { describe, expect, it } from 'vitest';
import type { AuditLogEventDto } from '../../api/types/auditApi.types';
import { buildAuditReadableSummary } from './readableSummary';

function event(overrides: Partial<AuditLogEventDto> = {}): AuditLogEventDto {
  return {
    auditId: 'a1',
    event: 'orders.update',
    entityType: 'order',
    entityId: '42',
    entityName: '2728',
    entityDetailNumber: null,
    userId: 7,
    username: 'manager',
    role: 'top_manager',
    source: 'backend-production-actions',
    relatedOrderId: 42,
    relatedOrderName: '2728',
    relatedClientId: 12,
    relatedClientName: 'Тест клиент',
    relatedPaymentId: null,
    relatedDeadlineId: null,
    relatedProductionEventId: null,
    relatedUserId: null,
    relatedEntities: [],
    statusField: null,
    statusId: null,
    statusName: null,
    statusCode: null,
    stageCode: null,
    requestId: 'req-1',
    ip: '10.0.0.1',
    userAgent: 'Mozilla/5.0',
    before: null,
    after: null,
    diff: null,
    metadata: null,
    createdAt: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

describe('buildAuditReadableSummary', () => {
  it('describes order status changes without using target metadata as the previous value', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'orders.status_change',
        statusField: 'orderStatus',
        statusId: 2,
        statusName: 'Готов к выдаче',
        before: { orderStatusId: 1, version: 5 },
        after: {
          orderStatusId: 2,
          orderStatusName: 'Готов к выдаче',
          version: 6,
        },
        diff: { orderStatusId: { before: 1, after: 2 } },
        metadata: {
          orderId: 42,
          orderStatusId: 2,
          orderStatusName: 'Готов к выдаче',
          previousOrderStatusId: 1,
          requestId: 'req-1',
        },
      })
    );

    expect(summary.title).toBe('Изменён статус заказа');
    expect(summary.actor).toBe('manager (top_manager)');
    expect(summary.object).toBe('Заказ 2728 (#42)');
    expect(summary.changes).toContainEqual({
      label: 'Статус заказа',
      before: '#1',
      after: 'Готов к выдаче',
    });
  });

  it('describes batch detail production status changes with selected and changed counts', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'orders.detail_production_status_batch_change',
        statusField: 'productionDetailBatch',
        statusId: 4,
        statusName: 'Раскрой',
        statusCode: 'CUT',
        diff: {
          detailIds: [101, 102, 103],
          changedDetailIds: [101, 103],
          selectedDetailCount: 3,
          affectedDetailCount: 2,
          productionStatusId: 4,
          orderVersion: { before: 10, after: 11 },
        },
        metadata: {
          orderId: 42,
          productionStatusId: 4,
          productionStatusName: 'Раскрой',
          productionStatusCode: 'CUT',
        },
        relatedEntities: [
          { entityType: 'order_detail', entityId: 101, detailNumber: 1 },
          { entityType: 'order_detail', entityId: 102, detailNumber: 2 },
          { entityType: 'order_detail', entityId: 103, detailNumber: 3 },
        ],
      })
    );

    expect(summary.title).toBe('Изменён производственный статус деталей заказа');
    expect(summary.changes).toContainEqual({
      label: 'Статус выбранных деталей',
      before: 'разные статусы',
      after: 'Раскрой (CUT)',
    });
    expect(summary.notes).toEqual(
      expect.arrayContaining([
        'Выбрано деталей: 3',
        'Изменено деталей: 2',
        'Детали: Деталь №1 (#101), Деталь №2 (#102), Деталь №3 (#103)',
      ])
    );
  });

  it('uses system actor metadata when no user account is attached', () => {
    const summary = buildAuditReadableSummary(
      event({
        userId: null,
        username: null,
        role: null,
        source: 'deadline-engine',
        event: 'orders.status_change',
        metadata: {
          orderId: 42,
          systemActor: { actorLabel: 'Deadline rule #9' },
        },
        diff: { orderStatusId: { before: 2, after: 3 } },
        after: { orderStatusName: 'Просрочен' },
      })
    );

    expect(summary.actor).toBe('Deadline rule #9');
    expect(summary.notes).toContain('Источник: системное правило');
  });

  it('keeps readable field changes and hides technical fields', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'orders.update',
        diff: {
          plannedCompletionDate: {
            before: '2026-08-01T09:00:00.000Z',
            after: '2026-08-05T09:00:00.000Z',
          },
          version: { before: 1, after: 2 },
          requestId: { before: 'old', after: 'new' },
        },
      })
    );

    expect(summary.title).toBe('Обновлён заказ');
    expect(summary.changes.map((change) => change.label)).toContain('Плановая дата завершения');
    expect(summary.changes.map((change) => change.label)).not.toContain('Version');
    expect(summary.changes.map((change) => change.label)).not.toContain('Request id');
  });

  it('describes order detail transfers with detail list and source/target orders', () => {
    const summary = buildAuditReadableSummary(
      event({
        event: 'orders.detail_transfer',
        entityType: 'order',
        entityId: '11471',
        relatedOrderId: 11472,
        username: 'ivan',
        role: 'manager',
        metadata: {
          sourceOrderId: 11471,
          sourceOrderName: '2728',
          targetOrderId: 11472,
          targetOrderName: '2729',
          movedDetails: [
            {
              detailId: 1001,
              sourceDetailNumber: 3,
              targetDetailNumber: 7,
              height: 716,
              width: 396,
              quantity: 2,
            },
          ],
        },
      })
    );

    expect(summary.title).toBe('Перенесены детали заказа');
    expect(summary.actor).toBe('ivan (manager)');
    expect(summary.object).toBe('Заказ 2728 (#11471) → Заказ 2729 (#11472)');
    expect(summary.changes).toContainEqual({
      label: 'Детали',
      before: 'Заказ 2728 (#11471)',
      after: 'Заказ 2729 (#11472)',
    });
    expect(summary.notes).toEqual(
      expect.arrayContaining([
        'Какие детали: Деталь №3→№7 (#1001) (716x396 x2)',
        'Из заказа: Заказ 2728 (#11471)',
        'В заказ: Заказ 2729 (#11472)',
      ])
    );
  });
});
